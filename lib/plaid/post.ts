import { eq, and } from "drizzle-orm";
import { db, schema, type DbTx, type DbOrTx } from "@/lib/db/client";
import { getBookedBankLines, matchBooked } from "@/lib/plaid/data";

const {
  bkPlaidTransactions,
  bkPlaidAccounts,
  bkAccounts,
  bkJournalEntries,
  bkJournalLines,
} = schema;

/**
 * Post a staged Plaid transaction into the immutable ledger as a balanced,
 * double-entry journal entry — the QuickBooks model: the bank side is the
 * ledger account this Plaid account is mapped to, the other side is the chosen
 * category account.
 *
 * Sign (uniform for asset checking AND liability credit-card, given Plaid's
 * convention that positive = money OUT of / charged to the account):
 *   outflow (amount > 0): CREDIT bank account, DEBIT category
 *   inflow  (amount < 0): DEBIT bank account, CREDIT category
 *
 * Atomic. Idempotent guard: refuses if the txn isn't pending_review.
 */
export async function postPlaidTransaction(
  plaidTxnRowId: string,
  categoryAccountId: string,
  // 'plaid' = a human clicked Post; 'plaid_auto' = the deterministic high-
  // confidence auto-poster wrote it (flagged for the UI + one-click undo).
  source: "plaid" | "plaid_auto" = "plaid",
  // Vendor/payee override from review. Books a clean name (and one that future
  // history-matching can learn from) instead of the raw bank descriptor.
  payee?: string | null,
  // Optional caller transaction — when present, the post joins the caller's
  // transaction so the ledger write + the caller's audit/learning writes are
  // atomic. When absent, the writer opens its own transaction (unchanged).
  existingTx?: DbTx
): Promise<{ journalEntryId: string }> {
  const body = async (tx: DbTx) => {
    const [txn] = await tx
      .select()
      .from(bkPlaidTransactions)
      .where(eq(bkPlaidTransactions.id, plaidTxnRowId))
      .for("update");
    if (!txn) throw new Error("transaction not found");
    if (txn.status !== "pending_review") {
      throw new Error(`already ${txn.status}`);
    }
    // Bank-PENDING transactions must NEVER hit the immutable journal — they
    // can still change amount or be cancelled. The sync no longer stores them
    // at all; this refusal is the backstop for any legacy straggler.
    if (txn.pending) {
      throw new Error("bank-pending transactions are never posted; the settled transaction arrives on its own");
    }
    // A txn only has an entity once its account is assigned to a business.
    if (!txn.entityId) {
      throw new Error(
        "assign this bank account to an entity (Bank connections) before posting"
      );
    }

    // Resolve the mapped bank ledger account.
    const [pAcct] = await tx
      .select()
      .from(bkPlaidAccounts)
      .where(eq(bkPlaidAccounts.plaidAccountId, txn.plaidAccountId));
    if (!pAcct) throw new Error("linked bank account not found");
    // The account's current assignment must agree with the txn's routed entity
    // (they can diverge only briefly between a reassignment and the re-stamp).
    if (pAcct.entityId !== txn.entityId) {
      throw new Error(
        "this bank account was reassigned — re-sync before posting"
      );
    }
    if (!pAcct.mappedAccountId) {
      throw new Error(
        "map this bank account to a ledger account before posting"
      );
    }
    const bankAccountId = pAcct.mappedAccountId;
    if (bankAccountId === categoryAccountId) {
      throw new Error("category cannot be the bank account itself");
    }

    // The mapped bank ledger account must belong to the txn's entity — a Plaid
    // account assigned to entity A can never post into entity B's books.
    const [bankAcct] = await tx
      .select({ id: bkAccounts.id })
      .from(bkAccounts)
      .where(
        and(
          eq(bkAccounts.id, bankAccountId),
          eq(bkAccounts.entityId, txn.entityId)
        )
      );
    if (!bankAcct) {
      throw new Error("mapped bank account does not belong to this entity");
    }

    // Validate the category account belongs to this entity.
    const [cat] = await tx
      .select({ id: bkAccounts.id })
      .from(bkAccounts)
      .where(
        and(
          eq(bkAccounts.id, categoryAccountId),
          eq(bkAccounts.entityId, txn.entityId)
        )
      );
    if (!cat) throw new Error("category account not found for this entity");

    const amount = Math.abs(txn.amountCents);
    if (amount === 0) throw new Error("zero-amount transaction");
    const outflow = txn.amountCents > 0;

    // Hard backstop against double-counting the QBO/Wave import: refuse to post
    // if this same bank line was already booked by an import (exact match). The
    // review UI also hides exact matches, but this guards the direct/API path.
    const booked = await getBookedBankLines(txn.entityId, [bankAccountId]);
    const dup = matchBooked(booked, bankAccountId, amount, txn.txnDate);
    if (dup?.exact) {
      const src = dup.source === "wave_import" ? "Wave" : "QuickBooks";
      throw new Error(
        `already booked by ${src} on this account — ignore it instead of posting`
      );
    }

    const [entry] = await tx
      .insert(bkJournalEntries)
      .values({
        entityId: txn.entityId,
        source,
        qboTxnType: null,
        qboTxnId: null,
        txnDate: txn.txnDate,
        docNum: null,
        name: payee?.trim() || (txn.merchantName ?? txn.name ?? null),
        memo:
          (txn.plaidCategory as { primary?: string } | null)?.primary ?? null,
        totalCents: amount,
        rawQbo: txn.raw, // store the source Plaid object for drill-down/search
      })
      .returning({ id: bkJournalEntries.id });

    const bankLine = {
      entryId: entry.id,
      accountId: bankAccountId,
      lineNo: 1,
      debitCents: outflow ? 0 : amount,
      creditCents: outflow ? amount : 0,
      lineMemo: "bank",
    };
    const catLine = {
      entryId: entry.id,
      accountId: categoryAccountId,
      lineNo: 2,
      debitCents: outflow ? amount : 0,
      creditCents: outflow ? 0 : amount,
      lineMemo: null,
    };
    await tx.insert(bkJournalLines).values([bankLine, catLine]);

    await tx
      .update(bkPlaidTransactions)
      .set({
        status: "posted",
        journalEntryId: entry.id,
        updatedAt: new Date(),
      })
      .where(eq(bkPlaidTransactions.id, plaidTxnRowId));

    return { journalEntryId: entry.id };
  };
  return existingTx ? body(existingTx) : db.transaction(body);
}

