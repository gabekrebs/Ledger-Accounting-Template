import { datePresets, type DatePreset } from "./date-presets";

/**
 * Single source of truth for "which period is the P&L showing" — shared by the
 * P&L statement and its drill-down so they always agree on dates, labels, and
 * the active-chip state. Pure (takes `now` in) so it's trivially testable.
 *
 * Selection precedence mirrors the original P&L page:
 *   custom start+end  >  ?year=YYYY | ?year=all  >  default (current year).
 */
export interface PlPeriod {
  presets: DatePreset[];
  /** {start,end} when a custom range or a year is active; {} for all-time. */
  opts: { start?: string; end?: string };
  /** "YYYY" | "all" | null (null when a custom range is active). */
  activeYear: string | null;
  customRange: { start: string; end: string } | null;
  /** Key of the matching preset chip, if the active range equals one. */
  activePreset?: string;
  periodLabel: string;
  currentYear: number;
}

export function resolvePlPeriod(
  sp: { year?: string; start?: string; end?: string },
  now: Date
): PlPeriod {
  const presets = datePresets(now);
  const currentYear = now.getFullYear();
  const customRange = sp.start && sp.end ? { start: sp.start, end: sp.end } : null;
  const activeYear = customRange
    ? null
    : sp.year === "all"
      ? "all"
      : (sp.year ?? String(currentYear));

  const opts: { start?: string; end?: string } = customRange
    ? customRange
    : activeYear && activeYear !== "all"
      ? { start: `${activeYear}-01-01`, end: `${activeYear}-12-31` }
      : {};

  const activePreset = customRange
    ? presets.find((p) => p.start === customRange.start && p.end === customRange.end)?.key
    : activeYear === "all"
      ? "all"
      : undefined;

  const periodLabel = customRange
    ? `${customRange.start} → ${customRange.end}`
    : activeYear === "all"
      ? "All-time"
      : `Year ${activeYear}`;

  return { presets, opts, activeYear, customRange, activePreset, periodLabel, currentYear };
}

/** The range params (for a URL) that reproduce the current selection. */
export function rangeParams(p: Pick<PlPeriod, "customRange" | "activeYear">): Record<string, string> {
  if (p.customRange) return { start: p.customRange.start, end: p.customRange.end };
  if (p.activeYear && p.activeYear !== "all") return { year: p.activeYear };
  return { year: "all" };
}

// ── Comparison periods (QuickBooks "compare to") ────────────────────────────
export type CompareMode = "prior-period" | "prior-year";

export const COMPARE_LABEL: Record<CompareMode, string> = {
  "prior-period": "Prior period",
  "prior-year": "Prior year",
};

function parse(d: string): { y: number; m: number; d: number } {
  const [y, m, day] = d.split("-").map(Number);
  return { y, m, d: day };
}
function pad(n: number): string {
  return String(n).padStart(2, "0");
}
function fmt(y: number, m: number, d: number): string {
  return `${y}-${pad(m)}-${pad(d)}`;
}
/** Last day of 1-based month `m` in year `y`. */
function lastDay(y: number, m: number): number {
  return new Date(y, m, 0).getDate();
}
function ymd(dt: Date): string {
  return fmt(dt.getFullYear(), dt.getMonth() + 1, dt.getDate());
}

/**
 * Resolve the comparison range for the given primary range. Returns null when
 * the primary range is open-ended (all-time) — there's nothing to compare to.
 *
 * - prior-year: the same calendar window, one year earlier (Feb-29 clamped).
 * - prior-period: the immediately-preceding period of equal length. When the
 *   range is whole-calendar-month aligned (the common case: a full year, a
 *   quarter, a month) it shifts back by that many calendar months, so a full
 *   year compares to the full prior year and a month to the prior month. For an
 *   arbitrary range (e.g. YTD), it falls back to an equal-length day window
 *   ending the day before the start.
 */
