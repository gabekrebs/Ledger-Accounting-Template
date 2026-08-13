/**
 * Purge bank-PENDING rows from the staging inbox (owner request 2026-07-21):
 * pending charges change amounts / get cancelled at the bank and must not
 * appear anywhere in the system (Wave/QuickBooks behavior). sync.ts no longer
 * stores them; this removes the ones already staged.
 *
 * Only `status = 'pending_review'` rows are deleted — a posted/already_booked
 * row is settled money in the journal and is never touched (post.ts has always
 * refused to post a pending row, so none should exist; the status guard makes
 * that structural). Each settled version re-arrives from Plaid under its own
 * transaction_id, so nothing real is lost.
 *
 * Idempotent — safe to re-run.   node scripts/purge-bank-pending-rows.mjs
 */
import { readFileSync } from "fs";
import postgres from "postgres";

const env = readFileSync(".env.local", "utf8");
const url = env
  .match(/^SUPABASE_DB_URL=(.*)$/m)[1]
  .trim()
  .replace(/^["']|["']$/g, "");
const sql = postgres(url, { ssl: "require", max: 1 });

const posted = await sql`SELECT count(*)::int AS n FROM bk_plaid_transactions
  WHERE pending AND status <> 'pending_review'`;
if (posted[0].n > 0) {
  // Should be impossible (post.ts refuses pending rows) — surface, don't touch.
  console.warn(`⚠ ${posted[0].n} pending row(s) with a non-review status were LEFT ALONE:`);
  const rows = await sql`SELECT plaid_transaction_id, status, txn_date, name, amount_cents
    FROM bk_plaid_transactions WHERE pending AND status <> 'pending_review'`;
  for (const r of rows) console.warn(`  ${r.status} ${r.txn_date} ${r.name} ${r.amount_cents}¢ ${r.plaid_transaction_id}`);
}

const deleted = await sql`DELETE FROM bk_plaid_transactions
  WHERE pending AND status = 'pending_review'
  RETURNING txn_date, name, amount_cents`;
console.log(`Deleted ${deleted.length} staged bank-pending row(s).`);
for (const r of deleted) console.log(`  ${r.txn_date} ${r.name} ${r.amount_cents}¢`);

await sql.end();
