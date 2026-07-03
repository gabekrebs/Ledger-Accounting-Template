import { and, desc, eq, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";

const { bkReconciliations, bkJournalEntries, bkJournalLines, bkAccounts } =
  schema;

/**
 * Bank reconciliation — the QuickBooks statement-tie workflow, the integrity
 * control a bank FEED can't provide: prove that the ledger's cleared activity
 * on one bank/credit-card account matches the bank's statement to the penny.
 *
 * Model: one `bk_reconciliations` row per statement. Checking a line off stamps
 * its `reconciliation_id` (so marks persist mid-workflow); Finish is allowed
 * only when beginning + Σ(checked) equals the statement ending balance exactly.
 * Cancel (in-progress) or undo (latest completed) releases the lines.
 *
 * Sign convention: internal cleared math is signed debit-net (Σ debit − credit,
 * like the rest of reports.ts); the STATEMENT balance is entered in the
 * account's natural sign (a credit card's "balance owed" is positive), so the
 * comparison normalizes by `normal_balance`.
 */

/** Account types that have statements to reconcile against. */
export const RECONCILABLE_TYPES = ["Bank", "Credit Card"] as const;

export interface RecAccount {
  id: string;
  qboAccountId: string;
  name: string;
  fullyQualifiedName: string | null;
  accountType: string;
  normalBalance: string; // 'debit' | 'credit'
}

/** Net→natural-sign display conversion for an account's balances. */
export function toNaturalSign(netCents: number, normalBalance: string): number {
  return normalBalance === "credit" ? -netCents : netCents;
}

/** Resolve a reconcilable account by its qboAccountId (the GL route key). */
export async function getReconcilableAccount(
  entityId: string,
  qboAccountId: string
): Promise<RecAccount | null> {
  const [a] = await db
    .select({
      id: bkAccounts.id,
      qboAccountId: bkAccounts.qboAccountId,
      name: bkAccounts.name,
      fullyQualifiedName: bkAccounts.fullyQualifiedName,
      accountType: bkAccounts.accountType,
      normalBalance: bkAccounts.normalBalance,
    })
    .from(bkAccounts)
    .where(
      and(
        eq(bkAccounts.entityId, entityId),
        eq(bkAccounts.qboAccountId, qboAccountId)
      )
    );
  if (!a) return null;
  if (!(RECONCILABLE_TYPES as readonly string[]).includes(a.accountType)) {
    return null;
  }
  return a;
}

/** Σ(debit − credit) of already-reconciled lines on an account. */
async function clearedNetCents(
  tx: typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0],
  accountId: string
): Promise<number> {
  const [row] = await tx
    .select({
      net: sql<string>`COALESCE(SUM(${bkJournalLines.debitCents} - ${bkJournalLines.creditCents}), 0)`,
    })
    .from(bkJournalLines)
    .where(
      and(
        eq(bkJournalLines.accountId, accountId),
        isNotNull(bkJournalLines.reconciliationId)
      )
    );
  return Number(row?.net ?? 0);
}

export interface ReconciliationSummary {
  id: string;
  statementDate: string;
  statementBalanceCents: number;
  beginningBalanceCents: number; // signed debit-net
  status: string;
  notes: string | null;
  createdBy: string | null;
  completedAt: string | null;
  lineCount: number;
}

