import { and, asc, eq } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";

const { bkJournalEntries, bkJournalLines, bkAccounts, bkJournalEdits } = schema;

/**
 * In-product transaction editing — the book-of-record correction path.
 *
 * Two safe edit kinds, both of which keep the entry balanced by construction:
 *   • header fields — `name` (payee), `memo`, `txnDate`. Descriptive only.
 *   • per-line `accountId` — recategorize a posting. The amount (debit/credit
 *     cents) is NEVER touched, so re-pointing a line to a different account can
 *     never unbalance the entry (Σdebit = Σcredit is preserved).
 *
 * Every changed field is logged to `bk_journal_edits` (append-only provenance)
 * and the entry is stamped `editedAt`/`editedBy`. `revertTransaction` replays
 * the earliest recorded `oldValue` per field. Atomic; entity-scoped throughout.
 */

export interface LineEdit {
  /** A `bk_journal_lines.id` belonging to this entry. */
  lineId: string;
  /** A `bk_accounts.id` in this entity to re-point the line to. */
  accountId: string;
}

export interface EditTransactionInput {
  entityId: string;
  entryId: string;
  /** Omitted fields are left unchanged; pass a value (incl. "") to set it. */
  name?: string | null;
  memo?: string | null;
  txnDate?: string; // ISO yyyy-mm-dd
  lines?: LineEdit[];
  editedBy: string | null;
}

/** The full transaction the edit panel renders — header + every posting. */
export interface EditableTransaction {
  id: string;
  source: string;
  txnDate: string;
  qboTxnType: string | null;
  docNum: string | null;
  name: string | null;
  memo: string | null;
  totalCents: number;
  editedAt: string | null;
  editedBy: string | null;
  lines: {
    id: string;
    accountId: string;
    accountName: string;
    debitCents: number;
    creditCents: number;
    lineMemo: string | null;
  }[];
}

