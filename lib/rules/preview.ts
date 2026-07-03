/**
 * Dry-run preview — answer "what would this rule do?" with ZERO writes, so the
 * builder can show consequences before the rule ever touches the books:
 *
 *   • pendingMatchCount — how many in-inbox transactions it would catch
 *   • postedMatchCount  — how many already-posted ones a retroactive apply would touch
 *   • conflicts         — pending matches where a higher-precedence existing rule wins
 *   • unresolved        — canonical keys with no account in this entity
 *
 * Previewing a GLOBAL rule still resolves against a concrete entity (the one
 * whose builder you're in), because that's where canonical keys land.
 */
import { and, eq, isNotNull } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { listPendingTransactions } from "@/lib/plaid/data";
import { extractFacts } from "@/lib/rules/facts";
import { matches } from "@/lib/rules/predicates";
import { resolveAction, newCanonCache } from "@/lib/rules/actions";
import { loadRules, sortRules, selectRule, type RuleRow } from "@/lib/rules/engine";
import { buildFactsContext } from "@/lib/rules/apply";
import type { CanonicalKey } from "@/lib/ledger/canonical-accounts";
import type { ActionSpec, ConditionGroup } from "@/lib/rules/types";

const { bkPlaidTransactions } = schema;

export interface PreviewInput {
  scope: "global" | "entity";
  rank?: number;
  predicate: ConditionGroup;
  action: ActionSpec;
  /** When previewing an EDIT, exclude the saved version from the conflict set. */
  excludeRuleId?: string;
}

export interface PreviewMatch {
  txnId: string;
  label: string;
  amountCents: number;
  txnDate: string;
}
export interface PreviewConflict extends PreviewMatch {
  winningRuleId: string;
  winningRuleName: string;
}

export interface PreviewResult {
  pendingMatchCount: number;
  postedMatchCount: number;
  sample: PreviewMatch[];
  conflicts: PreviewConflict[];
  unresolved: CanonicalKey[];
  actionError?: string;
}

const labelOf = (t: { merchantName: string | null; name: string | null }) =>
  t.merchantName ?? t.name ?? "—";

export async function previewRule(
  entityId: string,
  draft: PreviewInput
): Promise<PreviewResult> {
  const cache = newCanonCache();
  const [pending, ctx, existingAll] = await Promise.all([
    listPendingTransactions(entityId),
    buildFactsContext(entityId),
    loadRules(entityId),
  ]);
  const existing = existingAll.filter((r) => r.id !== draft.excludeRuleId);

  // A synthetic row so the draft participates in precedence ordering. Newest
  // createdAt → it loses only the final, stable tiebreak.
  const draftRow = {
    id: "__draft__",
    scope: draft.scope,
    entityId: draft.scope === "entity" ? entityId : null,
    rank: draft.rank ?? 100,
    predicate: draft.predicate,
    createdAt: new Date(),
    name: "(this rule)",
  } as unknown as RuleRow;
  const ordered = sortRules([...existing, draftRow]);

  // Resolve the action once (canonical → accounts) to surface unresolved/error.
  const repAmount = Math.abs(pending[0]?.amountCents ?? 10000) || 10000;
  const r = await resolveAction(draft.action, entityId, repAmount, cache);

  const sample: PreviewMatch[] = [];
  const conflicts: PreviewConflict[] = [];
  let pendingMatchCount = 0;

  for (const t of pending) {
    const facts = extractFacts(t, ctx);
    if (!matches(draft.predicate, facts)) continue;
    pendingMatchCount++;
    const m: PreviewMatch = {
      txnId: t.id,
      label: labelOf(t),
      amountCents: t.amountCents,
      txnDate: t.txnDate,
    };
    if (sample.length < 8) sample.push(m);
    const winner = selectRule(ordered, facts);
    if (winner && winner.id !== "__draft__") {
      if (conflicts.length < 8) {
        conflicts.push({ ...m, winningRuleId: winner.id, winningRuleName: winner.name });
      }
    }
  }

  // Posted matches (the "retroactive apply would touch N" estimate).
  const posted = await db
    .select({
      name: bkPlaidTransactions.name,
      merchantName: bkPlaidTransactions.merchantName,
      amountCents: bkPlaidTransactions.amountCents,
      isoCurrencyCode: bkPlaidTransactions.isoCurrencyCode,
      plaidCategory: bkPlaidTransactions.plaidCategory,
      txnDate: bkPlaidTransactions.txnDate,
      plaidAccountId: bkPlaidTransactions.plaidAccountId,
    })
    .from(bkPlaidTransactions)
    .where(
      and(
        eq(bkPlaidTransactions.entityId, entityId),
        eq(bkPlaidTransactions.status, "posted"),
        isNotNull(bkPlaidTransactions.journalEntryId)
      )
    );
  let postedMatchCount = 0;
  for (const t of posted) {
    if (matches(draft.predicate, extractFacts(t, ctx))) postedMatchCount++;
  }

  return {
    pendingMatchCount,
    postedMatchCount,
    sample,
    conflicts,
    unresolved: r.unresolved,
    actionError: r.error,
  };
}
