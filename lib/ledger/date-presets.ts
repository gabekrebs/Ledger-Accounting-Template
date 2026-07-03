/**
 * Common P&L date-range presets, computed relative to "now". Returned as
 * YYYY-MM-DD start/end strings. The "all-time" preset carries no dates.
 */
export interface DatePreset {
  key: string;
  label: string;
  start?: string;
  end?: string;
}

function fmt(y: number, mZero: number, d: number): string {
  return `${y}-${String(mZero + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
function endOfMonth(y: number, mZero: number): number {
  return new Date(y, mZero + 1, 0).getDate();
}
function ymd(d: Date): string {
  return fmt(d.getFullYear(), d.getMonth(), d.getDate());
}
function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

export function datePresets(now: Date): DatePreset[] {
  const y = now.getFullYear();
  const m = now.getMonth(); // 0-11
  const today = new Date(y, m, now.getDate());
  const q = Math.floor(m / 3); // 0-3
  const lm = m === 0 ? { y: y - 1, m: 11 } : { y, m: m - 1 };
  const lq = q === 0 ? { y: y - 1, q: 3 } : { y, q: q - 1 };

  return [
    { key: "this-month", label: "This month", start: fmt(y, m, 1), end: fmt(y, m, endOfMonth(y, m)) },
    { key: "last-month", label: "Last month", start: fmt(lm.y, lm.m, 1), end: fmt(lm.y, lm.m, endOfMonth(lm.y, lm.m)) },
    { key: "last-30", label: "Last 30 days", start: ymd(addDays(today, -29)), end: ymd(today) },
    { key: "this-quarter", label: "This quarter", start: fmt(y, q * 3, 1), end: fmt(y, q * 3 + 2, endOfMonth(y, q * 3 + 2)) },
    { key: "last-quarter", label: "Last quarter", start: fmt(lq.y, lq.q * 3, 1), end: fmt(lq.y, lq.q * 3 + 2, endOfMonth(lq.y, lq.q * 3 + 2)) },
    { key: "ytd", label: "Year to date", start: fmt(y, 0, 1), end: ymd(today) },
    { key: "last-year", label: "Last year", start: fmt(y - 1, 0, 1), end: fmt(y - 1, 11, 31) },
    { key: "all", label: "All-time" },
  ];
}

/**
 * As-of date presets for the balance sheet (a point-in-time statement, so each
 * preset is a single date carried in `end`). "Latest" pins to the entity's most
 * recent posting; the rest are month/quarter/year-ends relative to `now`.
 */
export function bsDatePresets(now: Date, latest?: string): DatePreset[] {
  const y = now.getFullYear();
  const m = now.getMonth();
  const q = Math.floor(m / 3);
  const lm = m === 0 ? { y: y - 1, m: 11 } : { y, m: m - 1 };
  const lq = q === 0 ? { y: y - 1, q: 3 } : { y, q: q - 1 };
  const monthEnd = (yy: number, mZero: number) => fmt(yy, mZero, endOfMonth(yy, mZero));

  return [
    ...(latest ? [{ key: "latest", label: "Latest", end: latest }] : []),
    { key: "this-month", label: "This month-end", end: monthEnd(y, m) },
    { key: "last-month", label: "Last month-end", end: monthEnd(lm.y, lm.m) },
    { key: "this-quarter", label: "This quarter-end", end: monthEnd(y, q * 3 + 2) },
    { key: "last-quarter", label: "Last quarter-end", end: monthEnd(lq.y, lq.q * 3 + 2) },
    { key: "this-year", label: `Year-end ${y}`, end: fmt(y, 11, 31) },
    { key: "last-year", label: `Year-end ${y - 1}`, end: fmt(y - 1, 11, 31) },
  ];
}
