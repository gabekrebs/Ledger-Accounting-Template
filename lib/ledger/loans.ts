import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";

const { bkLoans, bkAccounts, bkJournalLines, bkJournalEntries } = schema;

export interface Loan {
  id: string;
  entityId: string;
  name: string;
  lender: string | null;
  liabilityAccountQboId: string | null;
  interestAccountQboId: string | null;
  escrowAccountQboId: string | null;
  fundingAccountQboId: string | null;

  // Legacy full-amortization fields (nullable — may be absent for new loans)
  originalPrincipalCents: number | null;
  annualRateBps: number | null;
  termMonths: number | null;
  startDate: string | null;
  firstPaymentDate: string | null;

  // Current-state projection fields (preferred — just enter rate + remaining term)
  remainingTermMonths: number | null;
  rateAsOfDate: string | null;

  monthlyPaymentCents: number | null;
  monthlyEscrowCents: number;
  interestOnly: boolean;
  notes: string | null;

  // --- Liability-engine state (see lib/plaid/loan-match.ts) ---
  // `expectedPaymentCents` is owner-editable (the engine's on-switch); the
  // rest is ENGINE-LEARNED and deliberately excluded from LoanInput so a form
  // save can never wipe it.
  expectedPaymentCents: number | null;
  payeeAliases: string[];
  recognizedCount: number;
  lastRecognizedDate: string | null;
}

export async function listLoans(entityId: string): Promise<Loan[]> {
  const rows = await db
    .select()
    .from(bkLoans)
    .where(eq(bkLoans.entityId, entityId))
    .orderBy(asc(bkLoans.name));
  return rows as Loan[];
}

export async function getLoan(
  entityId: string,
  loanId: string
): Promise<Loan | null> {
  const r = await db
    .select()
    .from(bkLoans)
    .where(and(eq(bkLoans.id, loanId), eq(bkLoans.entityId, entityId)))
    .limit(1);
  return (r[0] as Loan) ?? null;
}

export type LoanInput = Omit<
  Loan,
  "id" | "entityId" | "payeeAliases" | "recognizedCount" | "lastRecognizedDate"
>;

export async function upsertLoan(
  entityId: string,
  input: LoanInput,
  loanId?: string
): Promise<string> {
  if (loanId) {
    await db
      .update(bkLoans)
      .set({ ...input, updatedAt: new Date() })
      .where(and(eq(bkLoans.id, loanId), eq(bkLoans.entityId, entityId)));
    return loanId;
  }
  const r = await db
    .insert(bkLoans)
    .values({ entityId, ...input })
    .returning({ id: bkLoans.id });
  return r[0].id;
}

export async function deleteLoan(
  entityId: string,
  loanId: string
): Promise<void> {
  await db
    .delete(bkLoans)
    .where(and(eq(bkLoans.id, loanId), eq(bkLoans.entityId, entityId)));
}

// ---------------------------------------------------------------------------
// Principal paydown — computed from the GL, no loan config required.
//
// Strategy: for each Long Term Liability account with a positive current
// balance (actual remaining debt), find the date of the account's first
// CREDIT posting. That is the "loan origination" date in the GL — the day
// the mortgage was recorded, whether as an opening balance year-end entry
// or an explicit property-purchase journal entry. The balance on that date
// is the "initial amount borrowed." Current minus initial = paydown.
//
// Using per-account first-credit dates solves two real problems observed in
// Wave-imported ledgers:
//
//   1. The entity's overall firstDate (earliest transaction) may predate any
//      LTL posting — e.g., cash/operating entries in July but the mortgage
//      isn't credited until a Dec 31 opening entry. Comparing to firstDate
//      gives initialDebt = $0 and produces a wildly-negative paydown.
//
//   2. Wave sometimes categorises expense accounts (Mortgage Insurance,
//      Mortgage Interest) as "Long Term Liability." These have debit balances
//      (netCents > 0), making them nonsensical liabilities. Including them
//      deflates currentDebt and corrupts the paydown figure. We exclude any
//      account whose current netCents is ≥ 0 (zero = paid off or undrawn;
//      positive = debit balance = not a real liability).
//
//   WaveBalances opening entries (Balance Sheet CSV imports) are excluded
//   from all queries — they double-count balances when Account Transactions
//   are also present.
//
// Scenarios handled correctly:
//
//   Simple mortgage      → initial $406K (at Dec-31 entry), current $386K → paid $20K
//   Forbearance deferral → Deferred account: initial $26K (2022 origin), current $26K → $0 paid
//   Refi (same account)  → balance is continuous; initial = balance at the first credit
//   Cash-out refi        → new balance > initial → paydown negative (correct)
//   Interest-only        → balance unchanged → $0 paydown (correct)
// ---------------------------------------------------------------------------

export interface PaydownSummary {
  initialDebtCents: number;
  currentDebtCents: number;
  /** Positive = net debt reduced. Negative = net debt grew. */
  paydownCents: number;
  accounts: {
    qboAccountId: string;
    name: string;
    initialBalanceCents: number;
    currentBalanceCents: number;
    paydownCents: number;
    /** ISO date of the first credit to this account (loan origination in GL). */
    originatedDate: string | null;
  }[];
}

