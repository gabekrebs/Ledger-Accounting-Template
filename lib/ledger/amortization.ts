/**
 * Fixed-rate, fully-amortizing loan math. Pure functions, integer cents.
 * Used by the mortgage calculator now and (Phase 6b) to auto-post payment
 * splits once the entity is off QuickBooks.
 */

export interface LoanTerms {
  originalPrincipalCents: number;
  annualRateBps: number; // 6.5% = 650
  termMonths: number;
  firstPaymentDate: string; // YYYY-MM-DD
  monthlyPaymentCents?: number | null; // P&I; computed if absent
  monthlyEscrowCents?: number;
}

export interface AmortRow {
  period: number;
  date: string;
  paymentCents: number; // principal + interest (excludes escrow)
  interestCents: number;
  principalCents: number;
  escrowCents: number;
  balanceCents: number;
}

export interface AmortSummary {
  paymentCents: number; // monthly P&I
  totalInterestCents: number;
  totalPaidCents: number;
  payoffDate: string | null;
  periods: number;
}

/** Standard amortizing P&I payment for the given terms. */
export function computePaymentCents(
  principalCents: number,
  annualRateBps: number,
  termMonths: number
): number {
  if (termMonths <= 0) return principalCents;
  const r = annualRateBps / 10000 / 12;
  if (r === 0) return Math.round(principalCents / termMonths);
  const f = Math.pow(1 + r, termMonths);
  return Math.round((principalCents * r * f) / (f - 1));
}

function addMonths(firstPaymentDate: string, n: number): string {
  const [y, m, d] = firstPaymentDate.split("-").map(Number);
  const dt = new Date(y, m - 1 + n, d);
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const dd = String(dt.getDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

/** Full amortization schedule. Final period absorbs rounding so balance → 0. */
export function amortize(terms: LoanTerms): AmortRow[] {
  const r = terms.annualRateBps / 10000 / 12;
  const payment =
    terms.monthlyPaymentCents ??
    computePaymentCents(
      terms.originalPrincipalCents,
      terms.annualRateBps,
      terms.termMonths
    );
  const escrow = terms.monthlyEscrowCents ?? 0;
  let balance = terms.originalPrincipalCents;
  const rows: AmortRow[] = [];

  for (let p = 1; p <= terms.termMonths && balance > 0; p++) {
    const interest = Math.round(balance * r);
    let principal = payment - interest;
    if (principal <= 0) break; // payment can't cover interest → non-amortizing
    if (principal > balance) principal = balance; // last payment
    balance -= principal;
    rows.push({
      period: p,
      date: addMonths(terms.firstPaymentDate, p - 1),
      paymentCents: principal + interest,
      interestCents: interest,
      principalCents: principal,
      escrowCents: escrow,
      balanceCents: balance,
    });
  }
  return rows;
}

export function summarize(terms: LoanTerms): AmortSummary {
  const rows = amortize(terms);
  const totalInterestCents = rows.reduce((s, x) => s + x.interestCents, 0);
  const totalPrincipalCents = rows.reduce((s, x) => s + x.principalCents, 0);
  return {
    paymentCents:
      terms.monthlyPaymentCents ??
      computePaymentCents(
        terms.originalPrincipalCents,
        terms.annualRateBps,
        terms.termMonths
      ),
    totalInterestCents,
    totalPaidCents: totalInterestCents + totalPrincipalCents,
    payoffDate: rows.length ? rows[rows.length - 1].date : null,
    periods: rows.length,
  };
}

/** Scheduled remaining balance as of a date (interpolated to the last due payment). */
export function scheduledBalanceAsOf(terms: LoanTerms, asOf: string): number {
  const rows = amortize(terms);
  let bal = terms.originalPrincipalCents;
  for (const r of rows) {
    if (r.date > asOf) break;
    bal = r.balanceCents;
  }
  return bal;
}

// ---------------------------------------------------------------------------
// Current-state amortization — preferred path for new / refinanced loans.
//
// Instead of needing the original principal + origination date + full term,
// this builds a schedule from the CURRENT GL balance forward. This is more
// accurate after a refi (you don't need to know what the original terms were)
// and simpler to configure (just enter remaining months + current rate).
// ---------------------------------------------------------------------------

export interface CurrentLoanTerms {
  currentBalanceCents: number; // live GL balance
  annualRateBps: number;       // current rate (6.5% = 650)
  remainingTermMonths: number; // months left as of asOfDate
  monthlyPaymentCents?: number | null;
  monthlyEscrowCents?: number;
  asOfDate: string;            // YYYY-MM-DD — first payment lands in the next month
}

export function amortizeFromNow(terms: CurrentLoanTerms): AmortRow[] {
  const r = terms.annualRateBps / 10000 / 12;
  const payment =
    terms.monthlyPaymentCents ??
    computePaymentCents(terms.currentBalanceCents, terms.annualRateBps, terms.remainingTermMonths);
  const escrow = terms.monthlyEscrowCents ?? 0;
  let balance = terms.currentBalanceCents;
  const rows: AmortRow[] = [];

  // First payment is the month after asOfDate
  const [y, mo, d] = terms.asOfDate.split("-").map(Number);
  const firstPayment = new Date(y, mo, d); // month index +1 = next month
  const firstPaymentIso = `${firstPayment.getFullYear()}-${String(firstPayment.getMonth() + 1).padStart(2, "0")}-${String(firstPayment.getDate()).padStart(2, "0")}`;

  for (let p = 1; p <= terms.remainingTermMonths && balance > 0; p++) {
    const interest = r === 0 ? 0 : Math.round(balance * r);
    let principal = payment - interest;
    if (principal <= 0) break;
    if (principal > balance) principal = balance;
    balance -= principal;
    rows.push({
      period: p,
      date: addMonths(firstPaymentIso, p - 1),
      paymentCents: principal + interest,
      interestCents: interest,
      principalCents: principal,
      escrowCents: escrow,
      balanceCents: balance,
    });
  }
  return rows;
}

export function summarizeFromNow(terms: CurrentLoanTerms): AmortSummary {
  const rows = amortizeFromNow(terms);
  const totalInterestCents = rows.reduce((s, x) => s + x.interestCents, 0);
  const totalPrincipalCents = rows.reduce((s, x) => s + x.principalCents, 0);
  const payment =
    terms.monthlyPaymentCents ??
    computePaymentCents(terms.currentBalanceCents, terms.annualRateBps, terms.remainingTermMonths);
  return {
    paymentCents: payment,
    totalInterestCents,
    totalPaidCents: totalInterestCents + totalPrincipalCents,
    payoffDate: rows.length ? rows[rows.length - 1].date : null,
    periods: rows.length,
  };
}
