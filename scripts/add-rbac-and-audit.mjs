/**
 * Phase 1 of role-based access + admin review.
 *
 * Adds, idempotently and additively (NO existing data is modified):
 *   1. bk_entity_access.access_level  — 'read' | 'write' (default 'read').
 *      Existing grants: there are currently ZERO rows, so nothing is backfilled;
 *      the DEFAULT only applies to future rows. "No access" is still the absence
 *      of a row.
 *   2. A permissive CHECK on bk_app_users.role so the new classification values
 *      are allowed WITHOUT rejecting the existing 'admin' row (kept as an owner
 *      alias until Phase 2 wires the role logic).
 *   3. bk_audit_log — the admin review log, with RLS enabled + anon/authenticated
 *      revoked in THIS migration (ADR-007).
 *
 * Safety: DRY-RUN by default — prints the exact statements and exits WITHOUT
 * connecting. Pass --apply to execute.
 *
 *   node scripts/add-rbac-and-audit.mjs            # show the plan, change nothing
 *   node scripts/add-rbac-and-audit.mjs --apply    # run it
 *
 * After --apply: run `node scripts/rls-audit.mjs` (must report bk_audit_log NOT
 * exposed), then re-run it after any later schema change.
 */
import { readFileSync } from "fs";
import postgres from "postgres";

const APPLY = process.argv.includes("--apply");

// Each statement is idempotent (IF NOT EXISTS / guarded DO blocks), so re-running
// is safe. Ordered: column → constraints → table → indexes → RLS lockdown.
const STATEMENTS = [
  // 1. Per-entity access level. Absence of a row = no access (unchanged).
  `ALTER TABLE bk_entity_access
     ADD COLUMN IF NOT EXISTS access_level text NOT NULL DEFAULT 'read'`,

  `DO $$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bk_entity_access_level_ck') THEN
       ALTER TABLE bk_entity_access
         ADD CONSTRAINT bk_entity_access_level_ck CHECK (access_level IN ('read','write'));
     END IF;
   END $$`,

  // 2. Permissive role constraint — superset includes the legacy 'admin'/'member'
  //    values so the existing row validates; new values are owner/accountant/
  //    business_partner. Phase 2 normalizes 'admin' → 'owner' in code.
  `DO $$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bk_app_users_role_ck') THEN
       ALTER TABLE bk_app_users
         ADD CONSTRAINT bk_app_users_role_ck
         CHECK (role IN ('owner','admin','accountant','business_partner','member'));
     END IF;
   END $$`,

  // 3. Admin review log. Append-only in practice; only the review flags are
  //    updated. entity_id FK cascades with its entity (consistent with siblings).
  `CREATE TABLE IF NOT EXISTS bk_audit_log (
     id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     actor_email     text        NOT NULL,
     actor_role      text        NOT NULL,
     entity_id       uuid        NOT NULL REFERENCES bk_ledger_entities(id) ON DELETE CASCADE,
     action_type     text        NOT NULL,
     object_table    text,
     object_id       text,
     description     text        NOT NULL,
     before_json     jsonb,
     after_json      jsonb,
     affected_ledger boolean     NOT NULL DEFAULT false,
     created_at      timestamptz NOT NULL DEFAULT now(),
     reviewed        boolean     NOT NULL DEFAULT false,
     reviewed_at     timestamptz,
     reviewed_by     text
   )`,

  // Grouping unreviewed items by entity, and the global unreviewed feed/count.
  `CREATE INDEX IF NOT EXISTS bk_audit_log_entity_reviewed_idx
     ON bk_audit_log (entity_id, reviewed)`,
  `CREATE INDEX IF NOT EXISTS bk_audit_log_reviewed_created_idx
     ON bk_audit_log (reviewed, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS bk_audit_log_actor_idx
     ON bk_audit_log (actor_email)`,

  // RLS lockdown IN THIS MIGRATION (ADR-007): the app uses the RLS-bypassing
  // postgres/service role; the public PostgREST roles get deny-all.
  `ALTER TABLE bk_audit_log ENABLE ROW LEVEL SECURITY`,
  `REVOKE ALL ON bk_audit_log FROM anon, authenticated`,
];

if (!APPLY) {
  console.log("DRY RUN — nothing will be changed. Statements that WOULD run:\n");
  STATEMENTS.forEach((s, i) => console.log(`--- [${i + 1}/${STATEMENTS.length}] ---\n${s.trim()}\n`));
  console.log("Re-run with --apply to execute. No connection was opened.");
  process.exit(0);
}

const url = readFileSync(".env.local", "utf8")
  .match(/^SUPABASE_DB_URL=(.*)$/m)[1]
  .trim()
  .replace(/^["']|["']$/g, "")
  .replace(/\\n$/, "");
const sql = postgres(url, { ssl: "require" });

for (let i = 0; i < STATEMENTS.length; i++) {
  await sql.unsafe(STATEMENTS[i]);
  console.log(`✓ [${i + 1}/${STATEMENTS.length}]`);
}

// Verify (read-only) — column present, table present + locked down.
const [col] = await sql`
  SELECT 1 FROM information_schema.columns
  WHERE table_name = 'bk_entity_access' AND column_name = 'access_level'`;
const [tbl] = await sql`
  SELECT c.relrowsecurity AS rls,
    (SELECT COUNT(*) FROM information_schema.role_table_grants
      WHERE table_name = 'bk_audit_log' AND grantee IN ('anon','authenticated'))::int AS public_grants
  FROM pg_class c WHERE c.relname = 'bk_audit_log'`;
console.log(`\naccess_level column present: ${!!col}`);
console.log(`bk_audit_log RLS enabled: ${tbl?.rls} | public (anon/auth) grants: ${tbl?.public_grants} (want 0)`);
console.log("Done. Now run: node scripts/rls-audit.mjs");
await sql.end();
