/**
 * Bank reconciliation schema — `bk_reconciliations` + a nullable
 * `reconciliation_id` mark on `bk_journal_lines`.
 *
 * A reconciliation is the statement-tie workflow for ONE bank / credit-card
 * account: statement end date + statement ending balance, lines checked off
 * until the cleared balance matches to the penny. A line's `reconciliation_id`
 * is its cleared mark; `ON DELETE SET NULL` means cancelling/undoing a
 * reconciliation releases its lines.
 *
 * Direct ALTER (not drizzle-kit), matching the bk_journal_lines.location /
 * valuation precedent. Idempotent — safe to re-run.
 *
 * Per the standing RLS rule (simply-vrm/bookkeeping-security-rls.md): every new
 * bk_ table ships with RLS enabled + anon/authenticated revoked in the same
 * migration (the app reads via the service role only).
 *
 *   node scripts/add-reconciliation.mjs
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

await sql`CREATE TABLE IF NOT EXISTS bk_reconciliations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id uuid NOT NULL REFERENCES bk_ledger_entities(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES bk_accounts(id) ON DELETE CASCADE,
  statement_date date NOT NULL,
  statement_balance_cents bigint NOT NULL,
  beginning_balance_cents bigint NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'in_progress',
  notes text,
  created_by text,
  created_at timestamptz DEFAULT now(),
  completed_at timestamptz
)`;

await sql`CREATE INDEX IF NOT EXISTS bk_reconciliations_entity_idx
  ON bk_reconciliations (entity_id)`;
await sql`CREATE INDEX IF NOT EXISTS bk_reconciliations_account_date_idx
  ON bk_reconciliations (account_id, statement_date)`;
// One open reconciliation per account, DB-enforced.
await sql`CREATE UNIQUE INDEX IF NOT EXISTS bk_reconciliations_one_open_uq
  ON bk_reconciliations (account_id) WHERE status = 'in_progress'`;

await sql`ALTER TABLE bk_journal_lines
  ADD COLUMN IF NOT EXISTS reconciliation_id uuid
  REFERENCES bk_reconciliations(id) ON DELETE SET NULL`;

// Authorship for in-product entries (manual JEs). Imports leave it null.
await sql`ALTER TABLE bk_journal_entries
  ADD COLUMN IF NOT EXISTS created_by text`;
await sql`CREATE INDEX IF NOT EXISTS bk_journal_lines_reconciliation_idx
  ON bk_journal_lines (reconciliation_id) WHERE reconciliation_id IS NOT NULL`;

// Standing security rule: RLS on + no anon/authenticated grants on new bk_ tables.
await sql`ALTER TABLE bk_reconciliations ENABLE ROW LEVEL SECURITY`;
await sql`REVOKE ALL ON bk_reconciliations FROM anon, authenticated`;

const [{ rls }] = await sql`SELECT relrowsecurity AS rls FROM pg_class
  WHERE relname = 'bk_reconciliations'`;
const cols = await sql`SELECT column_name FROM information_schema.columns
  WHERE table_name = 'bk_journal_lines' AND column_name = 'reconciliation_id'`;
console.log("bk_reconciliations created, RLS =", rls);
console.log("bk_journal_lines.reconciliation_id =", cols.length === 1 ? "present" : "MISSING");

await sql.end();
