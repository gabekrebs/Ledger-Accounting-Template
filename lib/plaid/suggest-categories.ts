import Anthropic from "@anthropic-ai/sdk";
import { and, eq, inArray } from "drizzle-orm";
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
import { normalizeMerchant } from "@/lib/ledger/merchant";
import {
  buildPrecedents,
  similarFor,
  correctionsFor,
  type Precedent,
} from "@/lib/ai/similar";
import { readIntel } from "@/lib/ai/merchant-intel";
import {
  bucketKeyFor,
  recordSuggestionEvent,
  AI_AUTOPOST_MAX_CENTS,
  AI_AUTOPOST_MIN_CONFIDENCE,
  SUGGEST_MODEL,
} from "@/lib/ai/events";
import { readBucketStats, calibratedDisplay } from "@/lib/ai/calibration";
import { usdPlain } from "@/lib/ledger/format";

/**
 * Phase 2 — category SUGGESTIONS for the transactions Phase 1 couldn't auto-post
 * (ADR-021: the Opus evidence pipeline).
 *
 * Cost discipline, in order:
 *   1. FREE history pre-pass — any merchant with a strong (≥80%, ≥2-sample) but
 *      not-quite-auto-postable precedent is resolved here with NO model call.
 *   2. Opus 4.8 for the genuinely-unknown leftovers — after rules + history
 *      absorb the volume, what reaches the model is a small, HARD tail, so it
 *      gets the best judgment available: adaptive thinking, the entity's chart
 *      (cached prompt prefix), up to 8 SIMILAR PRIOR BOOKINGS retrieved from
 *      this entity's ledger, recorded owner CORRECTIONS as counter-examples,
 *      and the cached MERCHANT INTEL profile. One call per entity, structured
 *      output.
 *
 * Nothing here writes to the journal — suggestions only PRE-FILL the review UI
 * (and feed the separately-gated auto-post buckets). Every returned account_id
 * is validated against the entity's real active chart. Every suggestion is
 * recorded to the evidence ledger with its full evidence snapshot, so observed
 * precision (lib/ai/calibration.ts) — not the model's self-reported number —
 * is what the UI ultimately trusts.
 */

const MODEL = SUGGEST_MODEL;

// History counts as a confident SUGGESTION (not an auto-post) at a softer bar
// than the auto-post gate — it only pre-fills a box a human confirms.
const HISTORY_SUGGEST_MIN_AGREEMENT = 0.8;
const HISTORY_SUGGEST_MIN_SAMPLES = 2;

export interface CategorySuggestion {
  txnId: string;
  accountId: string;
  accountLabel: string;
  confidence: number; // raw 0..1 (history agreement, or model self-report)
  reasoning: string;
  source: "history" | "ai";
  /** AI-cleaned vendor name for the books; null = keep the descriptor */
  suggestedPayee: string | null;
}
export interface SuggestCategoriesResult {
  suggestions: CategorySuggestion[];
  error: string | null;
}

type PendingTxn = Awaited<ReturnType<typeof listPendingTransactions>>[number];
type PostableAccount = Awaited<ReturnType<typeof listPostableAccounts>>[number];

const acctLabel = (a: PostableAccount) => a.fullyQualifiedName ?? a.name ?? "";

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
          suggested_payee: {
            type: ["string", "null"],
            description:
              "A clean, short vendor name as it should appear in the books " +
              "(e.g. 'Home Depot', 'NW Natural'). Null when the descriptor is " +
              "already clean or you cannot tell who the vendor is.",
          },
        },
        required: [
          "txn_id",
          "account_id",
          "confidence",
          "reasoning",
          "suggested_payee",
        ],
      },
    },
  },
  required: ["suggestions"],
} as const;

const SYSTEM_INSTRUCTIONS =
  "You are the bookkeeper for a portfolio of small real-estate LLCs, " +
  "categorizing bank transactions into one entity's chart of accounts. For " +
  "each transaction you get the merchant, the bank's category guess, the " +
  "amount and direction (money OUT = expense/payment, money IN = " +
  "income/refund/deposit) — and, when available, the owner's own precedent: " +
  "SIMILAR PRIOR BOOKINGS from this entity's ledger, CORRECTIONS he made to " +
  "past suggestions, an aggregate 'previously booked' hint, and a MERCHANT " +
  "INTEL profile. Follow the owner's demonstrated pattern over your general " +
  "knowledge: prior bookings and corrections outrank the bank's guess and the " +
  "intel profile. Amount matters — a $30 hardware-store run and a $7,800 one " +
  "are usually different categories; weigh the similar bookings closest in " +
  "amount most heavily. Pick account_id ONLY from the chart, copied VERBATIM. " +
  "Choose an expense account for money-out and an income account for " +
  "money-in. Set account_id to null when you genuinely cannot tell. Also " +
  "return suggested_payee: the clean vendor name the books should carry. " +
  "Calibrate confidence honestly — ~0.9+ only when precedent or the merchant " +
  "makes it obvious; your confidence is measured against outcomes and " +
  "miscalibration gets the whole pipeline locked out of automation.";

