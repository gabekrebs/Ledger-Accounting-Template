/**
 * `bk_account_recon_state` — sync-observation memory for the Reconciliation
 * view. One row per Plaid-mapped ledger account: when was the book-vs-bank
 * residual last within tolerance, and if it currently isn't, when did that
 * streak start. Lets the status pill show "settling" for young residuals
 * (pending-charge timing the system self-corrects) and reserve the amber
 * "Off by" for discrepancies that persist past the grace window.
 *
 * Direct ALTER (not drizzle-kit), matching the bk_account_recon precedent.
 * Idempotent — safe to re-run. Per the standing RLS rule: RLS enabled +
 * anon/authenticated revoked in the same migration (service-role reads only).
 *
 * DEPLOYMENT ORDER: run this FIRST, then deploy the code that references the
 * table. Additive only. ROLLBACK (before that code ships):
 *   DROP TABLE IF EXISTS bk_account_recon_state;
 * The table is pure derived state — dropping or truncating it loses nothing
 * that observations don't rebuild.
 *
 *   node scripts/add-recon-state.mjs
 */
import { readFileSync } from "fs";
import postgres from "postgres";

const env = readFileSync(".env.local", "utf8");
const url = env
  .match(/^SUPABASE_DB_URL=(.*)$/m)[1]
  .trim()
  .replace(/^["']|["']$/g, "")
  .replace(/\\n$/, "");
const sql = postgres(url, { ssl: "require", max: 1 });

await sql.begin(async (sql) => {
  await sql`CREATE TABLE IF NOT EXISTS bk_account_recon_state (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_id uuid NOT NULL REFERENCES bk_ledger_entities(id) ON DELETE CASCADE,
    account_id uuid NOT NULL UNIQUE REFERENCES bk_accounts(id) ON DELETE CASCADE,
    off_since timestamptz,
    last_in_sync_at timestamptz,
    last_residual_cents bigint NOT NULL DEFAULT 0,
    updated_at timestamptz NOT NULL DEFAULT now()
  )`;
  await sql`ALTER TABLE bk_account_recon_state ENABLE ROW LEVEL SECURITY`;
  await sql`REVOKE ALL ON bk_account_recon_state FROM anon, authenticated`;
});

console.log("bk_account_recon_state ready (RLS on, anon/authenticated revoked)");
await sql.end();