export function comparisonRange(
  opts: { start?: string; end?: string },
  mode: CompareMode
): { start: string; end: string; shortLabel: string } | null {
  if (!opts.start || !opts.end) return null;
  const s = parse(opts.start);
  const e = parse(opts.end);

  if (mode === "prior-year") {
    const sd = Math.min(s.d, lastDay(s.y - 1, s.m));
    const ed = Math.min(e.d, lastDay(e.y - 1, e.m));
    return {
      start: fmt(s.y - 1, s.m, sd),
      end: fmt(e.y - 1, e.m, ed),
      shortLabel: COMPARE_LABEL["prior-year"],
    };
  }

  // prior-period
  const monthAligned = s.d === 1 && e.d === lastDay(e.y, e.m);
  if (monthAligned) {
    const span = e.y * 12 + (e.m - 1) - (s.y * 12 + (s.m - 1)) + 1; // inclusive months
    const back = (y: number, m1: number, n: number) => {
      const idx = y * 12 + (m1 - 1) - n;
      return { y: Math.floor(idx / 12), m: (idx % 12) + 1 };
    };
    const ns = back(s.y, s.m, span);
    const ne = back(e.y, e.m, span);
    return {
      start: fmt(ns.y, ns.m, 1),
      end: fmt(ne.y, ne.m, lastDay(ne.y, ne.m)),
      shortLabel: COMPARE_LABEL["prior-period"],
    };
  }

  // YTD range (Jan 1 to some mid-year date): prior period = same span in prior year.
  if (s.m === 1 && s.d === 1) {
    return {
      start: fmt(s.y - 1, 1, 1),
      end: fmt(e.y - 1, e.m, Math.min(e.d, lastDay(e.y - 1, e.m))),
      shortLabel: COMPARE_LABEL["prior-period"],
    };
  }

  const sDate = new Date(s.y, s.m - 1, s.d);
  const eDate = new Date(e.y, e.m - 1, e.d);
  const days = Math.round((eDate.getTime() - sDate.getTime()) / 86400000) + 1;
  const priorEnd = new Date(sDate);
  priorEnd.setDate(priorEnd.getDate() - 1);
  const priorStart = new Date(priorEnd);
  priorStart.setDate(priorStart.getDate() - (days - 1));
  return { start: ymd(priorStart), end: ymd(priorEnd), shortLabel: COMPARE_LABEL["prior-period"] };
}

/**
 * The comparison as-of date for a balance sheet (a point-in-time snapshot, so a
 * single date rather than a range).
 * - prior-year: the same date one year earlier (Feb-29 clamped).
 * - prior-period: the previous comparable snapshot — a year-end (Dec 31) → the
 *   prior year-end; any other month-end → the prior month-end; an arbitrary day
 *   → the same day in the prior month (clamped). This makes the "2025" year chip
 *   compare to year-end 2024, and a month-end snapshot to the prior month-end.
 */
export function bsComparisonDate(
  asOf: string,
  mode: CompareMode
): { date: string; shortLabel: string } | null {
  if (!asOf) return null;
  const s = parse(asOf);
  if (mode === "prior-year") {
    return {
      date: fmt(s.y - 1, s.m, Math.min(s.d, lastDay(s.y - 1, s.m))),
      shortLabel: COMPARE_LABEL["prior-year"],
    };
  }
  // prior-period
  if (s.m === 12 && s.d === 31) {
    return { date: fmt(s.y - 1, 12, 31), shortLabel: COMPARE_LABEL["prior-period"] };
  }
  const pm = s.m === 1 ? { y: s.y - 1, m: 12 } : { y: s.y, m: s.m - 1 };
  const day = s.d === lastDay(s.y, s.m) ? lastDay(pm.y, pm.m) : Math.min(s.d, lastDay(pm.y, pm.m));
  return { date: fmt(pm.y, pm.m, day), shortLabel: COMPARE_LABEL["prior-period"] };
}