/** The chart the model picks from — stable bytes, good for the prompt cache. */
function chartBlock(accounts: PostableAccount[]): string {
  const lines = accounts.map(
    (a) =>
      `  - ${acctLabel(a)}  [${a.classification ?? a.accountType ?? "?"}] ` +
      `[account_id: ${a.id}]`
  );
  return (
    "CHART OF ACCOUNTS — categories you may pick (copy account_id verbatim):\n\n" +
    lines.join("\n")
  );
}

/** Everything retrieved for one txn's prompt — also the evidence snapshot. */
export interface TxnEvidence {
  rawName: string;
  merchantKey: string;
  merchantSeen: boolean;
  similar: { payee: string; amountCents: number; txnDate: string; accountLabel: string }[];
  corrections: { suggestedLabel: string; postedLabel: string }[];
  intel: {
    displayName: string | null;
    businessType: string | null;
    likelyCategory: string | null;
    ownerCategory: string | null;
  } | null;
  historyHint: { accountLabel: string; agreement: number; samples: number } | null;
}

/** The volatile per-transaction block: txn facts + retrieved evidence. */
function txnBlock(
  txns: PendingTxn[],
  evidenceByTxn: Map<string, TxnEvidence>,
  history: MerchantHistory,
  accountLabelById: Map<string, string>
): string {
  const blocks = txns.map((t) => {
    const merchant = t.merchantName ?? t.name ?? "(unknown)";
    const out = t.amountCents > 0;
    const plaidCat =
      (t.plaidCategory as { primary?: string } | null)?.primary ?? null;
    const lines = [
      `[txn_id: ${t.id}]`,
      `  Merchant: ${merchant}`,
      `  Bank category guess: ${plaidCat ?? "(none)"}`,
      `  Amount: ${usdPlain(Math.abs(t.amountCents))} (${out ? "money OUT" : "money IN"})`,
      `  Date: ${String(t.txnDate).slice(0, 10)}`,
    ];
    const ev = evidenceByTxn.get(t.id);
    if (ev?.similar.length) {
      lines.push(`  Similar prior bookings (this entity):`);
      for (const s of ev.similar) {
        lines.push(
          `    - "${s.payee}" ${usdPlain(s.amountCents)} on ${s.txnDate} → ${s.accountLabel}`
        );
      }
    }
    if (ev?.corrections.length) {
      lines.push(`  Corrections the owner made on this merchant:`);
      for (const c of ev.corrections) {
        lines.push(
          `    - a past suggestion of "${c.suggestedLabel}" was corrected to "${c.postedLabel}"`
        );
      }
    }
    if (ev?.intel && (ev.intel.businessType || ev.intel.likelyCategory)) {
      lines.push(
        `  Merchant intel: ${ev.intel.displayName ?? merchant} — ` +
          `${ev.intel.businessType ?? "unknown type"}` +
          (ev.intel.likelyCategory
            ? `; typically "${ev.intel.likelyCategory}"`
            : "") +
          (ev.intel.ownerCategory
            ? ` (the owner books this to "${ev.intel.ownerCategory}")`
            : "")
      );
    }
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
 * Retrieval for a set of txns: similar bookings, corrections, and intel, plus
 * whether the merchant has been seen in this entity's books at all (the
 * seen/new axis of the calibration bucket).
 */
async function buildEvidence(
  entityId: string,
  txns: PendingTxn[],
  precedents: Precedent[]
): Promise<Map<string, TxnEvidence>> {
  const keys = txns.map((t) => normalizeMerchant(t.merchantName ?? t.name));
  const [correctionMap, intelMap] = await Promise.all([
    correctionsFor(entityId, keys),
    readIntel(keys),
  ]);
  const knownKeys = new Set(precedents.map((p) => p.merchantKey));

  const out = new Map<string, TxnEvidence>();
  txns.forEach((t, i) => {
    const merchantKey = keys[i];
    const similar = similarFor(t, precedents);
    const intel = intelMap.get(merchantKey) ?? null;
    out.set(t.id, {
      rawName: t.merchantName ?? t.name ?? "",
      merchantKey,
      merchantSeen: knownKeys.has(merchantKey) || similar.length > 0,
      similar: similar.map((s) => ({
        payee: s.payee,
        amountCents: s.amountCents,
        txnDate: s.txnDate,
        accountLabel: s.accountLabel,
      })),
      corrections: (correctionMap.get(merchantKey) ?? []).map((c) => ({
        suggestedLabel: c.suggestedLabel,
        postedLabel: c.postedLabel,
      })),
      intel: intel
        ? {
            displayName: intel.displayName,
            businessType: intel.businessType,
            likelyCategory: intel.likelyCategory,
            ownerCategory: intel.ownerCategory,
          }
        : null,
      historyHint: null, // filled by prepareCategorization when a verdict exists
    });
  });
  return out;
}

/**
 * Build everything needed to categorize one entity: the free history-resolved
 * suggestions, plus the exact model-request pieces for the AI leftovers. Shared
 * by the interactive path (below) and the Phase 3 batch submitter.
 */
export async function prepareCategorization(entityId: string) {
  const [pendingAll, postable] = await Promise.all([
    listPendingTransactions(entityId),
    listPostableAccounts(entityId),
  ]);
  // Bank-PENDING rows are outside the accounting workflow entirely — never
  // suggest (or spend AI budget) on a transaction that can still change or
  // vanish. New syncs don't store them; this guards any legacy stragglers.
  const pending = pendingAll.filter((t) => !t.pending);
  const history = await buildMerchantHistory(entityId);

  const accountLabelById = new Map(postable.map((a) => [a.id, acctLabel(a)]));
  const validIds = new Set(postable.map((a) => a.id));

  // Cross-ledger fallback for merchants this entity has never seen — built
  // lazily, only when some pending row actually lacks local precedent.
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
        suggestedPayee: null,
      });
    } else {
      aiTxns.push(t);
    }
  }

  // Retrieval for the AI leftovers only (the whole point of the Opus call).
  const precedents = aiTxns.length ? await buildPrecedents(entityId) : [];
  const evidenceByTxn = aiTxns.length
    ? await buildEvidence(entityId, aiTxns, precedents)
    : new Map<string, TxnEvidence>();

  const requestParams =
    aiTxns.length === 0
      ? null
      : ({
          model: MODEL,
          max_tokens: 16000,
          // Adaptive thinking is NOT on by default on Opus 4.8 — enable it;
          // disambiguating precedent genuinely benefits from a beat of thought.
          thinking: { type: "adaptive" },
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
                txnBlock(aiTxns, evidenceByTxn, history, accountLabelById) +
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
    evidenceByTxn,
  };
}

