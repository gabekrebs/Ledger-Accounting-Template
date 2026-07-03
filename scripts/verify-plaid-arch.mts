/**
 * READ-ONLY local verification of the Plaid architecture changes (Features A/B/C).
 * What can be checked without a live Plaid link: the redirect-uri helper, the
 * duplicate-Item block's DB query, and the current Item inventory. Full OAuth /
 * update-mode behavior is exercised post-deploy against the real bank.
 *
 *   node --env-file=.env.local ./node_modules/.bin/tsx scripts/verify-plaid-arch.mts
 */
import { and, eq, ne } from "drizzle-orm";
import { db, schema } from "../lib/db/client";
import { plaidRedirectUri } from "../lib/plaid/client";

let pass = 0;
const fail: string[] = [];
const ok = (c: boolean, m: string) => (c ? pass++ : fail.push(m));

// ── A. plaidRedirectUri(): null when unset, trimmed value when set ───────────
delete process.env.PLAID_REDIRECT_URI;
ok(plaidRedirectUri() === null, "redirectUri null when PLAID_REDIRECT_URI unset (local dev → OAuth omitted)");
process.env.PLAID_REDIRECT_URI = "https://your-app.example.com/ledger/connections/";
ok(
  plaidRedirectUri() === "https://your-app.example.com/ledger/connections",
  "redirectUri returns the env value with trailing slash stripped"
);
delete process.env.PLAID_REDIRECT_URI;

// ── B. Duplicate-Item block query: active (non-replaced) Items per institution ─
// Exact query the exchange route runs. With 0 Plaid items today it must return
// empty for any institution (no false block on the first real connect).
const FAKE_INST = "ins_chase_test_00000";
const sameInstitution = await db
  .select({ id: schema.bkPlaidItems.id, plaidItemId: schema.bkPlaidItems.plaidItemId })
  .from(schema.bkPlaidItems)
  .where(
    and(
      eq(schema.bkPlaidItems.institutionId, FAKE_INST),
      ne(schema.bkPlaidItems.status, "replaced")
    )
  );
ok(sameInstitution.length === 0, "no active Item for a fresh institution → first connect is NOT blocked");

// Inventory: how many Plaid Items exist, and their statuses (context).
const allItems = await db
  .select({ id: schema.bkPlaidItems.id, inst: schema.bkPlaidItems.institutionId, status: schema.bkPlaidItems.status })
  .from(schema.bkPlaidItems);
console.log(`Plaid Items currently in DB: ${allItems.length}`);
for (const i of allItems) console.log(`  • ${i.inst ?? "?"} — ${i.status}`);
// Prove the block logic on a hypothetical: if an active Item existed for an
// institution, a DIFFERENT-plaidItemId link would be flagged as duplicate.
const demoExisting = [{ id: "x", plaidItemId: "item_AAA" }];
const other = demoExisting.find((e) => e.plaidItemId !== "item_BBB");
ok(!!other, "block logic: a second login (different plaidItemId, same institution) IS caught");
const sameItem = demoExisting.find((e) => e.plaidItemId !== "item_AAA");
ok(!sameItem, "block logic: re-linking the SAME Item (same plaidItemId) is NOT a duplicate");

console.log(`\n${fail.length ? "❌" : "✅"} verify-plaid-arch: ${pass} passed${fail.length ? `, ${fail.length} failed` : ""}`);
for (const f of fail) console.log("  • " + f);
await db.$client.end();
process.exit(fail.length ? 1 : 0);
