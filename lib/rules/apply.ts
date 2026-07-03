/**
 * Applying a rule to transactions — the only place rules touch money, and it does
 * so EXCLUSIVELY through the existing safe writers:
 *
 *   • categorize / split → lib/plaid/post.ts (atomic, guarded, idempotent)
 *   • retroactive recat   → lib/ledger/edit-transaction.ts (logs bk_journal_edits,
 *                            refuses reconciled lines — reused verbatim)
 *
 * Every application records a `bk_categorization_events` row and bumps the rule's
 * applied counter. This module never writes `bk_journal_lines` itself.
 */
import { and, eq, isNotNull } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import {
  postPlaidTransaction,
  postPlaidTransactionSplit,
  ignorePlaidTransaction,
} from "@/lib/plaid/post";
import {
  editTransaction,
  getEditableTransaction,
} from "@/lib/ledger/edit-transaction";
import { listItems, listPendingTransactions } from "@/lib/plaid/data";
import { extractFacts, type FactsContext } from "@/lib/rules/facts";
import { matches } from "@/lib/rules/predicates";
import { resolveAction, type CanonCache } from "@/lib/rules/actions";
import { recordEvent, bumpApplied } from "@/lib/rules/store";
import { ruleConfidence } from "@/lib/rules/confidence";
import type { RuleRow } from "@/lib/rules/engine";
import type { ActionSpec, ConditionGroup, Outcome } from "@/lib/rules/types";

const { bkPlaidTransactions } = schema;

/** Build the facts context (plaidAccountId → bank subtype) for an entity. */
export async function buildFactsContext(entityId: string): Promise<FactsContext> {
  const items = await listItems(entityId);
  const subtypeByPlaidAcct = new Map<string, string | null>();
  for (const it of items)
    for (const a of it.accounts)
      subtypeByPlaidAcct.set(a.plaidAccountId, a.subtype ?? null);
  return { subtypeByPlaidAcct };
}

export interface ApplyResult {
  posted: boolean;
  journalEntryId?: string;
  outcome: Outcome;
}

/**
 * Apply one rule to one pending transaction. Posts via the matching writer (or
 * ignores / leaves), logs the decision, and bumps the counter. Throws on writer
 * failure (the caller's try/catch decides what to do) — mirrors post.ts.
 */
export async function applyRuleToTxn(
  txnId: string,
  rule: RuleRow,
  source: "plaid" | "plaid_auto",
  cache: CanonCache,
  actor: string | null = null
): Promise<ApplyResult> {
  const [txn] = await db
    .select({
      entityId: bkPlaidTransactions.entityId,
      amountCents: bkPlaidTransactions.amountCents,
    })
    .from(bkPlaidTransactions)
    .where(eq(bkPlaidTransactions.id, txnId));
  if (!txn) throw new Error("transaction not found");
  if (!txn.entityId) throw new Error("transaction has no entity");

  const abs = Math.abs(txn.amountCents);
  const r = await resolveAction(
    rule.action as ActionSpec,
    txn.entityId,
    abs,
    cache
  );
  if (!r.resolved) throw new Error(r.error ?? "rule action could not be resolved");
  const ra = r.resolved;
  const confidence = ruleConfidence(rule.appliedCount, rule.correctedCount);
  const manual = source === "plaid";

  if (ra.kind === "leave") {
    await recordEvent({
      entityId: txn.entityId,
      plaidTxnId: txnId,
      ruleId: rule.id,
      decisionSource: "rule",
      outcome: "leave_uncategorized",
      actionKind: "leave_uncategorized",
      confidence,
      reason: rule.name,
      createdBy: actor,
    });
    return { posted: false, outcome: "leave_uncategorized" };
  }

  if (ra.kind === "ignore") {
    // Atomic: the status flip + audit event + counter commit or roll back together.
    await db.transaction(async (tx) => {
      await ignorePlaidTransaction(txnId, tx);
      await recordEvent(
        {
          entityId: txn.entityId!,
          plaidTxnId: txnId,
          ruleId: rule.id,
          decisionSource: "rule",
          outcome: "ignored",
          actionKind: "ignore",
          confidence,
          reason: rule.name,
          createdBy: actor,
        },
        tx
      );
      await bumpApplied(rule.id, 1, tx);
    });
    return { posted: false, outcome: "ignored" };
  }

  const outcome: Outcome = manual ? "applied_manual" : "auto_posted";
  // Atomic: the ledger entry, the audit event, and the rule counter are written
  // in ONE transaction, so a failure after the post can't leave a posted txn
  // with no audit/counter (and a retry hitting "already posted").
  const journalEntryId = await db.transaction(async (tx) => {
    let entryId: string;
    let actionKind: string;
    if (ra.kind === "categorize") {
      ({ journalEntryId: entryId } = await postPlaidTransaction(
        txnId,
        ra.categoryAccountId,
        source,
        ra.payee ?? undefined,
        tx
      ));
      actionKind = "categorize";
    } else {
      ({ journalEntryId: entryId } = await postPlaidTransactionSplit(
        txnId,
        ra.splits,
        source,
        tx
      ));
      actionKind = "split";
    }
    await recordEvent(
      {
        entityId: txn.entityId!,
        plaidTxnId: txnId,
        journalEntryId: entryId,
        ruleId: rule.id,
        decisionSource: "rule",
        outcome,
        actionKind,
        confidence,
        reason: rule.name,
        createdBy: actor,
      },
      tx
    );
    await bumpApplied(rule.id, 1, tx);
    return entryId;
  });
  return { posted: true, journalEntryId, outcome };
}

