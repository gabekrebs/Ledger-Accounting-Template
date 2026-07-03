import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";

const { bkJournalEntries, bkJournalLines, bkAccounts } = schema;

/**
 * Manual journal entries — the missing QuickBooks primitive. Everything else in
 * the journal arrives via an import (QBO/Wave) or a Plaid posting; this is the
 * path for entries with no source document feed: CPA adjusting entries, year-end
 * depreciation, accruals, owner draws that never touched a linked bank.
 *
 * Same invariants as every other writer of `bk_journal_entries`:
 *   • money is integer CENTS; each line is a debit XOR a credit, both ≥ 0
 *   • Σdebit = Σcredit, asserted before any write (atomic transaction)
 *   • every account must belong to the entity and be active
 *   • `source = 'manual'` — never touched by the QBO clean-replace re-import
 *
 * Because a manual entry is OURS (not mirrored from any external system), it is
 * the one entry kind that may be deleted — guarded so imported history and
 * reconciled lines can never be removed this way.
 */

export interface ManualLineInput {
  accountId: string;
  /** Exactly one of debit/credit must be > 0 (integer cents). */
  debitCents: number;
  creditCents: number;
  lineMemo?: string | null;
  /** Optional per-address dimension (By Address report). */
  location?: string | null;
}

export interface CreateManualEntryInput {
  entityId: string;
  txnDate: string; // ISO yyyy-mm-dd
  name?: string | null; // payee / counterparty
  memo?: string | null;
  docNum?: string | null; // optional reference
  lines: ManualLineInput[];
  createdBy: string | null;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Create a balanced manual journal entry. Returns the new entry id. */
export async function createManualEntry(
  input: CreateManualEntryInput
): Promise<{ entryId: string }> {
  const { entityId, txnDate } = input;
  if (!ISO_DATE.test(txnDate)) throw new Error("invalid date");

  // Drop blank rows the form may submit, then validate what remains.
  const lines = input.lines.filter(
    (l) => l.debitCents !== 0 || l.creditCents !== 0
  );
  if (lines.length < 2) {
    throw new Error("an entry needs at least two lines (a debit and a credit)");
  }
  for (const l of lines) {
    if (
      !Number.isInteger(l.debitCents) ||
      !Number.isInteger(l.creditCents) ||
      l.debitCents < 0 ||
      l.creditCents < 0
    ) {
      throw new Error("line amounts must be non-negative integer cents");
    }
    if (l.debitCents > 0 && l.creditCents > 0) {
      throw new Error("a line is a debit or a credit, not both");
    }
  }
  const totalDr = lines.reduce((s, l) => s + l.debitCents, 0);
  const totalCr = lines.reduce((s, l) => s + l.creditCents, 0);
  if (totalDr !== totalCr) {
    throw new Error(
      `entry is out of balance: debits ${totalDr} ≠ credits ${totalCr} (cents)`
    );
  }

  return db.transaction(async (tx) => {
    // Every account must belong to this entity and be active.
    const ids = [...new Set(lines.map((l) => l.accountId))];
    const accts = await tx
      .select({ id: bkAccounts.id, active: bkAccounts.active })
      .from(bkAccounts)
      .where(and(eq(bkAccounts.entityId, entityId), inArray(bkAccounts.id, ids)));
    const byId = new Map(accts.map((a) => [a.id, a]));
    for (const id of ids) {
      const a = byId.get(id);
      if (!a) throw new Error("an account does not belong to this entity");
      if (!a.active) throw new Error("an account is inactive — reactivate it first");
    }

    const [entry] = await tx
      .insert(bkJournalEntries)
      .values({
        entityId,
        source: "manual",
        // Synthetic type, same convention as Wave's "WaveTxn" — drives the
        // human label in lists. qboTxnId stays null (no external id).
        qboTxnType: "ManualEntry",
        qboTxnId: null,
        txnDate,
        docNum: input.docNum?.trim() || null,
        name: input.name?.trim() || null,
        memo: input.memo?.trim() || null,
        totalCents: totalDr,
        rawQbo: null,
        createdBy: input.createdBy,
      })
      .returning({ id: bkJournalEntries.id });

    await tx.insert(bkJournalLines).values(
      lines.map((l, i) => ({
        entryId: entry.id,
        accountId: l.accountId,
        lineNo: i + 1,
        debitCents: l.debitCents,
        creditCents: l.creditCents,
        lineMemo: l.lineMemo?.trim() || null,
        location: l.location?.trim() || null,
      }))
    );

    return { entryId: entry.id };
  });
}

/**
 * Delete a manual entry. Refuses for any other source (imported/Plaid history
 * is never deletable here) and when any line is reconciled — a cleared line is
 * part of a completed statement tie and must be un-reconciled first.
 */
export async function deleteManualEntry(
  entityId: string,
  entryId: string
): Promise<void> {
  await db.transaction(async (tx) => {
    const [entry] = await tx
      .select({ id: bkJournalEntries.id, source: bkJournalEntries.source })
      .from(bkJournalEntries)
      .where(
        and(
          eq(bkJournalEntries.id, entryId),
          eq(bkJournalEntries.entityId, entityId)
        )
      )
      .for("update");
    if (!entry) throw new Error("entry not found for this entity");
    if (entry.source !== "manual") {
      throw new Error(`refusing to delete a ${entry.source} entry`);
    }

    const [{ reconciled }] = await tx
      .select({ reconciled: sql<number>`COUNT(*)::int` })
      .from(bkJournalLines)
      .where(
        and(
          eq(bkJournalLines.entryId, entryId),
          isNotNull(bkJournalLines.reconciliationId)
        )
      );
    if (Number(reconciled) > 0) {
      throw new Error(
        "this entry has reconciled lines — undo that reconciliation first"
      );
    }

    // Lines + edit-log rows cascade via their FKs.
    await tx.delete(bkJournalEntries).where(eq(bkJournalEntries.id, entryId));
  });
}