export interface PostSplit {
  /** A category (non-bank) ledger account in this entity. */
  accountId: string;
  /** Positive cents on the category side; must sum to |txn amount|. */
  amountCents: number;
  /** Optional per-line note (e.g. "principal" / "interest" / "escrow"). */
  memo?: string | null;
}

/**
 * Post a staged Plaid transaction as a MULTI-line journal entry — the same
 * double-entry model as {@link postPlaidTransaction} but with several category
 * lines instead of one. The bank side is a single line for the full amount; each
 * split is the opposite side for its share. Used for mortgage payments (principal
 * / interest / escrow) and any other deterministic split.
 *
 * Splits must sum EXACTLY to the txn amount, so the entry balances. All the same
 * guards apply (pending_review, entity/mapping agreement, exact-import-dup
 * backstop). Atomic + idempotent.
 */
export async function postPlaidTransactionSplit(
  plaidTxnRowId: string,
  splits: PostSplit[],
  source: "plaid" | "plaid_auto" = "plaid",
  existingTx?: DbTx
): Promise<{ journalEntryId: string }> {
  const body = async (tx: DbTx) => {
    const [txn] = await tx
      .select()
      .from(bkPlaidTransactions)
      .where(eq(bkPlaidTransactions.id, plaidTxnRowId))
      .for("update");
    if (!txn) throw new Error("transaction not found");
    if (txn.status !== "pending_review") throw new Error(`already ${txn.status}`);
    // Never post a bank-PENDING row — never stored by the sync; backstop only.
    if (txn.pending) throw new Error("bank-pending transactions are never posted; the settled transaction arrives on its own");
    if (!txn.entityId) {
      throw new Error(
        "assign this bank account to an entity (Bank connections) before posting"
      );
    }

    const [pAcct] = await tx
      .select()
      .from(bkPlaidAccounts)
      .where(eq(bkPlaidAccounts.plaidAccountId, txn.plaidAccountId));
    if (!pAcct) throw new Error("linked bank account not found");
    if (pAcct.entityId !== txn.entityId) {
      throw new Error("this bank account was reassigned — re-sync before posting");
    }
    if (!pAcct.mappedAccountId) {
      throw new Error("map this bank account to a ledger account before posting");
    }
    const bankAccountId = pAcct.mappedAccountId;

    const cleaned = splits.filter((s) => s.amountCents !== 0);
    if (!cleaned.length) throw new Error("no split lines");
    if (cleaned.some((s) => s.amountCents < 0)) {
      throw new Error("split amounts must be positive");
    }
    if (cleaned.some((s) => s.accountId === bankAccountId)) {
      throw new Error("a split cannot be the bank account itself");
    }

    const amount = Math.abs(txn.amountCents);
    if (amount === 0) throw new Error("zero-amount transaction");
    const splitTotal = cleaned.reduce((n, s) => n + s.amountCents, 0);
    if (splitTotal !== amount) {
      throw new Error(
        `splits (${splitTotal}) must sum to the transaction amount (${amount})`
      );
    }
    const outflow = txn.amountCents > 0;

    // The mapped bank ledger account must belong to the txn's entity.
    const [bankAcct] = await tx
      .select({ id: bkAccounts.id })
      .from(bkAccounts)
      .where(
        and(eq(bkAccounts.id, bankAccountId), eq(bkAccounts.entityId, txn.entityId))
      );
    if (!bankAcct) throw new Error("mapped bank account does not belong to this entity");

    // Every split account must belong to this entity.
    for (const s of cleaned) {
      const [cat] = await tx
        .select({ id: bkAccounts.id })
        .from(bkAccounts)
        .where(
          and(eq(bkAccounts.id, s.accountId), eq(bkAccounts.entityId, txn.entityId))
        );
      if (!cat) throw new Error("a split account was not found for this entity");
    }

    // Same exact-import-dup backstop as the single-category path.
    const booked = await getBookedBankLines(txn.entityId, [bankAccountId]);
    const dup = matchBooked(booked, bankAccountId, amount, txn.txnDate);
    if (dup?.exact) {
      const src = dup.source === "wave_import" ? "Wave" : "QuickBooks";
      throw new Error(
        `already booked by ${src} on this account — ignore it instead of posting`
      );
    }

    const [entry] = await tx
      .insert(bkJournalEntries)
      .values({
        entityId: txn.entityId,
        source,
        qboTxnType: null,
        qboTxnId: null,
        txnDate: txn.txnDate,
        docNum: null,
        name: txn.merchantName ?? txn.name ?? null,
        memo: (txn.plaidCategory as { primary?: string } | null)?.primary ?? null,
        totalCents: amount,
        rawQbo: txn.raw,
      })
      .returning({ id: bkJournalEntries.id });

    const lines = [
      {
        entryId: entry.id,
        accountId: bankAccountId,
        lineNo: 1,
        debitCents: outflow ? 0 : amount,
        creditCents: outflow ? amount : 0,
        lineMemo: "bank",
      },
      ...cleaned.map((s, i) => ({
        entryId: entry.id,
        accountId: s.accountId,
        lineNo: i + 2,
        debitCents: outflow ? s.amountCents : 0,
        creditCents: outflow ? 0 : s.amountCents,
        lineMemo: s.memo ?? null,
      })),
    ];
    await tx.insert(bkJournalLines).values(lines);

    await tx
      .update(bkPlaidTransactions)
      .set({ status: "posted", journalEntryId: entry.id, updatedAt: new Date() })
      .where(eq(bkPlaidTransactions.id, plaidTxnRowId));

    return { journalEntryId: entry.id };
  };
  return existingTx ? body(existingTx) : db.transaction(body);
}

