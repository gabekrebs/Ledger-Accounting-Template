/** Pure-logic tests for heads-up hold matching (no db opened; dummy URL). 
 *   SUPABASE_DB_URL=postgres://u:p@127.0.0.1:5432/none npx tsx scripts/holds.test.mts
 */
import { holdMatches } from "../lib/plaid/holds";

let fail = 0;
const eq = (got: boolean, want: boolean, label: string) => {
  if (got !== want) { fail++; console.error(`✗ ${label}`); } else console.log(`✓ ${label}`);
};
const txn = (name: string, merchant: string | null, cents: number) => ({ name, merchantName: merchant, amountCents: cents });

eq(holdMatches({ amountCents: 14282, amountMaxCents: null, vendorText: null }, txn("THE HOME DEPOT #4014", "Home Depot", 14282)), true, "amount-only exact match");
eq(holdMatches({ amountCents: 14282, amountMaxCents: null, vendorText: null }, txn("THE HOME DEPOT #4014", "Home Depot", -14282)), true, "amount matches |inflow|");
eq(holdMatches({ amountCents: 14282, amountMaxCents: null, vendorText: null }, txn("x", null, 14283)), false, "amount off by a cent → no");
eq(holdMatches({ amountCents: null, amountMaxCents: null, vendorText: "home depot" }, txn("THE HOME DEPOT #4014", null, 999)), true, "vendor-only, case-insensitive vs raw name");
eq(holdMatches({ amountCents: null, amountMaxCents: null, vendorText: "Home Depot" }, txn("HD 4014", "The Home Depot", 999)), true, "vendor matches cleaned merchant name");
eq(holdMatches({ amountCents: null, amountMaxCents: null, vendorText: "lowes" }, txn("THE HOME DEPOT", "Home Depot", 999)), false, "vendor mismatch → no");
eq(holdMatches({ amountCents: 5000, amountMaxCents: null, vendorText: "depot" }, txn("THE HOME DEPOT", null, 5000)), true, "both criteria, both match");
eq(holdMatches({ amountCents: 5000, amountMaxCents: null, vendorText: "depot" }, txn("THE HOME DEPOT", null, 4999)), false, "both criteria, amount fails → no");
eq(holdMatches({ amountCents: 5000, amountMaxCents: null, vendorText: "lowes" }, txn("THE HOME DEPOT", null, 5000)), false, "both criteria, vendor fails → no");
eq(holdMatches({ amountCents: null, amountMaxCents: null, vendorText: "  " }, txn("anything", null, 1)), false, "criterion-less hold never matches");

/* range matching */
eq(holdMatches({ amountCents: 10000, amountMaxCents: 30000, vendorText: null }, txn("x", null, 20000)), true, "range: inside");
eq(holdMatches({ amountCents: 10000, amountMaxCents: 30000, vendorText: null }, txn("x", null, -10000)), true, "range: |inflow| at lower bound inclusive");
eq(holdMatches({ amountCents: 10000, amountMaxCents: 30000, vendorText: null }, txn("x", null, 30000)), true, "range: upper bound inclusive");
eq(holdMatches({ amountCents: 10000, amountMaxCents: 30000, vendorText: null }, txn("x", null, 30001)), false, "range: above max → no");
eq(holdMatches({ amountCents: 10000, amountMaxCents: 30000, vendorText: null }, txn("x", null, 9999)), false, "range: below min → no");
eq(holdMatches({ amountCents: 10000, amountMaxCents: 30000, vendorText: "depot" }, txn("HOME DEPOT", null, 20000)), true, "range + vendor both match");
eq(holdMatches({ amountCents: 10000, amountMaxCents: 30000, vendorText: "lowes" }, txn("HOME DEPOT", null, 20000)), false, "range ok but vendor fails → no");

if (fail) { console.error(`${fail} failures`); process.exit(1); }
console.log("all hold-matching tests passed");
process.exit(0);
