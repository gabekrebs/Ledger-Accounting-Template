import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { db, schema, type DbOrTx } from "@/lib/db/client";
import { coverageSets, coverageFor, latestDismissalAt } from "@/lib/rules/learner";
import { proposeLearnedRule } from "@/lib/rules/store";

/**
 * The evidence ledger (ADR-021) — suggestion-lifecycle recording on top of the
 * existing bk_categorization_events audit log.
 *
 * One 'suggested' row per suggestion shown; the human (or the auto-poster)
 * decision is stamped onto the SAME row (outcome → accepted / corrected /
 * ignored / auto_posted, plus posted account, decided_by/at), so calibration
 * reads observed precision as one-row-per-suggestion. `detail` carries the
 * evidence snapshot for future-model replay/backtesting.
 *
 * Buckets: an evidence class + confidence band, e.g. "ai|seen|b90" — AI
 * suggestion, merchant previously booked somewhere in the books, raw model
 * confidence in the 0.90 band. Measured per-bucket precision is what the UI
 * shows as the calibrated % and what gates auto-posting (lib/ai/calibration).
 */

const { bkCategorizationEvents } = schema;

export const PROMPT_VERSION = "cat-v2-opus-2026-07";
export const SUGGEST_MODEL = "claude-opus-4-8";

/** AI auto-post hard dollar cap (owner decision): above this, always review. */
export const AI_AUTOPOST_MAX_CENTS = 100_000; // $1,000

/** Raw-confidence floor for shadow auto-post eligibility. */
export const AI_AUTOPOST_MIN_CONFIDENCE = 0.9;

/**
 * Master kill switch for AI auto-posting — an explicit, owner-controlled env
 * flag that DEFAULTS OFF. Even a bucket that has EARNED unlock (measured ≥98%
 * precision, ADR-021) only posts unattended while the owner has set
 * AI_AUTOPOST_ENABLED=true in the deployment env. Everything else about the
 * pipeline (suggestions, calibration, shadow measurement) runs regardless;
 * deterministic rules/recognizers are unaffected — this gates ONLY the AI
 * stage of the auto-poster.
 */
export function aiAutopostEnabled(): boolean {
  return process.env.AI_AUTOPOST_ENABLED === "true";
}

export function confidenceBand(confidence: number): string {
  if (confidence >= 0.9) return "b90";
  if (confidence >= 0.8) return "b80";
  if (confidence >= 0.7) return "b70";
  if (confidence >= 0.6) return "b60";
  return "blo";
}

export function bucketKeyFor(
  source: "history" | "ai",
  merchantSeen: boolean,
  confidence: number
): string {
  return `${source}|${merchantSeen ? "seen" : "new"}|${confidenceBand(confidence)}`;
}

export interface SuggestionEventInput {
  entityId: string;
  txnId: string;
  merchantKey: string;
  amountCents: number;
  source: "history" | "ai";
  suggestedAccountId: string;
  suggestedPayee: string | null;
  confidence: number;
  bucketKey: string;
  reason: string;
  /** evidence snapshot: similar txns shown, intel used, history hint, raw name */
  evidence: unknown;
  model: string | null;
  wouldAutoPost: boolean;
}

/**
 * Record that a suggestion was shown. Skips the insert when an UNDECIDED
 * 'suggested' row already exists for this txn with the same account + source —
 * the auto-suggest re-runs on every inbox load, and re-showing the same
 * suggestion is not a new datum. A CHANGED suggestion gets a fresh row (the
 * stale undecided one is superseded in place so it can't pollute calibration).
 */
export async function recordSuggestionEvent(
  s: SuggestionEventInput
): Promise<void> {
  const [open] = await db
    .select({
      id: bkCategorizationEvents.id,
      suggestedAccountId: bkCategorizationEvents.suggestedAccountId,
      decisionSource: bkCategorizationEvents.decisionSource,
    })
    .from(bkCategorizationEvents)
    .where(
      and(
        eq(bkCategorizationEvents.plaidTxnId, s.txnId),
        eq(bkCategorizationEvents.outcome, "suggested"),
        isNull(bkCategorizationEvents.decidedAt)
      )
    )
    .orderBy(desc(bkCategorizationEvents.createdAt))
    .limit(1);

  if (
    open &&
    open.suggestedAccountId === s.suggestedAccountId &&
    open.decisionSource === s.source
  ) {
    return; // same suggestion re-shown — nothing new to learn
  }
  if (open) {
    // Superseded by a different suggestion before anyone decided.
    await db
      .update(bkCategorizationEvents)
      .set({ outcome: "superseded", decidedAt: new Date() })
      .where(eq(bkCategorizationEvents.id, open.id));
  }

  await db.insert(bkCategorizationEvents).values({
    entityId: s.entityId,
    plaidTxnId: s.txnId,
    decisionSource: s.source,
    outcome: "suggested",
    actionKind: "categorize",
    confidence: s.confidence,
    reason: s.reason,
    detail: s.evidence,
    suggestedAccountId: s.suggestedAccountId,
    merchantKey: s.merchantKey,
    amountCents: s.amountCents,
    bucketKey: s.bucketKey,
    model: s.model,
    promptVersion: s.model ? PROMPT_VERSION : null,
    suggestedPayee: s.suggestedPayee,
    wouldAutoPost: s.wouldAutoPost,
  });
}

export interface DecisionResult {
  outcome: "accepted" | "corrected" | "ignored" | "auto_posted" | null;
  bucketKey: string | null;
  merchantKey: string | null;
  source: string | null;
  suggestedAccountId: string | null;
}

