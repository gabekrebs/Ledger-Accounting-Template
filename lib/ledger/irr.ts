/**
 * Money-weighted return (XIRR) on dated cash flows. Pure — no DB — so it can run
 * client-side in the returns hero, where the terminal equity value (and thus the
 * IRR) moves live with the cap-rate slider.
 *
 * Sign convention is the OWNER's: contributions are negative (cash they put in),
 * distributions and the terminal equity are positive (cash out / realizable).
 */
export interface DatedFlow {
  date: string; // YYYY-MM-DD
  amountCents: number;
}

const DAY_MS = 86_400_000;
const YEAR_DAYS = 365;

function npv(rate: number, flows: DatedFlow[], t0: number): number {
  let s = 0;
  for (const f of flows) {
    const yrs = (Date.parse(f.date) - t0) / (DAY_MS * YEAR_DAYS);
    s += f.amountCents / Math.pow(1 + rate, yrs);
  }
  return s;
}

/**
 * Annualized money-weighted return (Actual/365). Returns the rate (e.g. 0.213 =
 * 21.3%), or null if it can't be solved — fewer than two flows, no sign change
 * (all in or all out), or non-convergence.
 */
export function xirr(flows: DatedFlow[]): number | null {
  if (flows.length < 2) return null;
  const sorted = [...flows].sort((a, b) => (a.date < b.date ? -1 : 1));
  if (!sorted.some((f) => f.amountCents > 0)) return null;
  if (!sorted.some((f) => f.amountCents < 0)) return null;
  const t0 = Date.parse(sorted[0].date);

  // Newton's method from a 10% guess.
  let rate = 0.1;
  for (let i = 0; i < 100; i++) {
    const f = npv(rate, sorted, t0);
    const fp = (npv(rate + 1e-6, sorted, t0) - f) / 1e-6;
    if (!isFinite(fp) || fp === 0) break;
    const next = rate - f / fp;
    if (!isFinite(next)) break;
    if (Math.abs(next - rate) < 1e-9) return isFinite(next) ? next : null;
    rate = next;
  }

  // Bisection fallback on [-0.9999, 100] (needs a sign change to bracket a root).
  let lo = -0.9999;
  let hi = 100;
  let flo = npv(lo, sorted, t0);
  if (flo * npv(hi, sorted, t0) > 0) return null;
  for (let i = 0; i < 300; i++) {
    const mid = (lo + hi) / 2;
    const fm = npv(mid, sorted, t0);
    if (Math.abs(fm) < 1e-6) return mid;
    if (flo * fm < 0) hi = mid;
    else {
      lo = mid;
      flo = fm;
    }
  }
  const r = (lo + hi) / 2;
  return isFinite(r) ? r : null;
}
