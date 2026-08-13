/**
 * Durable rate-limit store table for RATE_LIMIT_BACKEND=postgres.
 *
 * Additive and idempotent. Creates ONLY `bk_rate_limits` — no existing table,
 * financial data, or behavior is touched. The app keeps using the in-memory
 * limiter until you set RATE_LIMIT_BACKEND=postgres.
 *
 * Security posture (matches ADR-007 — the app connects as the RLS-bypassing
 * `postgres`/service role, the public PostgREST roles get deny-all):
 *   - RLS enabled;
 *   - ALL access revoked from `anon` and `authenticated` (the internet-facing
 *     roles) — so the limiter table is never readable/writable via the public
 *     API;
 *   - no extra GRANTs: the app's `postgres` role already has exactly the
 *     SELECT/INSERT/UPDATE/DELETE it needs and nothing broader is granted.
 *
 * The table stores only a SALTED SHA-256 HASH of the identity (never a raw email
 * or full IP), a window bucket, a count, and a reset timestamp.
 *
 * DRY-RUN by default — prints the statements and exits WITHOUT connecting.
 *   node scripts/add-rate-limits.mjs            # show plan, change nothing
 *   node scripts/add-rate-limits.mjs --apply    # run it
 * After --apply: run `node scripts/rls-audit.mjs` (must report bk_rate_limits
 * NOT exposed).
 */
import { readFileSync } from "fs";
import postgres from "postgres";

const APPLY = process.argv.includes("--apply");

const STATEMENTS = [
  // Fixed-window counters. PK (key, window_start) makes the store's
  // INSERT … ON CONFLICT upsert atomic under concurrent requests.
  `CREATE TABLE IF NOT EXISTS bk_rate_limits (
     key          text        NOT NULL,   -- salted sha256 of policy+identity
     window_start bigint      NOT NULL,   -- floor(now / windowMs)
     count        integer     NOT NULL DEFAULT 0,
     reset_at     timestamptz NOT NULL,
     PRIMARY KEY (key, window_start)
   )`,

  // Supports the bounded cleanup of expired windows.
  `CREATE INDEX IF NOT EXISTS bk_rate_limits_reset_idx ON bk_rate_limits (reset_at)`,

  // RLS lockdown IN THIS MIGRATION (ADR-007). Deny-all to the public roles; the
  // app's postgres/service role bypasses RLS and keeps its inherent access.
  `ALTER TABLE bk_rate_limits ENABLE ROW LEVEL SECURITY`,
  `REVOKE ALL ON bk_rate_limits FROM anon, authenticated`,

  // Optional helper the owner (or a cron) can call to prune expired rows in bulk
  // — the store also prunes opportunistically, so this is just belt-and-braces.
  `CREATE OR REPLACE FUNCTION bk_rate_limits_prune() RETURNS bigint
     LANGUAGE sql AS $$
       WITH d AS (DELETE FROM bk_rate_limits WHERE reset_at < now() RETURNING 1)
       SELECT count(*) FROM d
     $$`,
  `REVOKE ALL ON FUNCTION bk_rate_limits_prune() FROM anon, authenticated`,
];

if (!APPLY) {
  console.log("DRY RUN — nothing will be changed. Statements that WOULD run:\n");
  STATEMENTS.forEach((s, i) =>
    console.log(`--- [${i + 1}/${STATEMENTS.length}] ---\n${s.trim()}\n`)
  );
  console.log("Re-run with --apply to execute. No connection was opened.");
  process.exit(0);
}

const url = readFileSync(".env.local", "utf8")
  .match(/^SUPABASE_DB_URL=(.*)$/m)[1]
  .trim()
  .replace(/^["']|["']$/g, "")
  .replace(/\\n$/, "");
// prepare:false — SUPABASE_DB_URL is the transaction pooler (PgBouncer), which
// doesn't support session-pinned prepared statements.
const sql = postgres(url, { ssl: "require", prepare: false });

for (let i = 0; i < STATEMENTS.length; i++) {
  await sql.unsafe(STATEMENTS[i]);
  console.log(`✓ [${i + 1}/${STATEMENTS.length}]`);
}

const [tbl] = await sql`
  SELECT c.relrowsecurity AS rls,
    (SELECT COUNT(*)::int FROM information_schema.role_table_grants
      WHERE table_name = 'bk_rate_limits' AND grantee IN ('anon','authenticated')) AS public_grants
  FROM pg_class c WHERE c.relname = 'bk_rate_limits'`;
console.log(`\nbk_rate_limits RLS: ${tbl?.rls} | public (anon/auth) grants: ${tbl?.public_grants} (want 0)`);
console.log("Done. Now run: node scripts/rls-audit.mjs");
await sql.end();
