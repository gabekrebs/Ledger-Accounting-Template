/**
 * `bk_review_holds` — owner heads-up holds for the review queue. A hold says
 * "a transaction like this is coming; keep it OUT of automation and in the
 * review queue" (exact amount and/or vendor text, per entity, for N days).
 * Holds never expire silently: they stay listed until the owner checks
 * "transaction found", so a miss can't fall through the cracks.
 *
 * Direct ALTER (not drizzle-kit), idempotent, RLS on + anon/authenticated
 * revoked in the same migration per the standing rule.
 *
 * DEPLOYMENT ORDER: run FIRST, then deploy the code. Additive. ROLLBACK
 * (before code ships): DROP TABLE IF EXISTS bk_review_holds;
 *
 *   node scripts/add-review-holds.mjs
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
  await sql`CREATE TABLE IF NOT EXISTS bk_review_holds (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_id uuid NOT NULL REFERENCES bk_ledger_entities(id) ON DELETE CASCADE,
    amount_cents bigint,
    amount_max_cents bigint,
    vendor_text text,
    note text,
    expires_at timestamptz NOT NULL,
    match_count integer NOT NULL DEFAULT 0,
    last_matched_txn_id uuid,
    last_matched_at timestamptz,
    acknowledged_at timestamptz,
    acknowledged_by text,
    created_by text,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT bk_review_holds_criteria_ck CHECK (amount_cents IS NOT NULL OR vendor_text IS NOT NULL)
  )`;
  // Range support (owner request 2026-08-06): amount_cents is the exact match
  // when amount_max_cents is null, else the inclusive lower bound.
  await sql`ALTER TABLE bk_review_holds ADD COLUMN IF NOT EXISTS amount_max_cents bigint`;
  await sql`CREATE INDEX IF NOT EXISTS bk_review_holds_open_idx ON bk_review_holds (entity_id) WHERE acknowledged_at IS NULL`;
  await sql`ALTER TABLE bk_review_holds ENABLE ROW LEVEL SECURITY`;
  await sql`REVOKE ALL ON bk_review_holds FROM anon, authenticated`;
});

console.log("bk_review_holds ready (RLS on, anon/authenticated revoked)");
await sql.end();
