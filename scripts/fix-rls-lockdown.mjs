/**
 * SECURITY FIX — lock down every public table to the service role only.
 *
 * Findings (verified via scripts/rls-audit.mjs against project your-project-ref):
 * 20 of 23 public tables had RLS DISABLED while the internet-facing anon /
 * authenticated PostgREST roles held full DML grants — i.e. anyone with the
 * project's public anon key could read AND write all bookkeeping, Plaid, user,
 * and bank data. This closes that hole to match the standing security rule the
 * rules-engine tables already follow.
 *
 * The fix per table (idempotent, all-or-nothing in one transaction):
 *   1. ENABLE ROW LEVEL SECURITY  — with no policies, this DENIES every non-
 *      bypass role (anon/authenticated) by default.
 *   2. REVOKE ALL FROM anon, authenticated  — removes the grant so the table
 *      leaves the exposed API surface entirely (defense in depth).
 *
 * Safe because BOTH server access paths bypass RLS and never use these roles:
 *   • Drizzle/postgres.js connects as `postgres` (rolbypassrls = true) — verified.
 *   • supabase-js uses SUPABASE_SERVICE_ROLE_KEY (service_role bypasses RLS).
 * No code reads these tables through the anon/authenticated PostgREST API
 * (grep of `.from('bk_…')` hits only legacy QBO tables not present in this DB).
 * NO policies are added: the app never uses the public roles here, so there is
 * nothing to allow — deny-all is the correct, intended posture.
 *
 *   node scripts/fix-rls-lockdown.mjs           # DRY RUN (reports, writes nothing)
 *   node scripts/fix-rls-lockdown.mjs --live    # apply
 */
import { readFileSync } from "fs";
import postgres from "postgres";

const LIVE = process.argv.includes("--live");
const env = readFileSync(".env.local", "utf8");
const url = env
  .match(/^SUPABASE_DB_URL=(.*)$/m)[1]
  .trim()
  .replace(/^["']|["']$/g, "")
  .replace(/\\n$/, "");
const sql = postgres(url, { ssl: "require", max: 1 });

const before = await sql`
  SELECT c.relname AS t, c.relrowsecurity AS rls,
    EXISTS (SELECT 1 FROM information_schema.role_table_grants g
            WHERE g.table_schema='public' AND g.table_name=c.relname
              AND g.grantee IN ('anon','authenticated')) AS granted
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relkind='r' ORDER BY c.relname`;

const exposed = before.filter((r) => !r.rls && r.granted).map((r) => r.t);
console.log(`${LIVE ? "APPLYING" : "DRY RUN"} — RLS lockdown`);
console.log(`public tables: ${before.length}`);
console.log(`currently exposed (RLS off + public grant): ${exposed.length}`);
console.log(exposed.map((t) => "  • " + t).join("\n") || "  (none)");

if (!LIVE) {
  console.log("\n(DRY RUN — nothing written. Re-run with --live.)");
  await sql.end();
  process.exit(0);
}

// Apply to ALL public base tables (idempotent — a no-op on the 3 already locked),
// so the whole schema ends in one uniform deny-all-to-PostgREST posture.
await sql.begin(async (sql) => {
  for (const { t } of before) {
    await sql.unsafe(`ALTER TABLE public."${t}" ENABLE ROW LEVEL SECURITY`);
    await sql.unsafe(`REVOKE ALL ON public."${t}" FROM anon, authenticated`);
  }
});

const after = await sql`
  SELECT c.relname AS t, c.relrowsecurity AS rls,
    EXISTS (SELECT 1 FROM information_schema.role_table_grants g
            WHERE g.table_schema='public' AND g.table_name=c.relname
              AND g.grantee IN ('anon','authenticated')) AS granted
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relkind='r' ORDER BY c.relname`;
const stillExposed = after.filter((r) => !r.rls || r.granted);
console.log(`\n✓ APPLIED. RLS on: ${after.filter((r) => r.rls).length}/${after.length}; ` +
  `tables still exposed: ${stillExposed.length}`);
if (stillExposed.length) console.log("  STILL EXPOSED:", stillExposed.map((r) => r.t).join(", "));
await sql.end();
