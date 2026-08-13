import { and, eq, lt, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { listLoans, type Loan } from "@/lib/ledger/loans";
import { normalizeMerchant, extractParty } from "@/lib/ledger/merchant";
import type { PostSplit } from "@/lib/plaid/post";

/**
 * The liability engine — recognize a Plaid transaction as a loan/mortgage
 * payment and split it into principal / interest / escrow. The deterministic
 * counterpart to merchant categorization for the one entry type that is
 * inherently a computed split (2026-07 design session).
 *
 * IDENTITY: the loan is the economic object; the servicer is a label.
 * Matching is structural — funding account + amount band around the loan's
 * expected payment — never the payee name. Mortgages get sold (Wells → Mr.
 * Cooper → PennyMac…): the descriptor changes, the account and amount don't.
 * Every payee descriptor seen is learned into `payeeAliases`; a new one is
 * flagged as a probable servicer change in the decision log but never blocks
 * the post (automation-first; posts are one-click reversible).
 *
 * ESTIMATION is from CURRENT STATE, not origination data:
 *
 *     scheduled P&I = expectedPayment − monthlyEscrow      (fixed-rate ⇒ constant)
 *     interest      = GL liability balance × rate / 12     (balance as of txn date)
 *     principal     = scheduled P&I − interest
 *     escrow        = actual amount − scheduled P&I        (residual)
 *
 * Why the GL balance: it needs no origination data, survives refis and
 * servicer sales, and is self-damping — an interest misestimate moves the
 * booked balance, which moves the next month's interest the other way, and
 * the annual 1098 true-up zeroes any residue (owner: "optimize for automation;
 * within a few dollars is fine"). Verified against real Shellpoint statements:
 * penny-exact when the GL matches the servicer's principal.
 *
 * The escrow RESIDUAL is what makes annual escrow re-analysis a non-event: the
 * payment changes, P&I doesn't, so the split stays exact; the engine then
 * adopts the new amount + escrow as expected (recordLoanRecognition). Escrow
 * legs post to an EXPENSE account (owner decision: expense monthly, true up
 * at year end — no escrow asset accounting).
 *
 * GATES (owner's calibration: optimize for the loans we HAVE):
 *   - a loan with `expectedPaymentCents` set + funding/liability/interest
 *     links is CONFIGURED → recognized payments auto-post, first one included;
 *   - anything else (unknown lender, unconfigured loan, out-of-band amount,
 *     payment below P&I, escrow leg with no escrow account) falls through to
 *     the rules engine and, failing that, Review. New loans are rare here —
 *     configuring the loan row IS the one-time extra step.
 */

/** Band half-width around the expected payment: max($100, 15%). */
export function paymentBandCents(expectedPaymentCents: number): number {
  return Math.max(100_00, Math.round(expectedPaymentCents * 0.15));
}

export interface LiabilityTerms {
  /** Actual draft amount (positive cents). */
  amountCents: number;
  /** GL liability balance BEFORE this payment, positive cents. */
  balanceCents: number;
  annualRateBps: number;
  expectedPaymentCents: number;
  monthlyEscrowCents: number;
  /** Interest-only strategy (HELOC draw period, 0% forbearance): no principal leg. */
  interestOnly: boolean;
}

export interface LiabilitySplit {
  interestCents: number;
  principalCents: number;
  escrowCents: number;
}

/**
 * Pure split estimator (unit-tested in scripts/liability-engine.test.mts).
 * Returns null when the numbers don't describe a normal payment — the caller
 * treats that as "not recognized" and the txn goes to Review.
 */
export function estimateLiabilitySplit(t: LiabilityTerms): LiabilitySplit | null {
  if (t.interestOnly) {
    // Payment = interest (+ fixed escrow when configured). No balance math —
    // interest-only balances only move on draws/paydowns, which are out of
    // band by construction.
    const escrowCents = Math.min(Math.max(t.monthlyEscrowCents, 0), t.amountCents);
    const interestCents = t.amountCents - escrowCents;
    if (interestCents <= 0) return null;
    return { interestCents, principalCents: 0, escrowCents };
  }
  const scheduledPI = t.expectedPaymentCents - t.monthlyEscrowCents;
  // cents × bps / (10000 bps × 12 months)
  const interestCents = Math.round((t.balanceCents * t.annualRateBps) / 120_000);
  const principalCents = scheduledPI - interestCents;
  const escrowCents = t.amountCents - scheduledPI;
  if (interestCents <= 0) return null; // zero/negative balance or rate — misconfigured
  if (principalCents <= 0) return null; // interest exceeds P&I — negative amortization, human call
  if (escrowCents < 0) return null; // payment below scheduled P&I — partial payment, human call
  return { interestCents, principalCents, escrowCents };
}

export interface LoanSplitPlan {
  loanId: string;
  loanName: string;
  splits: PostSplit[];
  /** Normalized payee descriptor observed on this txn (learned as an alias). */
  payeeAlias: string | null;
  /** True when the payee is new for a loan that has known aliases. */
  servicerChanged: boolean;
  /** Set when the in-band amount differs from expected — the escrow-re-analysis
   * adoption recordLoanRecognition writes back. */
  adoptPaymentCents: number | null;
  adoptEscrowCents: number | null;
}

export interface LoanRefs {
  loan: Loan;
  /** bk account ids resolved from the loan's QBO links. */
  fundingBankId: string | null;
  liabilityId: string | null;
  interestId: string | null;
  escrowId: string | null;
}

/** Load this entity's loans with their QBO account links resolved to bk ids. */
export async function loadLoanRefs(entityId: string): Promise<LoanRefs[]> {
  const loans = await listLoans(entityId);
  if (!loans.length) return [];

  const accts = await db
    .select({
      id: schema.bkAccounts.id,
      qboId: schema.bkAccounts.qboAccountId,
    })
    .from(schema.bkAccounts)
    .where(eq(schema.bkAccounts.entityId, entityId));
  const bkByQbo = new Map(accts.map((a) => [a.qboId, a.id]));
  const resolve = (qbo: string | null) => (qbo ? bkByQbo.get(qbo) ?? null : null);

  return loans.map((loan) => ({
    loan,
    fundingBankId: resolve(loan.fundingAccountQboId),
    liabilityId: resolve(loan.liabilityAccountQboId),
    interestId: resolve(loan.interestAccountQboId),
    escrowId: resolve(loan.escrowAccountQboId),
  }));
}

/**
 * GL balance of a liability account STRICTLY BEFORE `dateISO` (positive cents
 * for a credit-balance liability). Date-based rather than posting-order-based,
 * so the estimate is deterministic however the sweep orders its work — but the
 * auto-poster still processes oldest-first so an earlier payment's principal
 * is booked before a later payment's interest is computed.
 */
export async function liabilityBalanceBefore(
  accountId: string,
  dateISO: string
): Promise<number> {
  const [row] = await db
    .select({
      net: sql<number>`COALESCE(SUM(${schema.bkJournalLines.creditCents} - ${schema.bkJournalLines.debitCents}), 0)::bigint`,
    })
    .from(schema.bkJournalLines)
    .innerJoin(
      schema.bkJournalEntries,
      eq(schema.bkJournalEntries.id, schema.bkJournalLines.entryId)
    )
    .where(
      and(
        eq(schema.bkJournalLines.accountId, accountId),
        lt(schema.bkJournalEntries.txnDate, dateISO)
      )
    );
  return Number(row?.net ?? 0);
}

interface CandidateTxn {
  amountCents: number; // Plaid sign: positive = outflow
  txnDate: string | Date;
  name: string | null;
  merchantName: string | null;
}

function txnYmdOf(txnDate: string | Date): string {
  return txnDate instanceof Date
    ? `${txnDate.getFullYear()}-${String(txnDate.getMonth() + 1).padStart(2, "0")}-${String(txnDate.getDate()).padStart(2, "0")}`
    : String(txnDate).slice(0, 10);
}

/** Stable normalized payee key: digits (trace numbers, dates) strip out, so the
 * same servicer's NACHA descriptor normalizes identically month over month. */
function payeeAliasOf(txn: CandidateTxn): string | null {
  const fromMerchant = normalizeMerchant(txn.merchantName);
  if (fromMerchant.length >= 3) return fromMerchant;
  const fromParty = normalizeMerchant(extractParty({ memo: txn.name }));
  if (fromParty.length >= 3) return fromParty;
  const raw = normalizeMerchant(txn.name);
  return raw.length >= 3 ? raw : null;
}

/**
 * Build the split plan for one txn against one entity's loans, or null if no
 * CONFIGURED loan recognizes it. `mappedBankId` is the bk account the txn's
 * Plaid account maps to (its bank side).
 */
export async function planLoanPayment(
  txn: CandidateTxn,
  mappedBankId: string | null,
  refs: LoanRefs[]
): Promise<LoanSplitPlan | null> {
  if (!mappedBankId) return null;
  if (txn.amountCents <= 0) return null; // must be money OUT
  const amount = txn.amountCents;

  // Structural candidates: configured loans funded from THIS account whose
  // band contains the amount. Ties (never seen in practice) go to the loan
  // whose expected payment is closest.
  const candidates = refs
    .filter((r) => {
      const { loan } = r;
      if (!r.fundingBankId || r.fundingBankId !== mappedBankId) return false;
      if (!r.liabilityId || !r.interestId) return false;
      if (loan.expectedPaymentCents == null) return false; // engine off for this loan
      if (!loan.interestOnly && loan.annualRateBps == null) return false;
      return Math.abs(amount - loan.expectedPaymentCents) <= paymentBandCents(loan.expectedPaymentCents);
    })
    .sort(
      (a, b) =>
        Math.abs(amount - a.loan.expectedPaymentCents!) -
        Math.abs(amount - b.loan.expectedPaymentCents!)
    );
  const r = candidates[0];
  if (!r) return null;
  const { loan } = r;

  const balanceCents = loan.interestOnly
    ? 0
    : await liabilityBalanceBefore(r.liabilityId!, txnYmdOf(txn.txnDate));

  const split = estimateLiabilitySplit({
    amountCents: amount,
    balanceCents,
    annualRateBps: loan.annualRateBps ?? 0,
    expectedPaymentCents: loan.expectedPaymentCents!,
    monthlyEscrowCents: loan.monthlyEscrowCents,
    interestOnly: loan.interestOnly,
  });
  if (!split) return null;
  if (split.escrowCents > 0 && !r.escrowId) return null; // escrow leg, nowhere to post it

  const payeeAlias = payeeAliasOf(txn);
  const knownAliases = loan.payeeAliases ?? [];
  const servicerChanged =
    !!payeeAlias && knownAliases.length > 0 && !knownAliases.includes(payeeAlias);

  // Escrow re-analysis adoption: an in-band amount change with P&I intact means
  // the escrow changed — adopt the new payment/escrow as expected going forward.
  const amountChanged = amount !== loan.expectedPaymentCents;

  return {
    loanId: loan.id,
    loanName: loan.name,
    splits: [
      { accountId: r.liabilityId!, amountCents: split.principalCents, memo: "principal" },
      { accountId: r.interestId!, amountCents: split.interestCents, memo: "interest" },
      ...(split.escrowCents > 0
        ? [{ accountId: r.escrowId!, amountCents: split.escrowCents, memo: "escrow (taxes & insurance)" }]
        : []),
    ].filter((s) => s.amountCents > 0),
    payeeAlias,
    servicerChanged,
    adoptPaymentCents: amountChanged ? amount : null,
    adoptEscrowCents: amountChanged ? split.escrowCents : null,
  };
}

/**
 * Post-recognition bookkeeping on the loan row: bump counters, learn the payee
 * alias, adopt an escrow-re-analysis payment change. Called by the auto-poster
 * AFTER the split posts successfully.
 */
export async function recordLoanRecognition(
  plan: LoanSplitPlan,
  txnDate: string | Date
): Promise<void> {
  const [loan] = await db
    .select({
      payeeAliases: schema.bkLoans.payeeAliases,
      recognizedCount: schema.bkLoans.recognizedCount,
    })
    .from(schema.bkLoans)
    .where(eq(schema.bkLoans.id, plan.loanId));
  if (!loan) return;

  const aliases = loan.payeeAliases ?? [];
  const nextAliases =
    plan.payeeAlias && !aliases.includes(plan.payeeAlias)
      ? [...aliases, plan.payeeAlias]
      : aliases;

  await db
    .update(schema.bkLoans)
    .set({
      payeeAliases: nextAliases,
      recognizedCount: loan.recognizedCount + 1,
      lastRecognizedDate: txnYmdOf(txnDate),
      ...(plan.adoptPaymentCents != null
        ? {
            expectedPaymentCents: plan.adoptPaymentCents,
            monthlyEscrowCents: plan.adoptEscrowCents ?? undefined,
          }
        : {}),
      updatedAt: new Date(),
    })
    .where(eq(schema.bkLoans.id, plan.loanId));
}
