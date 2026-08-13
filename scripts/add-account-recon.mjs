/**
 * Manual balance checkpoints for the Reconciliation view — `bk_account_recon`.
 *
 * Additive and idempotent. Creates ONLY `bk_account_recon` — no existing table,
 * financial data, or behavior is touched. One row per "the real statement/portal
 * showed balance X on date D" assertion for accounts with no Plaid feed
 * (non-mortgage loans, unlinked bank/credit-card accounts). Append-only; the
 * view reads the most-recent as_of_date row per account. The journal is never
 * involved — a checkpoint is an observation about the outside world, not a
 * posting.
 *
 * Security posture (matches ADR-007 — the app connects as the RLS-bypassing
 * `postgres`/service role, the public PostgREST roles get deny-all):
 *   - RLS enabled;
 *   - ALL access revoked from `anon` and `authenticated` (the internet-facing
 *     roles) — so balance history is never readable/writable via the public
 *     API;
 *   - no extra GRANTs: the app's `postgres` role already has exactly the
 *     SELECT/INSERT it needs and nothing broader is granted.
 *
 * DRY-RUN by default — prints the statements and exits WITHOUT connecting.
 *   node scripts/add-account-recon.mjs            # show plan, change nothing
 *   node scripts/add-account-recon.mjs --apply    # run it
 * After --apply: run `node scripts/rls-audit.mjs` (must report bk_account_recon
 * NOT exposed).
 */
import { readFileSync } from "fs";
import postgres from "postgres";

const APPLY = process.argv.includes("--apply");

const STATEMENTS = [
  // No FKs on purpose: entity_id/account_qbo_id identify a historical
  // observation, and history should survive account/entity churn.
  `CREATE TABLE IF NOT EXISTS bk_account_recon (
     id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
     entity_id            uuid        NOT NULL,
     account_qbo_id       text        NOT NULL,   -- GL route key (bk_accounts.qbo_account_id)
     as_of_date           date        NOT NULL,
     actual_balance_cents bigint      NOT NULL,   -- NATURAL sign (loan owed = positive)
     note                 text,
     created_by           text,
     created_at           timestamptz NOT NULL DEFAULT now()
   )`,

  // "Latest checkpoint per account" is the only read path.
  `CREATE INDEX IF NOT EXISTS bk_account_recon_lookup_idx
     ON bk_account_recon (entity_id, account_qbo_id, as_of_date DESC)`,

  // RLS lockdown IN THIS MIGRATION (ADR-007). Deny-all to the public roles; the
  // app's postgres/service role bypasses RLS and keeps its inherent access.
  `ALTER TABLE bk_account_recon ENABLE ROW LEVEL SECURITY`,
  `REVOKE ALL ON bk_account_recon FROM anon, authenticated`,
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
      WHERE table_name = 'bk_account_recon' AND grantee IN ('anon','authenticated')) AS public_grants
  FROM pg_class c WHERE c.relname = 'bk_account_recon'`;
console.log(`\nbk_account_recon RLS: ${tbl?.rls} | public (anon/auth) grants: ${tbl?.public_grants} (want 0)`);
console.log("Done. Now run: node scripts/rls-audit.mjs");
await sql.end();