interface RawSuggestion {
  txn_id?: unknown;
  account_id?: unknown;
  confidence?: unknown;
  reasoning?: unknown;
  suggested_payee?: unknown;
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
    const payee =
      typeof r.suggested_payee === "string" && r.suggested_payee.trim()
        ? r.suggested_payee.trim().slice(0, 120)
        : null;
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
      suggestedPayee: payee,
    });
  }
  return out;
}

/**
 * Interactive entry point: history pre-pass + one synchronous Opus call for the
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
      await persistSuggestions(entityId, suggestions, prep.evidenceByTxn);
      return {
        suggestions,
        error: "AI suggestions failed — history-only; categorize the rest manually.",
      };
    }
  }

  // Persist so the suggestions survive navigation and the review page can
  // pre-fill on load (the same store the batch path writes to).
  await persistSuggestions(entityId, suggestions, prep.evidenceByTxn);

  suggestions.sort((x, y) => y.confidence - x.confidence);
  return { suggestions, error: null };
}

/**
 * Write suggestions onto their transactions — ONLY rows still `pending_review`
 * (a posted/ignored txn must never gain a stale suggestion) — and record each
 * one to the evidence ledger with its bucket + evidence snapshot. Idempotent:
 * re-running overwrites the txn columns, and the event recorder dedupes
 * re-shown identical suggestions.
 *
 * `evidenceByTxn` is optional: the interactive path passes the exact evidence
 * the prompt used; the batch-ingest path (results arrive hours later) rebuilds
 * a minimal snapshot from the txn row instead.
 */
