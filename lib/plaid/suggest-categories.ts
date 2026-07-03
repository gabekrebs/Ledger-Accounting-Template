import Anthropic from "@anthropic-ai/sdk";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import {
  listPendingTransactions,
  listPostableAccounts,
} from "@/lib/plaid/data";
import {
  buildMerchantHistory,
  buildPortfolioMerchantHistory,
  historyVerdict,
  portfolioVerdict,
  type MerchantHistory,
  type TargetAccount,
} from "@/lib/plaid/auto-categorize";

/**
 * Phase 2 — category SUGGESTIONS for the transactions Phase 1 couldn't auto-post.
 *
 * Cost discipline, in order:
 *   1. FREE history pre-pass — any merchant with a strong (≥80%, ≥2-sample) but
 *      not-quite-auto-postable precedent is resolved here with NO model call.
 *   2. Haiku 4.5 — only the genuinely-unknown leftovers go to the model, one
 *      call per entity, structured output, chart-of-accounts cached as a stable
 *      prefix. Haiku because once history narrows the field this is easy work;
 *      reserve Opus for the account-matcher's harder multi-signal problem.
 *
 * Nothing here writes — these only PRE-FILL the review dropdowns; a human still
 * clicks Post. Every returned account_id is validated against the entity's real
 * active chart, so a hallucinated id is dropped rather than shown.
 *
 * The prompt-building is factored into `prepareCategorization` so the Phase 3
 * threshold batch can submit the identical request shape to the Batch API.
 */

const MODEL = "claude-haiku-4-5";

// History counts as a confident SUGGESTION (not an auto-post) at a softer bar
// than the auto-post gate — it only pre-fills a box a human confirms.
const HISTORY_SUGGEST_MIN_AGREEMENT = 0.8;
const HISTORY_SUGGEST_MIN_SAMPLES = 2;

export interface CategorySuggestion {
  txnId: string;
  accountId: string;
  accountLabel: string;
  confidence: number; // 0..1
  reasoning: string;
  source: "history" | "ai";
}
export interface SuggestCategoriesResult {
  suggestions: CategorySuggestion[];
  error: string | null;
}

type PendingTxn = Awaited<ReturnType<typeof listPendingTransactions>>[number];
type PostableAccount = Awaited<ReturnType<typeof listPostableAccounts>>[number];

const acctLabel = (a: PostableAccount) =>
  a.fullyQualifiedName ?? a.name ?? "";
const usd = (cents: number) =>
  (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });

// Structured-output schema: object, all props required, additionalProperties
// false, nullable via type arrays, no min/max/length (per the structured-output
// constraints in the claude-api skill).
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    suggestions: {
      type: "array",
      description:
        "One entry per transaction you can confidently categorize. Omit a " +
        "transaction (or set account_id to null) when no category is a clear " +
        "fit — a missing suggestion is better than a wrong one.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          txn_id: { type: "string" },
          account_id: {
            type: ["string", "null"],
            description: "A category account_id copied VERBATIM from the chart.",
          },
          confidence: { type: "number" },
          reasoning: {
            type: "string",
            description: "One short human-readable sentence.",
          },
        },
        required: ["txn_id", "account_id", "confidence", "reasoning"],
      },
    },
  },
  required: ["suggestions"],
} as const;

const SYSTEM_INSTRUCTIONS =
  "You are a bookkeeper categorizing bank transactions into a business's chart " +
  "of accounts. For each transaction you are given the merchant, the bank's own " +
  "category guess, the amount, and whether it is money OUT (an expense/payment) " +
  "or money IN (income/refund/deposit). When a transaction includes a " +
  "'previously booked' hint, that precedent is the STRONGEST signal — follow it " +
  "unless the amount or direction makes it impossible. Pick account_id ONLY from " +
  "the provided chart and copy it VERBATIM; never invent an id. Choose an " +
  "expense account for money-out and an income account for money-in. Set " +
  "account_id to null when you genuinely cannot tell — a missing suggestion is " +
  "better than a wrong one. Calibrate confidence honestly: ~0.9+ when a " +
  "precedent or the merchant makes it obvious, lower when you are guessing from " +
  "the merchant name alone.";

/** The chart the model picks from — stable bytes, good for the prompt cache. */
function chartBlock(accounts: PostableAccount[]): string {
  const lines = accounts
    .filter((a) => a.classification === "Expense" || a.classification === "Revenue" || a.classification === "Income" || a.accountType)
    .map(
      (a) =>
        `  - ${acctLabel(a)}  [${a.classification ?? a.accountType ?? "?"}] ` +
        `[account_id: ${a.id}]`
    );
  return (
    "CHART OF ACCOUNTS — categories you may pick (copy account_id verbatim):\n\n" +
    lines.join("\n")
  );
}