export async function computePaydownFromGL(
  entityId: string
): Promise<PaydownSummary> {
  const ltlAccounts = await db
    .select({ id: bkAccounts.id, qboAccountId: bkAccounts.qboAccountId, name: bkAccounts.name })
    .from(bkAccounts)
    .where(and(eq(bkAccounts.entityId, entityId), eq(bkAccounts.accountType, "Long Term Liability")));

  if (!ltlAccounts.length) {
    return { initialDebtCents: 0, currentDebtCents: 0, paydownCents: 0, accounts: [] };
  }

  const ids = ltlAccounts.map((a) => a.id);
  const notWaveBalances = sql`${bkJournalEntries.qboTxnType} != 'WaveBalances'`;

  // ── Step 1: Current balance for every LTL account ──────────────────────────
  const currentRows = await db
    .select({
      accountId: bkJournalLines.accountId,
      netCents: sql<number>`SUM(${bkJournalLines.debitCents} - ${bkJournalLines.creditCents})::bigint`.as("n"),
    })
    .from(bkJournalLines)
    .innerJoin(bkJournalEntries, eq(bkJournalLines.entryId, bkJournalEntries.id))
    .where(and(
      inArray(bkJournalLines.accountId, ids),
      eq(bkJournalEntries.entityId, entityId),
      notWaveBalances,
    ))
    .groupBy(bkJournalLines.accountId);

  const currMap = new Map(currentRows.map((r) => [r.accountId, Number(r.netCents)]));

  // Only process accounts with a credit balance (netCents < 0 = actual liability).
  // Accounts with netCents ≥ 0 are either paid off (0) or expense accounts mis-
  // typed as LTL in Wave (positive = debit balance). Both should be excluded.
  const activeSet = new Set(
    ltlAccounts
      .map((a) => a.id)
      .filter((id) => (currMap.get(id) ?? 0) < 0)
  );

  if (!activeSet.size) {
    return { initialDebtCents: 0, currentDebtCents: 0, paydownCents: 0, accounts: [] };
  }

  // ── Step 2: First-credit date per active account ────────────────────────────
  const firstCreditRows = await db
    .select({
      accountId: bkJournalLines.accountId,
      firstCreditDate: sql<string>`MIN(${bkJournalEntries.txnDate})::text`.as("fcd"),
    })
    .from(bkJournalLines)
    .innerJoin(bkJournalEntries, eq(bkJournalLines.entryId, bkJournalEntries.id))
    .where(and(
      inArray(bkJournalLines.accountId, [...activeSet]),
      eq(bkJournalEntries.entityId, entityId),
      notWaveBalances,
      sql`${bkJournalLines.creditCents} > 0`,
    ))
    .groupBy(bkJournalLines.accountId);

  const firstCreditByAccount = new Map(firstCreditRows.map((r) => [r.accountId, r.firstCreditDate]));

  // ── Step 3: Balance at first-credit date per account (= "initial loan") ────
  let initialDebtCents = 0;
  let currentDebtCents = 0;
  const accounts = [];

  for (const acct of ltlAccounts.filter((a) => activeSet.has(a.id))) {
    const originatedDate = firstCreditByAccount.get(acct.id) ?? null;
    if (!originatedDate) continue;

    const [initRow] = await db
      .select({
        netCents: sql<number>`SUM(${bkJournalLines.debitCents} - ${bkJournalLines.creditCents})::bigint`.as("n"),
      })
      .from(bkJournalLines)
      .innerJoin(bkJournalEntries, eq(bkJournalLines.entryId, bkJournalEntries.id))
      .where(and(
        eq(bkJournalLines.accountId, acct.id),
        eq(bkJournalEntries.entityId, entityId),
        notWaveBalances,
        sql`${bkJournalEntries.txnDate} <= ${originatedDate}`,
      ));

    const initBal = -(Number(initRow?.netCents ?? 0));
    const currBal = -(currMap.get(acct.id) ?? 0);

    if (initBal <= 0) continue; // no usable initial balance; skip

    const acctPaydown = initBal - currBal;
    // Only count accounts where debt actually decreased (positive paydown).
    // Accounts where the balance grew (draws on HELOCs, construction loans,
    // additional notes) have negative paydown and should not be mixed in —
    // they represent debt ADDED, not principal paid down.
    if (acctPaydown <= 0) continue;

    initialDebtCents += initBal;
    currentDebtCents += currBal;
    accounts.push({
      qboAccountId: acct.qboAccountId,
      name: acct.name,
      initialBalanceCents: initBal,
      currentBalanceCents: currBal,
      paydownCents: acctPaydown,
      originatedDate,
    });
  }

  return {
    initialDebtCents,
    currentDebtCents,
    paydownCents: initialDebtCents - currentDebtCents,
    accounts: accounts.sort((a, b) => b.initialBalanceCents - a.initialBalanceCents),
  };
}