export async function persistSuggestions(
  entityId: string,
  suggestions: CategorySuggestion[],
  evidenceByTxn?: Map<string, TxnEvidence>
): Promise<number> {
  if (!suggestions.length) return 0;

  // Txn facts for bucket + event fields (merchant key, amount).
  const txnRows = await db
    .select({
      id: schema.bkPlaidTransactions.id,
      merchantName: schema.bkPlaidTransactions.merchantName,
      name: schema.bkPlaidTransactions.name,
      amountCents: schema.bkPlaidTransactions.amountCents,
      plaidCategory: schema.bkPlaidTransactions.plaidCategory,
    })
    .from(schema.bkPlaidTransactions)
    .where(
      inArray(
        schema.bkPlaidTransactions.id,
        suggestions.map((s) => s.txnId)
      )
    );
  const txnById = new Map(txnRows.map((t) => [t.id, t]));

  let written = 0;
  for (const s of suggestions) {
    const t = txnById.get(s.txnId);
    if (!t) continue;
    const ev = evidenceByTxn?.get(s.txnId) ?? null;
    const merchantKey = ev?.merchantKey ?? normalizeMerchant(t.merchantName ?? t.name);
    // History suggestions are precedent by definition → seen. For AI, use the
    // evidence's answer; a batch-ingested row without evidence is conservative
    // (new) so it can only land in a non-auto-postable bucket.
    const merchantSeen = s.source === "history" ? true : (ev?.merchantSeen ?? false);
    const bucketKey = bucketKeyFor(s.source, merchantSeen, s.confidence);

    const res = await db
      .update(schema.bkPlaidTransactions)
      .set({
        suggestedAccountId: s.accountId,
        suggestedConfidence: s.confidence,
        suggestedReasoning: s.reasoning,
        suggestionSource: s.source,
        suggestedAt: new Date(),
        suggestedPayee: s.suggestedPayee,
        suggestionBucket: bucketKey,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.bkPlaidTransactions.id, s.txnId),
          eq(schema.bkPlaidTransactions.status, "pending_review")
        )
      )
      .returning({ id: schema.bkPlaidTransactions.id });
    if (!res.length) continue;
    written += res.length;

    // Evidence ledger — the row calibration measures. Never let a logging
    // failure break the suggestion write.
    try {
      await recordSuggestionEvent({
        entityId,
        txnId: s.txnId,
        merchantKey,
        amountCents: Number(t.amountCents),
        source: s.source,
        suggestedAccountId: s.accountId,
        suggestedPayee: s.suggestedPayee,
        confidence: s.confidence,
        bucketKey,
        reason: s.reasoning,
        evidence: ev ?? {
          rawName: t.merchantName ?? t.name ?? "",
          merchantKey,
          batchIngested: true,
          plaidCategory:
            (t.plaidCategory as { primary?: string } | null)?.primary ?? null,
        },
        model: s.source === "ai" ? MODEL : null,
        wouldAutoPost:
          s.source === "ai" &&
          merchantSeen &&
          s.confidence >= AI_AUTOPOST_MIN_CONFIDENCE &&
          Math.abs(Number(t.amountCents)) <= AI_AUTOPOST_MAX_CENTS,
      });
    } catch (e) {
      console.error(`suggest-categories: event record failed for ${s.txnId}:`, e);
    }
  }
  return written;
}

export interface PersistedSuggestion {
  txnId: string;
  accountId: string;
  confidence: number;
  reasoning: string;
  source: "history" | "ai";
  suggestedPayee: string | null;
  bucketKey: string | null;
  /** true when `confidence` is the bucket's MEASURED precision */
  calibrated: boolean;
}

/**
 * Read the persisted suggestions for an entity's still-pending transactions, so
 * the review page can pre-fill dropdowns on load without a fresh model call.
 * The confidence returned is the CALIBRATED display value: the bucket's
 * measured precision once it has ≥30 outcomes, else the raw number (the UI
 * tags those "unproven").
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
      suggestedPayee: schema.bkPlaidTransactions.suggestedPayee,
      bucketKey: schema.bkPlaidTransactions.suggestionBucket,
    })
    .from(schema.bkPlaidTransactions)
    .where(
      and(
        eq(schema.bkPlaidTransactions.entityId, entityId),
        eq(schema.bkPlaidTransactions.status, "pending_review")
      )
    );

  const stats = await readBucketStats(
    rows.map((r) => r.bucketKey).filter((b): b is string => !!b)
  );

  const out = new Map<string, PersistedSuggestion>();
  for (const r of rows) {
    if (!r.accountId) continue;
    const raw = r.confidence ?? 0;
    const disp = calibratedDisplay(
      raw,
      r.bucketKey ? stats.get(r.bucketKey) : undefined
    );
    out.set(r.txnId, {
      txnId: r.txnId,
      accountId: r.accountId,
      confidence: disp.confidence,
      reasoning: r.reasoning ?? "",
      source: r.source === "ai" ? "ai" : "history",
      suggestedPayee: r.suggestedPayee ?? null,
      bucketKey: r.bucketKey ?? null,
      calibrated: disp.calibrated,
    });
  }
  return out;
}
