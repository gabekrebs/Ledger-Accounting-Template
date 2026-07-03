import Anthropic from "@anthropic-ai/sdk";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { listPendingTransactions, listPostableAccounts } from "@/lib/plaid/data";
import { entitiesWithPending } from "@/lib/plaid/auto-post";
import {
  prepareCategorization,
  validateAiSuggestions,
  persistSuggestions,
  type CategorySuggestion,
} from "@/lib/plaid/suggest-categories";

/**
 * Phase 3b — portfolio category suggestions via the Anthropic Batch API (50%
 * off, async). The threshold cron submits ONE job covering every entity's
 * leftover transactions (one batch request per entity, custom_id = entity_id),
 * records it in `bk_category_batches`, and a later cron run polls + ingests the
 * results into the persisted `suggested_*` columns. Two-phase because the Batch
 * API is asynchronous — results land minutes-to-hours later, across cron runs.
 *
 * The free history pre-pass still runs at SUBMIT time and is persisted
 * immediately (no token cost); only the genuine unknowns go into the batch.
 */

let client: Anthropic | null = null;
function getClient(): Anthropic | null {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!client) client = new Anthropic();
  return client;
}

const { bkCategoryBatches } = schema;

export interface SubmitResult {
  submitted: boolean;
  reason?: string;
  anthropicBatchId?: string;
  requestCount?: number;
  historyPersisted?: number;
}

/**
 * Submit one batch covering all entities' AI-needed leftovers. Persists the
 * free history suggestions inline. Skips if a batch is already open (so we never
 * stack jobs) or if there's nothing for the model to do.
 */
export async function submitCategoryBatch(): Promise<SubmitResult> {
  const a = getClient();
  if (!a) return { submitted: false, reason: "ANTHROPIC_API_KEY not set" };

  // Never stack jobs — one open batch at a time.
  const open = await db
    .select({ id: bkCategoryBatches.id })
    .from(bkCategoryBatches)
    .where(eq(bkCategoryBatches.status, "submitted"))
    .limit(1);
  if (open.length) return { submitted: false, reason: "a batch is already open" };

  const entityIds = await entitiesWithPending();
  const requests: Anthropic.Messages.Batches.BatchCreateParams.Request[] = [];
  let historyPersisted = 0;

  for (const entityId of entityIds) {
    const prep = await prepareCategorization(entityId);
    // Free history suggestions: persist now, no batch needed.
    if (prep.historySuggestions.length) {
      historyPersisted += await persistSuggestions(prep.historySuggestions);
    }
    if (prep.requestParams) {
      requests.push({
        custom_id: entityId,
        params: prep.requestParams as Anthropic.Messages.Batches.BatchCreateParams.Request["params"],
      });
    }
  }

  if (!requests.length) {
    return { submitted: false, reason: "no AI leftovers", historyPersisted };
  }

  const batch = await a.messages.batches.create({ requests });
  await db.insert(bkCategoryBatches).values({
    anthropicBatchId: batch.id,
    status: "submitted",
    requestCount: requests.length,
  });

  console.log(
    `categorize-batch: submitted ${batch.id} requests=${requests.length} ` +
      `historyPersisted=${historyPersisted}`
  );
  return {
    submitted: true,
    anthropicBatchId: batch.id,
    requestCount: requests.length,
    historyPersisted,
  };
}

export interface IngestResult {
  checked: number;
  ingested: number;
  suggestionsWritten: number;
}

interface RawSuggestion {
  txn_id?: unknown;
  account_id?: unknown;
  confidence?: unknown;
  reasoning?: unknown;
}

/**
 * Poll every open batch; ingest the ones that have finished. For each entity's
 * result we re-fetch the current pending txns + chart so suggestions only land
 * on rows that are STILL pending and on accounts that are STILL valid (a result
 * can arrive after a row was posted/ignored or an account deactivated).
 */
export async function ingestCategoryBatches(): Promise<IngestResult> {
  const a = getClient();
  const result: IngestResult = { checked: 0, ingested: 0, suggestionsWritten: 0 };
  if (!a) return result;

  const openBatches = await db
    .select()
    .from(bkCategoryBatches)
    .where(eq(bkCategoryBatches.status, "submitted"));

  for (const row of openBatches) {
    result.checked++;
    let written = 0;
    try {
      const batch = await a.messages.batches.retrieve(row.anthropicBatchId);
      if (batch.processing_status !== "ended") continue; // still running

      for await (const entry of await a.messages.batches.results(
        row.anthropicBatchId
      )) {
        if (entry.result.type !== "succeeded") continue;
        const entityId = entry.custom_id;
        const textBlock = entry.result.message.content.find(
          (b) => b.type === "text"
        );
        if (!textBlock || textBlock.type !== "text") continue;

        let parsed: { suggestions?: RawSuggestion[] };
        try {
          parsed = JSON.parse(textBlock.text);
        } catch {
          continue;
        }

        // Validate against the entity's CURRENT pending txns + active chart.
        const [pending, postable] = await Promise.all([
          listPendingTransactions(entityId),
          listPostableAccounts(entityId),
        ]);
        const askedTxnIds = new Set(pending.map((t) => t.id));
        const validIds = new Set(postable.map((p) => p.id));
        const accountLabelById = new Map(
          postable.map((p) => [p.id, p.fullyQualifiedName ?? p.name ?? ""])
        );
        const suggestions: CategorySuggestion[] = validateAiSuggestions(
          parsed.suggestions ?? [],
          askedTxnIds,
          validIds,
          accountLabelById
        );
        written += await persistSuggestions(suggestions);
      }

      await db
        .update(bkCategoryBatches)
        .set({
          status: "ingested",
          ingestedAt: new Date(),
          suggestionsWritten: written,
        })
        .where(eq(bkCategoryBatches.id, row.id));
      result.ingested++;
      result.suggestionsWritten += written;
      console.log(
        `categorize-batch: ingested ${row.anthropicBatchId} wrote=${written}`
      );
    } catch (e) {
      console.error(
        `categorize-batch: ingest failed for ${row.anthropicBatchId}:`,
        e
      );
    }
  }
  return result;
}