/** The volatile per-transaction block, including any softer history hint. */
function txnBlock(txns: PendingTxn[], history: MerchantHistory, accountLabelById: Map<string, string>): string {
  const blocks = txns.map((t) => {
    const merchant = t.merchantName ?? t.name ?? "(unknown)";
    const out = t.amountCents > 0;
    const plaidCat =
      (t.plaidCategory as { primary?: string } | null)?.primary ?? null;
    const lines = [
      `[txn_id: ${t.id}]`,
      `  Merchant: ${merchant}`,
      `  Bank category guess: ${plaidCat ?? "(none)"}`,
      `  Amount: ${usd(Math.abs(t.amountCents))} (${out ? "money OUT" : "money IN"})`,
      `  Date: ${String(t.txnDate).slice(0, 10)}`,
    ];
    const v = historyVerdict(history, t.merchantName, t.name);
    if (v) {
      lines.push(
        `  Previously booked: ${accountLabelById.get(v.accountId) ?? v.accountId} ` +
          `(${Math.round(v.agreement * 100)}% of ${v.samples} prior) ` +
          `[account_id: ${v.accountId}]`
      );
    }
    return lines.join("\n");
  });
  return "TRANSACTIONS TO CATEGORIZE:\n\n" + blocks.join("\n\n");
}

let client: Anthropic | null = null;
function getClient(): Anthropic | null {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!client) client = new Anthropic();
  return client;
}

/**
 * Build everything needed to categorize one entity: the free history-resolved
 * suggestions, plus the exact model-request pieces for the AI leftovers. Shared
 * by the interactive path (below) and the Phase 3 batch submitter.
 */
export async function prepareCategorization(entityId: string) {
  const [pending, postable] = await Promise.all([
    listPendingTransactions(entityId),
    listPostableAccounts(entityId),
  ]);
  const history = await buildMerchantHistory(entityId);

  const accountLabelById = new Map(postable.map((a) => [a.id, acctLabel(a)]));
  const validIds = new Set(postable.map((a) => a.id));

  // Cross-ledger fallback for merchants this entity has never seen — built
  // lazily, only when some pending row actually lacks local precedent. The
  // suggest path uses the same softer bar as local history; it still only
  // pre-fills a dropdown a human confirms.
  let portfolio: Awaited<ReturnType<typeof buildPortfolioMerchantHistory>> | null =
    null;
  const targets: TargetAccount[] = postable.map((a) => ({
    id: a.id,
    name: a.name,
    classification: a.classification,
    active: true, // listPostableAccounts already filters to active
  }));

  const historySuggestions: CategorySuggestion[] = [];
  const aiTxns: PendingTxn[] = [];
  for (const t of pending) {
    let v = historyVerdict(history, t.merchantName, t.name);
    let where = "here";
    if (
      !v ||
      v.agreement < HISTORY_SUGGEST_MIN_AGREEMENT ||
      v.samples < HISTORY_SUGGEST_MIN_SAMPLES
    ) {
      portfolio ??= await buildPortfolioMerchantHistory();
      const pv = portfolioVerdict(portfolio, targets, t.merchantName, t.name);
      // Local precedent (even thin) that points elsewhere vetoes the portfolio.
      if (pv && (!v || v.accountId === pv.accountId)) {
        v = pv;
        where = "across your other ledgers";
      }
    }
    if (
      v &&
      v.agreement >= HISTORY_SUGGEST_MIN_AGREEMENT &&
      v.samples >= HISTORY_SUGGEST_MIN_SAMPLES &&
      validIds.has(v.accountId)
    ) {
      historySuggestions.push({
        txnId: t.id,
        accountId: v.accountId,
        accountLabel: accountLabelById.get(v.accountId) ?? "",
        confidence: v.agreement,
        reasoning: `Booked ${where} ${Math.round(v.agreement * 100)}% of ${v.samples} prior times`,
        source: "history",
      });
    } else {
      aiTxns.push(t);
    }
  }

  const requestParams =
    aiTxns.length === 0
      ? null
      : ({
          model: MODEL,
          max_tokens: 8192,
          system: [
            { type: "text", text: SYSTEM_INSTRUCTIONS },
            {
              type: "text",
              text: chartBlock(postable),
              cache_control: { type: "ephemeral", ttl: "1h" },
            },
          ],
          messages: [
            {
              role: "user",
              content:
                txnBlock(aiTxns, history, accountLabelById) +
                "\n\nCategorize each transaction.",
            },
          ],
          output_config: {
            format: { type: "json_schema", schema: SCHEMA },
          },
        } as Anthropic.MessageCreateParamsNonStreaming);

  return {
    historySuggestions,
    aiTxns,
    requestParams,
    accountLabelById,
    validIds,
  };
}

interface RawSuggestion {
  txn_id?: unknown;
  account_id?: unknown;
  confidence?: unknown;
  reasoning?: unknown;
}