export interface PostLine {
  accountId: string;
  debitCents: number;
  creditCents: number;
  memo?: string | null;
}

/**
 * Post a staged Plaid transaction as a journal entry with FULLY EXPLICIT
 * category lines — for entries where the non-bank side has BOTH debits and
 * credits and so can't be expressed as same-side splits (e.g. a trust owner
 * payout grossed up to gross income (credit) less mgmt/cleaning/expenses
 * (debits)). The caller supplies every non-bank line; this adds the single bank
 * line for the txn amount on its natural side and requires the whole entry to
 * balance.
 *
 * Bank side (Plaid convention, positive = money OUT): outflow → CREDIT bank;
 * inflow → DEBIT bank. Same guards as the other posters; atomic + idempotent.
 */
export async function postPlaidTransactionEntry(
  plaidTxnRowId: string,
  categoryLines: PostLine[],
  source: "plaid" | "plaid_auto" = "plaid",
  // Vendor/payee override from review — same as postPlaidTransaction.
  payee?: string | null
): Promise<{ journalEntryId: string }> {
  return db.transaction(async (tx) => {
    const [txn] = await tx
      .select()
      .from(bkPlaidTransactions)
      .where(eq(bkPlaidTransactions.id, plaidTxnRowId))
      .for("update");
    if (!txn) throw new Error("transaction not found");
    if (txn.status !== "pending_review") throw new Error(`already ${txn.status}`);
    // Never post a bank-PENDING row — never stored by the sync; backstop only.
    if (txn.pending) throw new Error("bank-pending transactions are never posted; the settled transaction arrives on its own");
    if (!txn.entityId) {
      throw new Error(
        "assign this bank account to an entity (Bank connections) before posting"
      );
    }

    const [pAcct] = await tx
      .select()
      .from(bkPlaidAccounts)
      .where(eq(bkPlaidAccounts.plaidAccountId, txn.plaidAccountId));
    if (!pAcct) throw new Error("linked bank account not found");
    if (pAcct.entityId !== txn.entityId) {
      throw new Error("this bank account was reassigned — re-sync before posting");
    }
    if (!pAcct.mappedAccountId) {
      throw new Error("map this bank account to a ledger account before posting");
    }
    const bankAccountId = pAcct.mappedAccountId;

    const cleaned = categoryLines.filter(
      (l) => l.debitCents !== 0 || l.creditCents !== 0
    );
    if (!cleaned.length) throw new Error("no category lines");
    if (cleaned.some((l) => l.debitCents < 0 || l.creditCents < 0)) {
      throw new Error("line amounts must be non-negative");
    }
    if (cleaned.some((l) => l.accountId === bankAccountId)) {
      throw new Error("a category line cannot be the bank account itself");
    }

    const amount = Math.abs(txn.amountCents);
    if (amount === 0) throw new Error("zero-amount transaction");
    const outflow = txn.amountCents > 0;
    const bankLine: PostLine = {
      accountId: bankAccountId,
      debitCents: outflow ? 0 : amount,
      creditCents: outflow ? amount : 0,
      memo: "bank",
    };

    const all = [bankLine, ...cleaned];
    const totalDr = all.reduce((n, l) => n + l.debitCents, 0);
    const totalCr = all.reduce((n, l) => n + l.creditCents, 0);
    if (totalDr !== totalCr) {
      throw new Error(`unbalanced entry: DR ${totalDr} ≠ CR ${totalCr}`);
    }

    // The mapped bank ledger account + every category account must belong to
    // this entity.
    for (const l of all) {
      const [a] = await tx
        .select({ id: bkAccounts.id })
        .from(bkAccounts)
        .where(
          and(eq(bkAccounts.id, l.accountId), eq(bkAccounts.entityId, txn.entityId))
        );
      if (!a) throw new Error("an account does not belong to this entity");
    }

    // Exact-import-dup backstop on the bank line.
    const booked = await getBookedBankLines(txn.entityId, [bankAccountId]);
    const dup = matchBooked(booked, bankAccountId, amount, txn.txnDate);
    if (dup?.exact) {
      const src = dup.source === "wave_import" ? "Wave" : "QuickBooks";
      throw new Error(
        `already booked by ${src} on this account — ignore it instead of posting`
      );
    }

    const [entry] = await tx
      .insert(bkJournalEntries)
      .values({
        entityId: txn.entityId,
        source,
        qboTxnType: null,
        qboTxnId: null,
        txnDate: txn.txnDate,
        docNum: null,
        name: payee?.trim() || (txn.merchantName ?? txn.name ?? null),
        memo: (txn.plaidCategory as { primary?: string } | null)?.primary ?? null,
        totalCents: amount,
        rawQbo: txn.raw,
      })
      .returning({ id: bkJournalEntries.id });

    await tx.insert(bkJournalLines).values(
      all.map((l, i) => ({
        entryId: entry.id,
        accountId: l.accountId,
        lineNo: i + 1,
        debitCents: l.debitCents,
        creditCents: l.creditCents,
        lineMemo: l.memo ?? null,
      }))
    );

    await tx
      .update(bkPlaidTransactions)
      .set({ status: "posted", journalEntryId: entry.id, updatedAt: new Date() })
      .where(eq(bkPlaidTransactions.id, plaidTxnRowId));

    return { journalEntryId: entry.id };
  });
}

