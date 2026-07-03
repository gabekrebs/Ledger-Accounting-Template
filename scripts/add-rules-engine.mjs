/**
 * Categorization rules-engine schema — `bk_rules`, `bk_categorization_events`,
 * `bk_rule_edits`, plus `review_reason` / `matched_rule_id` marks on
 * `bk_plaid_transactions`.
 *
 * The deterministic, user-authored categorization layer that becomes the long-
 * term spine: prioritized rules (global → canonical keys, entity → concrete
 * accounts) decide categorization; only `auto_apply` rules post unattended; every
 * decision is logged to `bk_categorization_events`; every rule change is logged to
 * `bk_rule_edits` (mirrors `bk_journal_edits`).
 *
 * Direct ALTER (not drizzle-kit), matching the bk_reconciliations / journal-edits
 * precedent. Idempotent — safe to re-run.
 *
 * Per the standing RLS rule (simply-vrm/bookkeeping-security-rls.md): every new
 * bk_ table ships with RLS enabled + anon/authenticated revoked in the same
 * migration (the app reads via the service role only).
 *
 * DEPLOYMENT ORDER: run this migration FIRST, confirm it succeeds, THEN deploy the
 * application code (rule pages, cron, importer reference these tables/columns). All
 * statements run in ONE transaction (Postgres DDL is transactional), so a failure
 * mid-run rolls back entirely — the schema never ends up half-applied.
 *
 * RE-RUN / RECOVERY: idempotent (CREATE TABLE / ADD COLUMN IF NOT EXISTS), so a
 * re-run after any failure simply completes the migration. ROLLBACK (only before
 * code referencing these objects ships): the additions are isolated, so
 * `DROP TABLE IF EXISTS bk_rule_edits, bk_categorization_events, bk_rules CASCADE;
 *  ALTER TABLE bk_plaid_transactions DROP COLUMN IF EXISTS review_reason,
 *  DROP COLUMN IF EXISTS matched_rule_id;` reverts it. Verify against a disposable
 * DB first (incl. a second run to confirm idempotency).
 *
 *   node scripts/add-rules-engine.mjs
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

// All schema changes run in ONE transaction (Postgres DDL is transactional), so
// a partial failure rolls back cleanly — never a table created without its RLS /
// REVOKE. Still idempotent (IF NOT EXISTS), so a re-run is a safe no-op.
await sql.begin(async (sql) => {

// ── bk_rules ───────────────────────────────────────────────────────────────
// scope='global' ⇔ entity_id IS NULL. Global rules target canonical keys
// (resolved per-entity); entity rules target concrete accounts and override
// global. Only enabled+active+auto_apply rules post unattended.
await sql`CREATE TABLE IF NOT EXISTS bk_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope text NOT NULL,
  entity_id uuid REFERENCES bk_ledger_entities(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  enabled boolean NOT NULL DEFAULT true,
  auto_apply boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active',
  origin text NOT NULL DEFAULT 'manual',
  rank integer NOT NULL DEFAULT 100,
  predicate jsonb NOT NULL,
  action jsonb NOT NULL,
  proposed_from_txn_id uuid,
  applied_count integer NOT NULL DEFAULT 0,
  corrected_count integer NOT NULL DEFAULT 0,
  confirmed_count integer NOT NULL DEFAULT 0,
  last_applied_at timestamptz,
  created_by text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  CONSTRAINT bk_rules_scope_entity_ck CHECK ((scope = 'global') = (entity_id IS NULL))
)`;
await sql`CREATE INDEX IF NOT EXISTS bk_rules_scope_enabled_status_idx
  ON bk_rules (scope, enabled, status)`;
await sql`CREATE INDEX IF NOT EXISTS bk_rules_entity_idx ON bk_rules (entity_id)`;
await sql`CREATE INDEX IF NOT EXISTS bk_rules_origin_status_idx
  ON bk_rules (origin, status)`;

// ── bk_categorization_events ─────────────────────────────────────────────────
// Append-only decision log: every categorization decision (auto-post, proposal,
// manual apply, skip…) with its source + confidence + reason. Also the
// fingerprint→learner feed. FKs SET NULL so a rule/entry delete never erases the
// audit trail.
await sql`CREATE TABLE IF NOT EXISTS bk_categorization_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id uuid REFERENCES bk_ledger_entities(id) ON DELETE CASCADE,
  plaid_txn_id uuid REFERENCES bk_plaid_transactions(id) ON DELETE SET NULL,
  journal_entry_id uuid REFERENCES bk_journal_entries(id) ON DELETE SET NULL,
  rule_id uuid REFERENCES bk_rules(id) ON DELETE SET NULL,
  decision_source text NOT NULL,
  outcome text NOT NULL,
  action_kind text,
  confidence numeric,
  reason text,
  detail jsonb,
  created_by text,
  created_at timestamptz DEFAULT now()
)`;
await sql`CREATE INDEX IF NOT EXISTS bk_categorization_events_entity_idx
  ON bk_categorization_events (entity_id, created_at)`;
await sql`CREATE INDEX IF NOT EXISTS bk_categorization_events_txn_idx
  ON bk_categorization_events (plaid_txn_id)`;
await sql`CREATE INDEX IF NOT EXISTS bk_categorization_events_rule_idx
  ON bk_categorization_events (rule_id)`;
await sql`CREATE INDEX IF NOT EXISTS bk_categorization_events_entry_idx
  ON bk_categorization_events (journal_entry_id)`;

// ── bk_rule_edits ─────────────────────────────────────────────────────────────
// Append-only rule-change audit, one row per field changed (mirrors
// bk_journal_edits). old_value/new_value are JSON-stringified text.
await sql`CREATE TABLE IF NOT EXISTS bk_rule_edits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id uuid NOT NULL REFERENCES bk_rules(id) ON DELETE CASCADE,
  entity_id uuid,
  field text NOT NULL,
  old_value text,
  new_value text,
  edited_at timestamptz DEFAULT now(),
  edited_by text
)`;
await sql`CREATE INDEX IF NOT EXISTS bk_rule_edits_rule_idx ON bk_rule_edits (rule_id)`;

// ── bk_plaid_transactions marks ──────────────────────────────────────────────
// review_reason: why a txn is waiting (e.g. "fingerprint proposal: 6/6 → Utilities").
// matched_rule_id: the rule the last sweep matched (null when none / fingerprint).
// Additive for existing installs (confirmed_count post-dates the first migration).
await sql`ALTER TABLE bk_rules
  ADD COLUMN IF NOT EXISTS confirmed_count integer NOT NULL DEFAULT 0`;
await sql`ALTER TABLE bk_plaid_transactions
  ADD COLUMN IF NOT EXISTS review_reason text`;
await sql`ALTER TABLE bk_plaid_transactions
  ADD COLUMN IF NOT EXISTS matched_rule_id uuid
  REFERENCES bk_rules(id) ON DELETE SET NULL`;

// ── Standing security rule: RLS on + no anon/authenticated grants ────────────
for (const t of ["bk_rules", "bk_categorization_events", "bk_rule_edits"]) {
  await sql.unsafe(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`);
  await sql.unsafe(`REVOKE ALL ON ${t} FROM anon, authenticated`);
}
}); // commit the migration transaction (all-or-nothing)

// Verify the committed result — read-only, outside the transaction.
const rls = await sql`SELECT relname, relrowsecurity AS rls FROM pg_class
  WHERE relname IN ('bk_rules','bk_categorization_events','bk_rule_edits')
  ORDER BY relname`;
const cols = await sql`SELECT column_name FROM information_schema.columns
  WHERE table_name = 'bk_plaid_transactions'
    AND column_name IN ('review_reason','matched_rule_id')
  ORDER BY column_name`;
for (const r of rls) console.log(`${r.relname} created, RLS = ${r.rls}`);
console.log(
  "bk_plaid_transactions marks =",
  cols.length === 2 ? "present" : `MISSING (${cols.map((c) => c.column_name).join(",")})`
);

await sql.end();