/** Past + open reconciliations for an account, newest first. */
export async function listReconciliations(
  entityId: string,
  accountId: string
): Promise<ReconciliationSummary[]> {
  const rows = await db
    .select({
      id: bkReconciliations.id,
      statementDate: bkReconciliations.statementDate,
      statementBalanceCents: bkReconciliations.statementBalanceCents,
      beginningBalanceCents: bkReconciliations.beginningBalanceCents,
      status: bkReconciliations.status,
      notes: bkReconciliations.notes,
      createdBy: bkReconciliations.createdBy,
      completedAt: bkReconciliations.completedAt,
      lineCount: sql<number>`(SELECT COUNT(*)::int FROM ${bkJournalLines}
        WHERE ${bkJournalLines.reconciliationId} = ${bkReconciliations.id})`,
    })
    .from(bkReconciliations)
    .where(
      and(
        eq(bkReconciliations.entityId, entityId),
        eq(bkReconciliations.accountId, accountId)
      )
    )
    .orderBy(desc(bkReconciliations.statementDate), desc(bkReconciliations.createdAt));
  return rows.map((r) => ({
    ...r,
    statementBalanceCents: Number(r.statementBalanceCents),
    beginningBalanceCents: Number(r.beginningBalanceCents),
    lineCount: Number(r.lineCount),
    completedAt: r.completedAt ? r.completedAt.toISOString() : null,
  }));
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Start a reconciliation. One open rec per account (DB-enforced by a partial
 * unique index). Snapshots the beginning balance = Σ of already-cleared lines.
 */
export async function startReconciliation(input: {
  entityId: string;
  accountId: string;
  statementDate: string;
  statementBalanceCents: number;
  createdBy: string | null;
}): Promise<{ reconciliationId: string }> {
  if (!ISO_DATE.test(input.statementDate)) throw new Error("invalid statement date");
  if (!Number.isInteger(input.statementBalanceCents)) {
    throw new Error("statement balance must be integer cents");
  }
  return db.transaction(async (tx) => {
    const [acct] = await tx
      .select({ id: bkAccounts.id, accountType: bkAccounts.accountType })
      .from(bkAccounts)
      .where(
        and(
          eq(bkAccounts.id, input.accountId),
          eq(bkAccounts.entityId, input.entityId)
        )
      );
    if (!acct) throw new Error("account not found for this entity");
    if (!(RECONCILABLE_TYPES as readonly string[]).includes(acct.accountType)) {
      throw new Error("only bank and credit-card accounts reconcile against statements");
    }

    const beginning = await clearedNetCents(tx, input.accountId);
    try {
      const [rec] = await tx
        .insert(bkReconciliations)
        .values({
          entityId: input.entityId,
          accountId: input.accountId,
          statementDate: input.statementDate,
          statementBalanceCents: input.statementBalanceCents,
          beginningBalanceCents: beginning,
          createdBy: input.createdBy,
        })
        .returning({ id: bkReconciliations.id });
      return { reconciliationId: rec.id };
    } catch (e) {
      // Drizzle wraps the pg error; the constraint name lives on the cause.
      const texts: string[] = [];
      for (let err: unknown = e; err instanceof Error; err = err.cause) {
        texts.push(err.message);
        const c = (err as { constraint_name?: string }).constraint_name;
        if (c) texts.push(c);
      }
      if (texts.some((t) => t.includes("bk_reconciliations_one_open_uq"))) {
        throw new Error("a reconciliation is already in progress for this account");
      }
      throw e;
    }
  });
}

export interface RecWorkspaceLine {
  lineId: string;
  entryId: string;
  txnDate: string;
  txnType: string | null;
  name: string | null;
  memo: string | null;
  debitCents: number;
  creditCents: number;
  checked: boolean;
}

export interface RecWorkspace {
  rec: ReconciliationSummary;
  account: RecAccount;
  lines: RecWorkspaceLine[];
  /** True when more candidate lines exist than the cap returned. */
  truncated: boolean;
  /** Live signed debit-net of ALL cleared lines on the account (incl. this rec). */
  clearedNetCents: number;
}

const LINE_CAP = 3000;

/**
 * The open reconciliation's working set: every line on the account dated on or
 * before the statement date that is either unreconciled or checked in THIS rec.
 */
export async function getReconciliationWorkspace(
  entityId: string,
  reconciliationId: string
): Promise<RecWorkspace | null> {
  const [rec] = await db
    .select()
    .from(bkReconciliations)
    .where(
      and(
        eq(bkReconciliations.id, reconciliationId),
        eq(bkReconciliations.entityId, entityId)
      )
    );
  if (!rec) return null;

  const [account] = await db
    .select({
      id: bkAccounts.id,
      qboAccountId: bkAccounts.qboAccountId,
      name: bkAccounts.name,
      fullyQualifiedName: bkAccounts.fullyQualifiedName,
      accountType: bkAccounts.accountType,
      normalBalance: bkAccounts.normalBalance,
    })
    .from(bkAccounts)
    .where(eq(bkAccounts.id, rec.accountId));
  if (!account) return null;

  const rows = await db
    .select({
      lineId: bkJournalLines.id,
      entryId: bkJournalEntries.id,
      txnDate: bkJournalEntries.txnDate,
      txnType: bkJournalEntries.qboTxnType,
      name: bkJournalEntries.name,
      memo: sql<string | null>`COALESCE(${bkJournalLines.lineMemo}, ${bkJournalEntries.memo})`,
      debitCents: bkJournalLines.debitCents,
      creditCents: bkJournalLines.creditCents,
      reconciliationId: bkJournalLines.reconciliationId,
    })
    .from(bkJournalLines)
    .innerJoin(bkJournalEntries, eq(bkJournalEntries.id, bkJournalLines.entryId))
    .where(
      and(
        eq(bkJournalLines.accountId, rec.accountId),
        lte(bkJournalEntries.txnDate, rec.statementDate),
        or(
          isNull(bkJournalLines.reconciliationId),
          eq(bkJournalLines.reconciliationId, reconciliationId)
        )
      )
    )
    .orderBy(bkJournalEntries.txnDate, bkJournalEntries.createdAt)
    .limit(LINE_CAP + 1);

  const truncated = rows.length > LINE_CAP;
  const lines = (truncated ? rows.slice(0, LINE_CAP) : rows).map((r) => ({
    lineId: r.lineId,
    entryId: r.entryId,
    txnDate: r.txnDate,
    txnType: r.txnType,
    name: r.name,
    memo: r.memo,
    debitCents: Number(r.debitCents),
    creditCents: Number(r.creditCents),
    checked: r.reconciliationId === reconciliationId,
  }));

  return {
    rec: {
      id: rec.id,
      statementDate: rec.statementDate,
      statementBalanceCents: Number(rec.statementBalanceCents),
      beginningBalanceCents: Number(rec.beginningBalanceCents),
      status: rec.status,
      notes: rec.notes,
      createdBy: rec.createdBy,
      completedAt: rec.completedAt ? rec.completedAt.toISOString() : null,
      lineCount: lines.filter((l) => l.checked).length,
    },
    account,
    lines,
    truncated,
    clearedNetCents: await clearedNetCents(db, rec.accountId),
  };
}

/** Check or uncheck lines in an OPEN reconciliation (batch — powers check-all). */
export async function setLinesCleared(input: {
  entityId: string;
  reconciliationId: string;
  lineIds: string[];
  cleared: boolean;
}): Promise<{ updated: number }> {
  if (input.lineIds.length === 0) return { updated: 0 };
  return db.transaction(async (tx) => {
    const [rec] = await tx
      .select()
      .from(bkReconciliations)
      .where(
        and(
          eq(bkReconciliations.id, input.reconciliationId),
          eq(bkReconciliations.entityId, input.entityId)
        )
      )
      .for("update");
    if (!rec) throw new Error("reconciliation not found");
    if (rec.status !== "in_progress") {
      throw new Error("this reconciliation is already completed");
    }

    // Only lines on this rec's account, and never lines claimed by ANOTHER rec.
    const res = input.cleared
      ? await tx
          .update(bkJournalLines)
          .set({ reconciliationId: input.reconciliationId })
          .where(
            and(
              inArray(bkJournalLines.id, input.lineIds),
              eq(bkJournalLines.accountId, rec.accountId),
              isNull(bkJournalLines.reconciliationId)
            )
          )
          .returning({ id: bkJournalLines.id })
      : await tx
          .update(bkJournalLines)
          .set({ reconciliationId: null })
          .where(
            and(
              inArray(bkJournalLines.id, input.lineIds),
              eq(bkJournalLines.reconciliationId, input.reconciliationId)
            )
          )
          .returning({ id: bkJournalLines.id });
    return { updated: res.length };
  });
}

/**
 * Complete the reconciliation — only when the cleared balance equals the
 * statement balance exactly (in the account's natural sign, to the penny).
 */
export async function finishReconciliation(
  entityId: string,
  reconciliationId: string
): Promise<void> {
  await db.transaction(async (tx) => {
    const [rec] = await tx
      .select()
      .from(bkReconciliations)
      .where(
        and(
          eq(bkReconciliations.id, reconciliationId),
          eq(bkReconciliations.entityId, entityId)
        )
      )
      .for("update");
    if (!rec) throw new Error("reconciliation not found");
    if (rec.status !== "in_progress") throw new Error("already completed");

    const [acct] = await tx
      .select({ normalBalance: bkAccounts.normalBalance })
      .from(bkAccounts)
      .where(eq(bkAccounts.id, rec.accountId));
    if (!acct) throw new Error("account not found");

    const net = await clearedNetCents(tx, rec.accountId);
    const natural = toNaturalSign(net, acct.normalBalance);
    const diff = Number(rec.statementBalanceCents) - natural;
    if (diff !== 0) {
      throw new Error(
        `cleared balance is off by ${(Math.abs(diff) / 100).toFixed(2)} — keep going until the difference is $0.00`
      );
    }

    await tx
      .update(bkReconciliations)
      .set({ status: "completed", completedAt: new Date() })
      .where(eq(bkReconciliations.id, reconciliationId));
  });
}

/** Abandon an open reconciliation: release its lines, delete the row. */
export async function cancelReconciliation(
  entityId: string,
  reconciliationId: string
): Promise<void> {
  await db.transaction(async (tx) => {
    const [rec] = await tx
      .select()
      .from(bkReconciliations)
      .where(
        and(
          eq(bkReconciliations.id, reconciliationId),
          eq(bkReconciliations.entityId, entityId)
        )
      )
      .for("update");
    if (!rec) throw new Error("reconciliation not found");
    if (rec.status !== "in_progress") {
      throw new Error("completed reconciliations are undone, not cancelled");
    }
    await tx
      .update(bkJournalLines)
      .set({ reconciliationId: null })
      .where(eq(bkJournalLines.reconciliationId, reconciliationId));
    await tx
      .delete(bkReconciliations)
      .where(eq(bkReconciliations.id, reconciliationId));
  });
}

/**
 * Undo the LATEST completed reconciliation for an account (the only one that
 * can be safely released — undoing an older one would orphan the beginning
 * balances of everything after it). Releases its lines and deletes the row.
 */
export async function undoLastReconciliation(
  entityId: string,
  accountId: string
): Promise<{ undone: string }> {
  return db.transaction(async (tx) => {
    const open = await tx
      .select({ id: bkReconciliations.id })
      .from(bkReconciliations)
      .where(
        and(
          eq(bkReconciliations.accountId, accountId),
          eq(bkReconciliations.status, "in_progress")
        )
      );
    if (open.length > 0) {
      throw new Error("finish or cancel the open reconciliation first");
    }
    const [latest] = await tx
      .select({ id: bkReconciliations.id })
      .from(bkReconciliations)
      .where(
        and(
          eq(bkReconciliations.entityId, entityId),
          eq(bkReconciliations.accountId, accountId),
          eq(bkReconciliations.status, "completed")
        )
      )
      .orderBy(desc(bkReconciliations.statementDate), desc(bkReconciliations.createdAt))
      .limit(1)
      .for("update");
    if (!latest) throw new Error("no completed reconciliation to undo");

    await tx
      .update(bkJournalLines)
      .set({ reconciliationId: null })
      .where(eq(bkJournalLines.reconciliationId, latest.id));
    await tx
      .delete(bkReconciliations)
      .where(eq(bkReconciliations.id, latest.id));
    return { undone: latest.id };
  });
}