/** Apply a rule to every still-pending transaction it matches. Per-txn isolated. */
export async function applyToSimilar(
  entityId: string,
  rule: RuleRow,
  cache: CanonCache,
  actor: string | null = null
): Promise<{ applied: number; errors: number }> {
  const pending = await listPendingTransactions(entityId);
  const ctx = await buildFactsContext(entityId);
  let applied = 0;
  let errors = 0;
  for (const t of pending) {
    const facts = extractFacts(t, ctx);
    if (!matches(rule.predicate as ConditionGroup, facts)) continue;
    try {
      const res = await applyRuleToTxn(t.id, rule, "plaid", cache, actor);
      if (res.posted || res.outcome === "ignored") applied++;
    } catch {
      errors++;
    }
  }
  return { applied, errors };
}

/**
 * Retroactively re-categorize already-POSTED transactions a categorize rule now
 * covers. Single-category only (split entries are skipped — deferred). Reuses
 * `editTransaction`, which logs bk_journal_edits and REFUSES reconciled lines, so
 * the immutable/reconciled invariants hold for free.
 */
export async function applyRetroactively(
  entityId: string,
  rule: RuleRow,
  cache: CanonCache,
  actor: string | null = null
): Promise<{ updated: number; refused: number; skipped: number; error?: string }> {
  const action = rule.action as ActionSpec;
  if (action.kind !== "categorize") {
    return {
      updated: 0,
      refused: 0,
      skipped: 0,
      error: "retroactive apply supports single-category rules only",
    };
  }
  const r = await resolveAction(action, entityId, 0, cache);
  if (!r.resolved || r.resolved.kind !== "categorize") {
    return { updated: 0, refused: 0, skipped: 0, error: r.error ?? "unresolved category" };
  }
  const categoryAccountId = r.resolved.categoryAccountId;

  const posted = await db
    .select({
      id: bkPlaidTransactions.id,
      entityId: bkPlaidTransactions.entityId,
      name: bkPlaidTransactions.name,
      merchantName: bkPlaidTransactions.merchantName,
      amountCents: bkPlaidTransactions.amountCents,
      isoCurrencyCode: bkPlaidTransactions.isoCurrencyCode,
      plaidCategory: bkPlaidTransactions.plaidCategory,
      txnDate: bkPlaidTransactions.txnDate,
      plaidAccountId: bkPlaidTransactions.plaidAccountId,
      journalEntryId: bkPlaidTransactions.journalEntryId,
    })
    .from(bkPlaidTransactions)
    .where(
      and(
        eq(bkPlaidTransactions.entityId, entityId),
        eq(bkPlaidTransactions.status, "posted"),
        isNotNull(bkPlaidTransactions.journalEntryId)
      )
    );

  const ctx = await buildFactsContext(entityId);
  let updated = 0;
  let refused = 0;
  let skipped = 0;

  for (const t of posted) {
    const facts = extractFacts(t, ctx);
    if (!matches(rule.predicate as ConditionGroup, facts)) continue;
    const entryId = t.journalEntryId!;
    const editable = await getEditableTransaction(entityId, entryId);
    if (!editable) {
      skipped++;
      continue;
    }
    // The bank line is marked lineMemo 'bank'; the category side is the rest.
    const categoryLines = editable.lines.filter((l) => l.lineMemo !== "bank");
    if (categoryLines.length !== 1) {
      skipped++; // split entry — deferred
      continue;
    }
    const line = categoryLines[0];
    if (line.accountId === categoryAccountId) {
      skipped++; // already correct
      continue;
    }
    try {
      const { changed } = await editTransaction({
        entityId,
        entryId,
        lines: [{ lineId: line.id, accountId: categoryAccountId }],
        editedBy: actor,
      });
      if (changed > 0) {
        updated++;
        await recordEvent({
          entityId,
          plaidTxnId: t.id,
          journalEntryId: entryId,
          ruleId: rule.id,
          decisionSource: "rule",
          outcome: "applied_manual",
          actionKind: "categorize",
          reason: `retroactive: ${rule.name}`,
          createdBy: actor,
        });
      } else {
        skipped++;
      }
    } catch {
      // editTransaction refuses reconciled lines — count, don't abort.
      refused++;
    }
  }
  if (updated) await bumpApplied(rule.id, updated);
  return { updated, refused, skipped };
}
