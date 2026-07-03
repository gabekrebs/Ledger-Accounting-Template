/**
 * Portfolio canonical chart-of-accounts mapping report. For every ledger entity,
 * resolve each canonical key to the entity's best existing account and flag the
 * CORE (`ensure`) keys that have no home.
 *   npx tsx scripts/canonical-coa-report.mts            # report only (read-only)
 *   npx tsx scripts/canonical-coa-report.mts --ensure   # CREATE missing core accounts (live)
 * Untracked / build-unsafe by intent.
 */
import fs from "fs";
for (const line of fs.readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].replace(/^"|"$/g, "").replace(/\\n$/, "");
}
const ENSURE = process.argv.includes("--ensure");

const { db } = await import("../lib/db/client");
const { bkLedgerEntities } = await import("../lib/db/schema");
const { asc } = await import("drizzle-orm");
const { CANONICAL, resolveCanonicalAccounts, ensureCanonicalAccounts } = await import("../lib/ledger/canonical-accounts");

const CORE = CANONICAL.filter((d) => d.ensure).map((d) => d.key);
const ents = await db.select({ id: bkLedgerEntities.id, name: bkLedgerEntities.name }).from(bkLedgerEntities).orderBy(asc(bkLedgerEntities.name));

let totalGaps = 0, totalCreated = 0, holding = 0;
for (const e of ents) {
  const resolved = await resolveCanonicalAccounts(e.id);
  // An entity is an operating rental if it already has the headline rental
  // operating accounts (management/cleaning). Pure holding cos don't — never
  // clutter them with rental-income/cleaning/property-tax accounts.
  const isOperating = resolved.has("expense.management") || resolved.has("expense.cleaning");
  const gaps = CORE.filter((k) => !resolved.has(k));
  console.log(`\n### ${e.name}${isOperating ? "" : "   (holding — no ensure)"}`);
  for (const d of CANONICAL) {
    const r = resolved.get(d.key);
    const core = d.ensure ? "" : " ·optional";
    console.log(`   ${d.key.padEnd(22)} → ${r ? `${r.name} [${r.qboAccountId}]` : (d.ensure ? "⚠️  MISSING (core)" : "—")}${core}`);
  }
  if (!isOperating) { holding++; continue; }
  if (gaps.length) { totalGaps += gaps.length; console.log(`   GAPS (core, would create): ${gaps.join(", ")}`); }
  // Deliberate sweep creates ONLY Property Taxes: it's the one canonical account
  // with no lazy trigger (it's paid via the bank feed + categorized by the AI, so
  // it must pre-exist). Income channels / hospitality / other are created on
  // demand by the owner-payout recognizer when a real payout uses them.
  if (ENSURE && !resolved.has("expense.property_tax")) {
    const { created } = await ensureCanonicalAccounts(e.id, ["expense.property_tax"], { live: true });
    totalCreated += created.length;
    if (created.length) console.log(`   ✅ created: Property Taxes`);
  }
}
console.log(`\n${ENSURE ? `✅ created Property Taxes on ${totalCreated} operating entities (${holding} holding cos skipped)` : `${totalGaps} core gaps across operating entities (${holding} holding cos skipped); --ensure creates Property Taxes where missing`}`);
process.exit(0);