/** Validate model output against the real chart + the asked txns. */
export function validateAiSuggestions(
  raw: RawSuggestion[],
  askedTxnIds: Set<string>,
  validIds: Set<string>,
  accountLabelById: Map<string, string>
): CategorySuggestion[] {
  const seen = new Set<string>();
  const out: CategorySuggestion[] = [];
  for (const r of raw) {
    const txnId = typeof r.txn_id === "string" ? r.txn_id : "";
    const accountId = typeof r.account_id === "string" ? r.account_id : "";
    if (!txnId || !accountId) continue;
    if (!askedTxnIds.has(txnId) || seen.has(txnId)) continue;
    if (!validIds.has(accountId)) continue;
    seen.add(txnId);
    out.push({
      txnId,
      accountId,
      accountLabel: accountLabelById.get(accountId) ?? "",
      confidence:
        typeof r.confidence === "number"
          ? Math.min(1, Math.max(0, r.confidence))
          : 0,
      reasoning: typeof r.reasoning === "string" ? r.reasoning.slice(0, 300) : "",
      source: "ai",
    });
  }
  return out;
}

/**
 * Interactive entry point: history pre-pass + one synchronous Haiku call for the
 * leftovers. Returns combined, validated, highest-confidence-first suggestions.
 */
export async function suggestCategories(
  entityId: string
): Promise<SuggestCategoriesResult> {
  const a = getClient();
  if (!a) {
    return {
      suggestions: [],
      error: "AI suggestions unavailable (ANTHROPIC_API_KEY is not set).",
    };
  }

  const prep = await prepareCategorization(entityId);
  const suggestions = [...prep.historySuggestions];

  if (prep.requestParams) {
    try {
      const msg = await a.messages.create(prep.requestParams);
      const textBlock = msg.content.find((b) => b.type === "text");
      if (textBlock && textBlock.type === "text") {
        const parsed = JSON.parse(textBlock.text) as {
          suggestions?: RawSuggestion[];
        };
        suggestions.push(
          ...validateAiSuggestions(
            parsed.suggestions ?? [],
            new Set(prep.aiTxns.map((t) => t.id)),
            prep.validIds,
            prep.accountLabelById
          )
        );
      }
      const u = msg.usage;
      console.log(
        `suggest-categories ${entityId}: history=${prep.historySuggestions.length} ` +
          `ai_asked=${prep.aiTxns.length} ai_returned=${suggestions.length - prep.historySuggestions.length} ` +
          `cache_read=${u.cache_read_input_tokens ?? 0} in=${u.input_tokens} out=${u.output_tokens}`
      );
    } catch (e) {
      console.error("suggest-categories: model call threw:", e);
      // Degrade to history-only rather than failing the whole screen.
      return {
        suggestions,
        error: "AI suggestions failed — history-only; categorize the rest manually.",
      };
    }
  }

  // Persist so the suggestions survive navigation and the review page can
  // pre-fill on load (the same store the batch path writes to).
  await persistSuggestions(suggestions);

  suggestions.sort((x, y) => y.confidence - x.confidence);
  return { suggestions, error: null };
}

/**
 * Write suggestions onto their transactions — ONLY rows still `pending_review`
 * (a posted/ignored txn must never gain a stale suggestion). Idempotent: re-
 * running overwrites with the latest. Returns the number of rows written.
 */
export async function persistSuggestions(
  suggestions: CategorySuggestion[]
): Promise<number> {
  let written = 0;
  for (const s of suggestions) {
    const res = await db
      .update(schema.bkPlaidTransactions)
      .set({
        suggestedAccountId: s.accountId,
        suggestedConfidence: s.confidence,
        suggestedReasoning: s.reasoning,
        suggestionSource: s.source,
        suggestedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.bkPlaidTransactions.id, s.txnId),
          eq(schema.bkPlaidTransactions.status, "pending_review")
        )
      )
      .returning({ id: schema.bkPlaidTransactions.id });
    written += res.length;
  }
  return written;
}

export interface PersistedSuggestion {
  txnId: string;
  accountId: string;
  confidence: number;
  reasoning: string;
  source: "history" | "ai";
}

/**
 * Read the persisted suggestions for an entity's still-pending transactions, so
 * the review page can pre-fill dropdowns on load without a fresh model call.
 */
export async function readPersistedSuggestions(
  entityId: string
): Promise<Map<string, PersistedSuggestion>> {
  const rows = await db
    .select({
      txnId: schema.bkPlaidTransactions.id,
      accountId: schema.bkPlaidTransactions.suggestedAccountId,
      confidence: schema.bkPlaidTransactions.suggestedConfidence,
      reasoning: schema.bkPlaidTransactions.suggestedReasoning,
      source: schema.bkPlaidTransactions.suggestionSource,
    })
    .from(schema.bkPlaidTransactions)
    .where(
      and(
        eq(schema.bkPlaidTransactions.entityId, entityId),
        eq(schema.bkPlaidTransactions.status, "pending_review")
      )
    );
  const out = new Map<string, PersistedSuggestion>();
  for (const r of rows) {
    if (!r.accountId) continue;
    out.set(r.txnId, {
      txnId: r.txnId,
      accountId: r.accountId,
      confidence: r.confidence ?? 0,
      reasoning: r.reasoning ?? "",
      source: r.source === "ai" ? "ai" : "history",
    });
  }
  return out;
}
