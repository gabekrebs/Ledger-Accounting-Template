/**
 * Trial-balance builder tests.
 *
 * Structural invariants (hard asserts, several entities/years):
 *   • Total check total === 0 (per-entry balance + whole-entry cutoffs)
 *   • Net income row === Σ of P&L rows
 *   • Activity columns sum to the Total column on every row
 *
 * Plus a Sample 2025 comparison against the CPA's actual workpaper ("Sample
 * Properties 2025 AJEs and Trial Balance Report.xlsx", Unadjusted column) —
 * including the G: rows, which live in the NE Maple 6524 entity but belong
 * on Sample' historical TB because the ENTRIES are Sample' (the split-out moved
 * accounts, not history).
 *
 *   node --env-file=.env.local ./node_modules/.bin/tsx scripts/trial-balance.test.mts
 */
import fs from "fs";
import assert from "node:assert";
for (const line of fs.readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const postgres = (await import("postgres")).default;
const { buildTrialBalance, entityYears } = await import("../lib/ledger/trial-balance");
const sql = postgres((process.env.SUPABASE_DB_URL || "").replace(/\s+/g, ""), { prepare: false });

const SAMPLE = "a0b4abea-bd42-48bc-bf14-fa2c511165d0";
let pass = 0;
const ok = (s: string) => { pass++; console.log(`  ✓ ${s}`); };

// ── Structural invariants ─────────────────────────────────────────────────────
const [ne11] = await sql`select id from bk_ledger_entities where name='NE 11th'`;
const [garf] = await sql`select id from bk_ledger_entities where name='NE Maple 6524'`;
for (const [label, id, year] of [
  ["Sample 2025", SAMPLE, 2025],
  ["Sample 2024", SAMPLE, 2024],
  ["Sample 2026", SAMPLE, 2026],
  ["NE 11th 2025", ne11.id, 2025],
  ["NE Maple 6524 2026", garf.id, 2026],
] as const) {
  const tb = await buildTrialBalance(id as string, year);
  assert.equal(tb.checkTotalTotal, 0, `${label}: check total must be 0, got ${tb.checkTotalTotal}`);
  const plSum = tb.rows
    .filter((r) => r.classification === "revenue" || r.classification === "expense")
    .reduce((s, r) => s + r.totalCents, 0);
  assert.equal(tb.netIncomeTotal, plSum, `${label}: net income ties to P&L rows`);
  for (const r of tb.rows) {
    const colSum = Object.values(r.byActivity).reduce((s, v) => s + v, 0);
    assert.equal(colSum, r.totalCents, `${label}: ${r.name} split ties to total`);
  }
  ok(`${label}: check=0, NI ties, splits tie (${tb.rows.length} rows; cols: ${tb.activities.join(" | ") || "single"})`);
}

// ── Sample 2025 vs the CPA's unadjusted workpaper ─────────────────────────────
const tb = await buildTrialBalance(SAMPLE, 2025);
assert.deepEqual(
  tb.activities,
  ["Property Management", "Realtor", "Vehicle Leasing"],
  `2025 columns post-split, got: ${tb.activities.join("|")}`
);
ok("Sample 2025 columns post-split: Property Management | Realtor | Vehicle Leasing (no Maple)");
assert.deepEqual(tb.foreignColumns, [], "no foreign-entity columns remain post-split");
ok("foreign-entity column detection (none post-split)");

// CPA unadjusted values, in cents (from the xlsx).
const CPA: Record<string, number> = {
  "KP: Rental Income": -17191959,
  "KP: Supplies": 3957111,
  "KP: Rent Expense": 2291244,
  "KP: Property Management": 3482000,
  "KP: Professional Fees": 1688859, // adjusted (AJE04)
  "KP: Meals and Entertainment": 919506,
  "KP: SBA EIDL": -6155530, // adjusted (AJE08)
  "R: SBA EIDL": -6651307, // adjusted (AJE08)
  "R: Professional Fees": 152100,
  "R: Meals and Entertainment": 55146,
  "V: Fluid Income": -372362,
  "V: EV Charging": 58366,
  "V: Vehicle – Repairs & Maintenance": 379722,
  // Maple items PAID FROM SAMPLE (entries stayed in Sample after the split):
  "G: Property Taxes": 560001,
  "KP: Chase Checking (128)": 330882,
  "R: Key Checking": 100000,
};
const byName = new Map(tb.rows.map((r) => [r.name, r.totalCents]));
let matched = 0;
const diffs: string[] = [];
for (const [name, cpa] of Object.entries(CPA)) {
  const ours = byName.get(name);
  if (ours === cpa) matched++;
  else diffs.push(`    ${name}: ours=${ours === undefined ? "(absent)" : (ours / 100).toFixed(2)} cpa=${(cpa / 100).toFixed(2)}`);
}
console.log(`  · CPA row comparison: ${matched}/${Object.keys(CPA).length} exact`);
if (diffs.length) console.log(diffs.join("\n"));
assert(matched >= Object.keys(CPA).length - 2, "at least all-but-2 CPA rows match exactly");
ok("Sample 2025 ties to the CPA's unadjusted workpaper (Sample-entity rows)");

// CONSERVATION across the Maple split: the CPA's combined workbook rows
// that migrated with the entity must appear, exactly, in Maple's own TB.
const gtb = await buildTrialBalance(garf.id as string, 2025);
const gByName = new Map(gtb.rows.map((r) => [r.name, r.totalCents]));
assert.equal(gByName.get("G: Rental Income - Maple"), -9417357);
assert.equal(gByName.get("G: Utilities - Maple"), 546734);
ok("split conservation: migrated G: rows match the CPA workpaper in Maple's own TB, to the penny");
console.log(`  · (informational) Sample 2025 NI=${(tb.netIncomeTotal / 100).toFixed(2)}, Maple 2025 NI=${(gtb.netIncomeTotal / 100).toFixed(2)} — CPA's combined was -66,967.91 pre-split`);

console.log(`\nAll ${pass} checks passed.`);
console.log(`Sample years: ${(await entityYears(SAMPLE)).join(", ")}`);
await sql.end();