/**
 * Reverse a posted Plaid transaction: delete its journal entry (lines cascade
 * via the FK) and return the staged txn to `pending_review` so it re-enters the
 * inbox. The inverse of `postPlaidTransaction` — the safety net that makes
 * auto-posting acceptable, and gives manual posts an undo they lacked.
 *
 * Guarded so this can NEVER delete imported history: it only acts on a txn that
 * is `posted` with a linked entry, and only deletes that entry when its source
 * is `plaid` or `plaid_auto` (never qbo_import / wave_import / manual). Atomic.
 */
export async function unpostPlaidTransaction(plaidTxnRowId: string) {
  return db.transaction(async (tx) => {
    const [txn] = await tx
      .select()
      .from(bkPlaidTransactions)
      .where(eq(bkPlaidTransactions.id, plaidTxnRowId))
      .for("update");
    if (!txn) throw new Error("transaction not found");
    if (txn.status !== "posted" || !txn.journalEntryId) {
      throw new Error(`not posted (status ${txn.status})`);
    }

    const [entry] = await tx
      .select({ source: bkJournalEntries.source })
      .from(bkJournalEntries)
      .where(eq(bkJournalEntries.id, txn.journalEntryId));
    // Only our own postings are reversible here — never imported books.
    if (entry && entry.source !== "plaid" && entry.source !== "plaid_auto") {
      throw new Error(`refusing to unpost a ${entry.source} entry`);
    }

    // Clear EVERY plaid txn that points at this entry first so the FK lets the
    // entry delete; lines cascade. That includes the posted txn AND any internal-
    // transfer counterpart we marked 'ignored' + linked to the same entry — undo
    // must restore both sides to the inbox, or the matched half stays buried.
    await tx
      .update(bkPlaidTransactions)
      .set({
        status: "pending_review",
        journalEntryId: null,
        updatedAt: new Date(),
      })
      .where(eq(bkPlaidTransactions.journalEntryId, txn.journalEntryId));
    await tx
      .delete(bkJournalEntries)
      .where(eq(bkJournalEntries.id, txn.journalEntryId));
  });
}

/**
 * Resolve the inflow counterpart of a matched internal transfer: it's booked as
 * part of the source line's entry, so mark it 'ignored' and link it to that entry
 * (so an unpost of the transfer restores this side too). No-op if not pending.
 */
export async function linkTransferCounterpart(
  counterpartTxnId: string,
  journalEntryId: string,
  exec: DbOrTx = db
) {
  await exec
    .update(bkPlaidTransactions)
    .set({ status: "ignored", journalEntryId, updatedAt: new Date() })
    .where(
      and(
        eq(bkPlaidTransactions.id, counterpartTxnId),
        eq(bkPlaidTransactions.status, "pending_review")
      )
    );
}

/** Mark a staged transaction ignored (won't post; stays out of the inbox). */
export async function ignorePlaidTransaction(
  plaidTxnRowId: string,
  exec: DbOrTx = db
) {
  await exec
    .update(bkPlaidTransactions)
    .set({ status: "ignored", updatedAt: new Date() })
    .where(
      and(
        eq(bkPlaidTransactions.id, plaidTxnRowId),
        eq(bkPlaidTransactions.status, "pending_review")
      )
    );
}
