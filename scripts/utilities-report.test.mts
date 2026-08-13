/**
 * Utility-tracker pure math (lib/ledger/utilities-shared.ts) — month spans,
 * completed-month windows, and the optional-category (garbage) toggle.
 *
 *   npx tsx scripts/utilities-report.test.mts
 */
import {
  calendarYearRows,
  rollingRows,
  utilityAverage,
  utilityMonthKey,
  utilityMonthSpan,
  utilityShiftMonth,
  type UtilityCategory,
  type UtilityMonthRow,
} from "../lib/ledger/utilities-shared";

let passed = 0;
const fails: string[] = [];
function ok(cond: boolean, name: string) {
  if (cond) passed++;
  else fails.push(name);
}

ok(utilityMonthKey("2026-07-30") === "2026-07-01", "month key normalizes to the 1st");
ok(utilityShiftMonth("2026-12-01", 1) === "2027-01-01", "shift crosses the year");
ok(
  utilityMonthSpan("2026-01-01", "2026-03-01").join(",") ===
    "2026-01-01,2026-02-01,2026-03-01",
  "span is inclusive and ascending"
);
ok(utilityMonthSpan("2026-05-01", "2026-03-01").length === 0, "inverted span is empty");

const CATS: UtilityCategory[] = [
  { name: "Electric", optional: false },
  { name: "Garbage", optional: true },
];
const row = (month: string, elec: number, garb: number, inProgress = false): UtilityMonthRow => ({
  month,
  cells: { Electric: elec, Garbage: garb },
  inProgress,
});
const rows = [
  row("2026-01-01", 10000, 5000),
  row("2026-02-01", 20000, 0),
  row("2026-03-01", 30000, 5000, true), // in progress — display only
];

{
  const a = utilityAverage(rows, CATS, true);
  ok(a.monthCount === 2, "in-progress month never averaged");
  ok(a.perCategory.Electric === 15000, "per-category average over completed months");
  ok(a.totalCents === 17500, "total = avg of (electric + garbage)");
}
{
  const a = utilityAverage(rows, CATS, false);
  ok(a.perCategory.Garbage === undefined, "excluded category has no column");
  ok(a.totalCents === 15000, "toggle removes optional cents from the total");
}
{
  // Rounding stays coherent: total derives from unrounded sums.
  const odd = [row("2026-01-01", 1, 1), row("2026-02-01", 0, 0)];
  const a = utilityAverage(odd, CATS, true);
  ok(a.totalCents === 1, "total rounds the combined sum, not the rounded parts");
}

{
  // Nov '25 → Dec '26, with Dec '26 the running month (as the builder marks it).
  const span = [
    row("2025-11-01", 1, 0),
    row("2025-12-01", 2, 0),
    ...Array.from({ length: 12 }, (_, i) =>
      row(utilityShiftMonth("2026-01-01", i), 3, 0, i === 11)
    ),
  ];
  const cal = calendarYearRows(span, "2027-01-01");
  ok(cal.length === 0, "calendar window is the CURRENT LA year only");
  const cal26 = calendarYearRows(span, "2026-12-01");
  ok(
    cal26.length === 11 && cal26.every((r) => r.month.startsWith("2026")),
    "calendar window: completed 2026 months"
  );
  const rol = rollingRows(span);
  ok(rol.length === 12, "rolling window caps at 12 completed months");
  ok(rol[0].month === "2025-12-01", "rolling window keeps the most recent 12");
}

if (fails.length) {
  console.error(`✗ ${fails.length} failed:\n  ` + fails.join("\n  "));
  process.exit(1);
}
console.log(`✓ all ${passed} utility-tracker tests passed`);