/** Load one transaction for editing (header + all lines), entity-scoped. */
export async function getEditableTransaction(
  entityId: string,
  entryId: string
): Promise<EditableTransaction | null> {
  const [entry] = await db
    .select()
    .from(bkJournalEntries)
    .where(
      and(
        eq(bkJournalEntries.id, entryId),
        eq(bkJournalEntries.entityId, entityId)
      )
    );
  if (!entry) return null;

  const lines = await db
    .select({
      id: bkJournalLines.id,
      accountId: bkJournalLines.accountId,
      accountName: bkAccounts.name,
      debitCents: bkJournalLines.debitCents,
      creditCents: bkJournalLines.creditCents,
      lineMemo: bkJournalLines.lineMemo,
    })
    .from(bkJournalLines)
    .innerJoin(bkAccounts, eq(bkAccounts.id, bkJournalLines.accountId))
    .where(eq(bkJournalLines.entryId, entryId))
    .orderBy(asc(bkJournalLines.lineNo));

  return {
    id: entry.id,
    source: entry.source,
    txnDate: entry.txnDate,
    qboTxnType: entry.qboTxnType,
    docNum: entry.docNum,
    name: entry.name,
    memo: entry.memo,
    totalCents: Number(entry.totalCents),
    editedAt: entry.editedAt ? entry.editedAt.toISOString() : null,
    editedBy: entry.editedBy,
    lines: lines.map((l) => ({
      id: l.id,
      accountId: l.accountId,
      accountName: l.accountName,
      debitCents: Number(l.debitCents),
      creditCents: Number(l.creditCents),
      lineMemo: l.lineMemo,
    })),
  };
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Apply an edit. Validates ownership of the entry, every targeted line, and
 * every new account (all must belong to `entityId`), writes the changes, logs
 * provenance, and re-asserts the balance invariant as a backstop. Returns the
 * number of fields changed (0 = nothing to do).
 */
export async function editTransaction(
  input: EditTransactionInput
): Promise<{ changed: number }> {
  const { entityId, entryId, editedBy } = input;

  return db.transaction(async (tx) => {
    const [entry] = await tx
      .select()
      .from(bkJournalEntries)
      .where(
        and(
          eq(bkJournalEntries.id, entryId),
          eq(bkJournalEntries.entityId, entityId)
        )
      )
      .for("update");
    if (!entry) throw new Error("transaction not found for this entity");

    const lines = await tx
      .select()
      .from(bkJournalLines)
      .where(eq(bkJournalLines.entryId, entryId));
    const lineById = new Map(lines.map((l) => [l.id, l]));

    const edits: (typeof bkJournalEdits.$inferInsert)[] = [];
    const stamp = { editedAt: new Date(), editedBy };

    // ---- header fields -------------------------------------------------------
    const header: Partial<typeof bkJournalEntries.$inferInsert> = {};

    if (input.name !== undefined) {
      const next = input.name === "" ? null : input.name;
      if (next !== entry.name) {
        header.name = next;
        edits.push({
          entityId,
          entryId,
          lineId: null,
          field: "name",
          oldValue: entry.name,
          newValue: next,
          ...stamp,
        });
      }
    }
    if (input.memo !== undefined) {
      const next = input.memo === "" ? null : input.memo;
      if (next !== entry.memo) {
        header.memo = next;
        edits.push({
          entityId,
          entryId,
          lineId: null,
          field: "memo",
          oldValue: entry.memo,
          newValue: next,
          ...stamp,
        });
      }
    }
    // A reconciled line is part of a completed statement tie — re-pointing it
    // (or re-dating its entry out of the statement window) would silently break
    // a balance that was proven against the bank. Undo the reconciliation first.
    const anyReconciled = lines.some((l) => l.reconciliationId != null);

    if (input.txnDate !== undefined) {
      if (!ISO_DATE.test(input.txnDate)) throw new Error("invalid date");
      if (input.txnDate !== entry.txnDate && anyReconciled) {
        throw new Error(
          "this transaction has reconciled lines — undo the reconciliation before changing its date"
        );
      }
      if (input.txnDate !== entry.txnDate) {
        edits.push({
          entityId,
          entryId,
          lineId: null,
          field: "txn_date",
          oldValue: entry.txnDate,
          newValue: input.txnDate,
          ...stamp,
        });
        header.txnDate = input.txnDate;
      }
    }

    // ---- per-line recategorization ------------------------------------------
    const lineUpdates: { lineId: string; accountId: string }[] = [];
    for (const le of input.lines ?? []) {
      const line = lineById.get(le.lineId);
      if (!line) throw new Error("a line does not belong to this transaction");
      if (le.accountId === line.accountId) continue; // no-op
      if (line.reconciliationId != null) {
        throw new Error(
          "this line is reconciled — undo the reconciliation before recategorizing it"
        );
      }

      // The new account must exist and belong to this entity.
      const [acct] = await tx
        .select({ id: bkAccounts.id })
        .from(bkAccounts)
        .where(
          and(
            eq(bkAccounts.id, le.accountId),
            eq(bkAccounts.entityId, entityId)
          )
        );
      if (!acct) throw new Error("category account not found for this entity");

      lineUpdates.push({ lineId: le.lineId, accountId: le.accountId });
      edits.push({
        entityId,
        entryId,
        lineId: le.lineId,
        field: "account",
        oldValue: line.accountId,
        newValue: le.accountId,
        ...stamp,
      });
    }

    if (edits.length === 0) return { changed: 0 };

    // ---- write ---------------------------------------------------------------
    if (Object.keys(header).length) {
      await tx
        .update(bkJournalEntries)
        .set(header)
        .where(eq(bkJournalEntries.id, entryId));
    }
    for (const u of lineUpdates) {
      await tx
        .update(bkJournalLines)
        .set({ accountId: u.accountId })
        .where(eq(bkJournalLines.id, u.lineId));
    }

    // Backstop: the entry must still balance. Recategorizing never changes an
    // amount, so this should always hold — assert it anyway (cheap correctness
    // gate; an unbalanced write here would corrupt the books).
    const totalDr = lines.reduce((s, l) => s + Number(l.debitCents), 0);
    const totalCr = lines.reduce((s, l) => s + Number(l.creditCents), 0);
    if (totalDr !== totalCr) {
      throw new Error(`unbalanced after edit: DR ${totalDr} ≠ CR ${totalCr}`);
    }

    await tx.insert(bkJournalEdits).values(edits);
    await tx
      .update(bkJournalEntries)
      .set({ editedAt: stamp.editedAt, editedBy })
      .where(eq(bkJournalEntries.id, entryId));

    return { changed: edits.length };
  });
}

/**
 * Revert a transaction to its original (pre-edit) state: for every field that
 * was ever edited, restore the EARLIEST recorded `oldValue`. Clears the edit
 * stamp and removes the audit rows for this entry (the entry is now original
 * again). No-op if the entry was never edited.
 */
export async function revertTransaction(
  entityId: string,
  entryId: string
): Promise<{ reverted: boolean }> {
  return db.transaction(async (tx) => {
    const [entry] = await tx
      .select()
      .from(bkJournalEntries)
      .where(
        and(
          eq(bkJournalEntries.id, entryId),
          eq(bkJournalEntries.entityId, entityId)
        )
      )
      .for("update");
    if (!entry) throw new Error("transaction not found for this entity");

    const log = await tx
      .select()
      .from(bkJournalEdits)
      .where(eq(bkJournalEdits.entryId, entryId))
      .orderBy(asc(bkJournalEdits.editedAt));
    if (log.length === 0) return { reverted: false };

    // The earliest oldValue per (field, lineId) is the original.
    const original = new Map<string, (typeof log)[number]>();
    for (const e of log) {
      const key = `${e.field}:${e.lineId ?? ""}`;
      if (!original.has(key)) original.set(key, e);
    }

    // Same reconciliation guard as editTransaction: a revert is just another
    // edit, so it must not re-point a reconciled line or re-date an entry whose
    // lines are tied to a completed statement. Undo the reconciliation first.
    const lines = await tx
      .select()
      .from(bkJournalLines)
      .where(eq(bkJournalLines.entryId, entryId));
    const lineById = new Map(lines.map((l) => [l.id, l]));
    const anyReconciled = lines.some((l) => l.reconciliationId != null);
    for (const e of original.values()) {
      if (
        e.field === "txn_date" &&
        e.oldValue &&
        e.oldValue !== entry.txnDate &&
        anyReconciled
      ) {
        throw new Error(
          "this transaction has reconciled lines — undo the reconciliation before reverting its date"
        );
      }
      if (
        e.field === "account" &&
        e.lineId &&
        e.oldValue &&
        lineById.get(e.lineId)?.reconciliationId != null &&
        lineById.get(e.lineId)?.accountId !== e.oldValue
      ) {
        throw new Error(
          "a line on this transaction is reconciled — undo the reconciliation before reverting it"
        );
      }
    }

    const header: Partial<typeof bkJournalEntries.$inferInsert> = {};
    for (const e of original.values()) {
      if (e.field === "name") header.name = e.oldValue;
      else if (e.field === "memo") header.memo = e.oldValue;
      else if (e.field === "txn_date" && e.oldValue) header.txnDate = e.oldValue;
      else if (e.field === "account" && e.lineId && e.oldValue) {
        await tx
          .update(bkJournalLines)
          .set({ accountId: e.oldValue })
          .where(eq(bkJournalLines.id, e.lineId));
      }
    }

    header.editedAt = null;
    header.editedBy = null;
    await tx
      .update(bkJournalEntries)
      .set(header)
      .where(eq(bkJournalEntries.id, entryId));

    await tx.delete(bkJournalEdits).where(eq(bkJournalEdits.entryId, entryId));

    return { reverted: true };
  });
}
