/**
 * Utility tracker (owner request 2026-07-30): entities whose long-term
 * tenants don't pay their own utilities
 * get a Utilities tab summarizing what the owner covers, sourced straight
 * from the Plaid staging feed. Table-driven so no entity facts live in code:
 *
 *   bk_utility_groups   — one section per building ("SE 36th"), with the
 *                         tracking start date (e.g. when the
 *                         buildings were fully long-term).
 *   bk_utility_matchers — (group, category, bank account, descriptor
 *                         fragment): a Plaid txn on that account whose raw
 *                         name contains the fragment counts toward the
 *                         category. `optional` categories (garbage) render
 *                         behind an include/exclude toggle.
 *
 * The bank ACCOUNT is the address discriminator — pay each building's
 * utilities from its own checking account, so identical PGE descriptors
 * split cleanly. Seeds are idempotent (unique keys + on conflict do nothing).
 *
 * Idempotent — safe to re-run.   node scripts/add-utility-tracker.mjs
 */
import { readFileSync } from "fs";
import postgres from "postgres";

const env = readFileSync(".env.local", "utf8");
const url = env
  .match(/^SUPABASE_DB_URL=(.*)$/m)[1]
  .trim()
  .replace(/^["']|["']$/g, "");
const sql = postgres(url, { ssl: "require", max: 1 });

await sql`CREATE TABLE IF NOT EXISTS bk_utility_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id uuid NOT NULL REFERENCES bk_ledger_entities(id) ON DELETE CASCADE,
  name text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  tracking_start date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entity_id, name)
)`;
await sql`CREATE TABLE IF NOT EXISTS bk_utility_matchers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid NOT NULL REFERENCES bk_utility_groups(id) ON DELETE CASCADE,
  category text NOT NULL,
  match_contains text NOT NULL,
  plaid_account_id uuid NOT NULL REFERENCES bk_plaid_accounts(id) ON DELETE CASCADE,
  optional boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (group_id, category, match_contains)
)`;
await sql`CREATE INDEX IF NOT EXISTS bk_utility_matchers_group_idx ON bk_utility_matchers (group_id)`;

// Security posture: RLS on, API roles revoked — same as every bk_* table.
for (const t of ["bk_utility_groups", "bk_utility_matchers"]) {
  await sql`ALTER TABLE ${sql(t)} ENABLE ROW LEVEL SECURITY`;
  await sql`REVOKE ALL ON ${sql(t)} FROM anon, authenticated`;
}

// No seed data ships with the template. Create groups/matchers for your own
// buildings via SQL, e.g.:
//   INSERT INTO bk_utility_groups (entity_id, name) VALUES ('<entity-uuid>', '123 Main St');
//   INSERT INTO bk_utility_matchers (group_id, bank_account_id, category, match_contains)
//     VALUES ('<group-uuid>', '<plaid-account-uuid>', 'water', 'city of springfield');

console.log("add-utility-tracker: done");
await sql.end();
