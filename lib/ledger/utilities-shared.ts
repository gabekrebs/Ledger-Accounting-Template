/**
 * Utility-tracker shapes + averaging math — PURE and client-safe (the
 * Utilities tab's garbage toggle recomputes averages in the browser, and the
 * unit tests exercise every branch without a database).
 *
 * Semantics (owner decisions 2026-07-30):
 *   • A month's figure is the sum of PAYMENTS that posted in it (Plaid
 *     payment date, not the statement's usage month — lumpy quarters, e.g.
 *     water, average out over time).
 *   • Averages use COMPLETED months only: the in-progress month shows in the
 *     table but never dilutes an average.
 *   • "Calendar year" = completed months of the current LA year;
 *     "rolling" = the last 12 completed months (identical until the tracker
 *     has crossed a year boundary — the UI says so).
 *   • Optional categories (garbage) are excluded/included by the toggle;
 *     total = Σ visible categories, so the math stays exact in cents.
 */

export type UtilityCategory = { name: string; optional: boolean };

export type UtilityMonthRow = {
  month: string; // 'YYYY-MM-01'
  /** net cents paid per category name (refunds subtract) */
  cells: Record<string, number>;
  /** current LA month — displayed, never averaged */
  inProgress: boolean;
};

export type UtilityGroupReport = {
  id: string;
  name: string;
  trackingStart: string;
  categories: UtilityCategory[];
  months: UtilityMonthRow[];
};

/** 'YYYY-MM-01' for any ISO date string. */
export function utilityMonthKey(d: string): string {
  return `${d.slice(0, 7)}-01`;
}

/** 'YYYY-MM-01' shifted by delta calendar months. */
export function utilityShiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1 + delta, 1)).toISOString().slice(0, 10);
}

/** 'YYYY-MM-01' → "Jan 2026" for table rows. */
export function utilityMonthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-US", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** Inclusive ascending month keys start → end (empty when start > end). */
export function utilityMonthSpan(start: string, end: string): string[] {
  const out: string[] = [];
  for (let m = utilityMonthKey(start); m <= end; m = utilityShiftMonth(m, 1)) out.push(m);
  return out;
}

export type UtilityAverage = {
  /** months included (completed only); 0 ⇒ no average to show */
  monthCount: number;
  perCategory: Record<string, number>; // average cents / month
  totalCents: number; // average of the visible total
};

/**
 * Average over a set of rows for the visible categories. Total is derived
 * from the same unrounded sums so toggling a category never desyncs the
 * columns from the total.
 */
export function utilityAverage(
  rows: UtilityMonthRow[],
  categories: UtilityCategory[],
  includeOptional: boolean
): UtilityAverage {
  const visible = categories.filter((c) => includeOptional || !c.optional);
  const done = rows.filter((r) => !r.inProgress);
  const perCategory: Record<string, number> = {};
  let total = 0;
  for (const c of visible) {
    const sum = done.reduce((s, r) => s + (r.cells[c.name] ?? 0), 0);
    perCategory[c.name] = done.length ? Math.round(sum / done.length) : 0;
    total += sum;
  }
  return {
    monthCount: done.length,
    perCategory,
    totalCents: done.length ? Math.round(total / done.length) : 0,
  };
}

/** Completed months of the current LA year (calendar-year window). */
export function calendarYearRows(rows: UtilityMonthRow[], laMonth: string): UtilityMonthRow[] {
  const year = laMonth.slice(0, 4);
  return rows.filter((r) => !r.inProgress && r.month.startsWith(year));
}

/** The last 12 completed months (rolling window). */
export function rollingRows(rows: UtilityMonthRow[]): UtilityMonthRow[] {
  return rows.filter((r) => !r.inProgress).slice(-12);
}