/**
 * Stamp the decision onto the open 'suggested' event for a transaction.
 * kind 'posted'   → accepted (posted the suggested account) or corrected
 * kind 'ignored'  → ignored (not a correctness signal; excluded from precision)
 * kind 'auto'     → auto_posted (the AI stage posted it unattended)
 * Returns what happened so callers can lock buckets / propose rules. No-op
 * (null outcome) when the txn had no open suggestion.
 */
export async function recordSuggestionDecision(
  input: {
    txnId: string;
    postedAccountId?: string | null;
    decidedBy?: string | null;
    kind: "posted" | "ignored" | "auto";
  },
  exec: DbOrTx = db
): Promise<DecisionResult> {
  const none: DecisionResult = {
    outcome: null,
    bucketKey: null,
    merchantKey: null,
    source: null,
    suggestedAccountId: null,
  };
  const [open] = await exec
    .select({
      id: bkCategorizationEvents.id,
      suggestedAccountId: bkCategorizationEvents.suggestedAccountId,
      bucketKey: bkCategorizationEvents.bucketKey,
      merchantKey: bkCategorizationEvents.merchantKey,
      decisionSource: bkCategorizationEvents.decisionSource,
    })
    .from(bkCategorizationEvents)
    .where(
      and(
        eq(bkCategorizationEvents.plaidTxnId, input.txnId),
        eq(bkCategorizationEvents.outcome, "suggested"),
        isNull(bkCategorizationEvents.decidedAt)
      )
    )
    .orderBy(desc(bkCategorizationEvents.createdAt))
    .limit(1);
  if (!open) return none;

  const outcome =
    input.kind === "ignored"
      ? ("ignored" as const)
      : input.kind === "auto"
        ? ("auto_posted" as const)
        : input.postedAccountId === open.suggestedAccountId
          ? ("accepted" as const)
          : ("corrected" as const);

  await exec
    .update(bkCategorizationEvents)
    .set({
      outcome,
      postedAccountId: input.postedAccountId ?? null,
      decidedAt: new Date(),
      decidedBy: input.decidedBy ?? null,
    })
    .where(eq(bkCategorizationEvents.id, open.id));

  return {
    outcome,
    bucketKey: open.bucketKey,
    merchantKey: open.merchantKey,
    source: open.decisionSource,
    suggestedAccountId: open.suggestedAccountId,
  };
}

/**
 * A later human reversal of an AI auto-post (undo in the review tab) is THE
 * correction signal for an unlocked bucket. Flip the event and report the
 * bucket so the caller can lock it.
 */
export async function recordAutoPostReversal(
  txnId: string,
  decidedBy: string | null
): Promise<{ bucketKey: string | null }> {
  const [row] = await db
    .select({
      id: bkCategorizationEvents.id,
      bucketKey: bkCategorizationEvents.bucketKey,
    })
    .from(bkCategorizationEvents)
    .where(
      and(
        eq(bkCategorizationEvents.plaidTxnId, txnId),
        eq(bkCategorizationEvents.outcome, "auto_posted"),
        eq(bkCategorizationEvents.decisionSource, "ai")
      )
    )
    .orderBy(desc(bkCategorizationEvents.createdAt))
    .limit(1);
  if (!row) return { bucketKey: null };
  await db
    .update(bkCategorizationEvents)
    .set({ outcome: "corrected", decidedAt: new Date(), decidedBy })
    .where(eq(bkCategorizationEvents.id, row.id));
  return { bucketKey: row.bucketKey };
}

// AI-accept → rule proposal (owner decision: after 2 consistent accepts).
const AI_ACCEPTS_FOR_RULE = 2;

/**
 * After an ACCEPTED AI suggestion: once the same merchant has been accepted to
 * the same account AI_ACCEPTS_FOR_RULE times, author a proposed rule into the
 * normal approval queue — the merchant graduates from AI-land to the
 * deterministic layer. Idempotent via the learner's coverage check.
 */
export async function maybeProposeRuleFromAiAccepts(input: {
  entityId: string;
  merchantKey: string;
  accountId: string;
  accountLabel: string;
}): Promise<boolean> {
  const { entityId, merchantKey, accountId, accountLabel } = input;
  if (!merchantKey || merchantKey.length < 3) return false;

  const sets = await coverageSets(entityId);
  const cov = coverageFor(merchantKey, sets);
  if (cov === "active" || cov === "proposed") return false;
  // A dismissed merchant only re-qualifies on accepts NEWER than the dismissal
  // — each accept is the owner hand-categorizing a fresh charge, so two of
  // them since dismissing means the vendor is genuinely back (owner's rule:
  // old data never resurfaces; new activity may).
  const dismissedAt = cov === "dismissed" ? latestDismissalAt(merchantKey, sets.dismissed) : null;

  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(bkCategorizationEvents)
    .where(
      and(
        eq(bkCategorizationEvents.entityId, entityId),
        eq(bkCategorizationEvents.merchantKey, merchantKey),
        eq(bkCategorizationEvents.decisionSource, "ai"),
        eq(bkCategorizationEvents.outcome, "accepted"),
        eq(bkCategorizationEvents.postedAccountId, accountId),
        ...(dismissedAt ? [gt(bkCategorizationEvents.createdAt, dismissedAt)] : [])
      )
    );
  if ((row?.n ?? 0) < AI_ACCEPTS_FOR_RULE) return false;

  await proposeLearnedRule({
    scope: "entity",
    entityId,
    name: `AI-confirmed: ${merchantKey} → ${accountLabel}`,
    description: `Proposed after ${AI_ACCEPTS_FOR_RULE} accepted AI suggestions to the same category.`,
    predicate: { all: [{ field: "merchant", op: "eq", value: merchantKey }] },
    action: { kind: "categorize", target: { by: "account", accountId } },
  });
  return true;
}
