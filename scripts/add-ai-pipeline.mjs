/**
 * AI categorization pipeline schema (ADR-021) — the evidence ledger, merchant
 * intel cache, and calibrated auto-post buckets behind the Opus-based
 * suggestion system.
 *
 *   • bk_categorization_events gains the SUGGESTION-LIFECYCLE fields: what was
 *     suggested (account, payee, confidence, bucket, model, prompt version,
 *     evidence snapshot in `detail`) and what actually happened (outcome,
 *     posted account, decided_by/at). One row = one suggestion's life; the
 *     calibration job reads observed precision out of it.
 *   • bk_merchant_intel — one web-enriched profile per normalized merchant key,
 *     shared across every entity ("NW NATURAL → gas utility → Utilities").
 *   • bk_autopost_buckets — per-evidence-bucket measured precision + the
 *     shadow → unlocked → locked state machine that gates AI auto-posting.
 *   • bk_plaid_transactions gains suggested_payee + suggestion_bucket so the
 *     review UI and the post path can read them without recomputation.
 *
 * Direct ALTER (not drizzle-kit), matching the add-rules-engine precedent.
 * Idempotent — safe to re-run. Every new bk_ table ships with RLS enabled +
 * anon/authenticated revoked in the same migration (service role only).
 *
 * DEPLOYMENT ORDER: run this FIRST, then deploy the code that references the
 * new columns. ROLLBACK (only before that code ships):
 *   DROP TABLE IF EXISTS bk_merchant_intel, bk_autopost_buckets;
 *   ALTER TABLE bk_categorization_events
 *     DROP COLUMN IF EXISTS suggested_account_id, DROP COLUMN IF EXISTS posted_account_id,
 *     DROP COLUMN IF EXISTS merchant_key, DROP COLUMN IF EXISTS amount_cents,
 *     DROP COLUMN IF EXISTS bucket_key, DROP COLUMN IF EXISTS model,
 *     DROP COLUMN IF EXISTS prompt_version, DROP COLUMN IF EXISTS suggested_payee,
 *     DROP COLUMN IF EXISTS would_auto_post, DROP COLUMN IF EXISTS decided_at,
 *     DROP COLUMN IF EXISTS decided_by;
 *   ALTER TABLE bk_plaid_transactions
 *     DROP COLUMN IF EXISTS suggested_payee, DROP COLUMN IF EXISTS suggestion_bucket;
 *
 *   node scripts/add-ai-pipeline.mjs
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
  // ── bk_categorization_events: suggestion-lifecycle columns ────────────────
  await sql`ALTER TABLE bk_categorization_events
    ADD COLUMN IF NOT EXISTS suggested_account_id uuid REFERENCES bk_accounts(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS posted_account_id uuid REFERENCES bk_accounts(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS merchant_key text,
    ADD COLUMN IF NOT EXISTS amount_cents bigint,
    ADD COLUMN IF NOT EXISTS bucket_key text,
    ADD COLUMN IF NOT EXISTS model text,
    ADD COLUMN IF NOT EXISTS prompt_version text,
    ADD COLUMN IF NOT EXISTS suggested_payee text,
    ADD COLUMN IF NOT EXISTS would_auto_post boolean,
    ADD COLUMN IF NOT EXISTS decided_at timestamptz,
    ADD COLUMN IF NOT EXISTS decided_by text`;
  await sql`CREATE INDEX IF NOT EXISTS bk_categorization_events_bucket_idx
    ON bk_categorization_events (bucket_key, outcome)`;
  await sql`CREATE INDEX IF NOT EXISTS bk_categorization_events_merchant_idx
    ON bk_categorization_events (merchant_key)`;

  // ── bk_merchant_intel ──────────────────────────────────────────────────────
  // One row per normalized merchant key, portfolio-wide. `likely_category` is a
  // human-readable category CONCEPT ("Utilities"), never an entity account id —
  // intel is assistive context for the model, not an executable mapping.
  await sql`CREATE TABLE IF NOT EXISTS bk_merchant_intel (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_key text NOT NULL UNIQUE,
    display_name text,
    business_type text,
    likely_category text,
    notes text,
    source text NOT NULL DEFAULT 'web',
    confidence numeric,
    owner_category text,
    sample_raw text,
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now()
  )`;
  await sql`ALTER TABLE bk_merchant_intel ENABLE ROW LEVEL SECURITY`;
  await sql`REVOKE ALL ON bk_merchant_intel FROM anon, authenticated`;

  // ── bk_autopost_buckets ────────────────────────────────────────────────────
  // The state machine gating AI auto-posts. status: 'shadow' (measuring) →
  // 'unlocked' (≥98% precision over ≥50 outcomes) → 'locked' (one correction).
  // The calibration cron maintains counts; corrections lock synchronously.
  await sql`CREATE TABLE IF NOT EXISTS bk_autopost_buckets (
    bucket_key text PRIMARY KEY,
    status text NOT NULL DEFAULT 'shadow',
    outcomes integer NOT NULL DEFAULT 0,
    correct integer NOT NULL DEFAULT 0,
    measured_precision numeric,
    unlocked_at timestamptz,
    locked_at timestamptz,
    lock_reason text,
    updated_at timestamptz DEFAULT now()
  )`;
  await sql`ALTER TABLE bk_autopost_buckets ENABLE ROW LEVEL SECURITY`;
  await sql`REVOKE ALL ON bk_autopost_buckets FROM anon, authenticated`;

  // ── bk_plaid_transactions: suggested payee + bucket at suggestion time ────
  await sql`ALTER TABLE bk_plaid_transactions
    ADD COLUMN IF NOT EXISTS suggested_payee text,
    ADD COLUMN IF NOT EXISTS suggestion_bucket text`;
});

console.log("add-ai-pipeline: done");
await sql.end();
