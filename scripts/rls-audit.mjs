/**
 * READ-ONLY security audit: for every table in the `public` schema, report
 *   - whether RLS is enabled,
 *   - whether it has any RLS policies,
 *   - what privileges the PostgREST-exposed roles (anon, authenticated) hold.
 *
 * A table is genuinely reachable through the public API ONLY if a PostgREST role
 * (anon/authenticated) has a grant on it. RLS-disabled + no-grant = not exposed
 * (Supabase's linter still warns, but it's inert). RLS-disabled + grant = real
 * exposure. Writes nothing.
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

// RLS flag + policy count per public table.
const tables = await sql`
  SELECT c.relname AS table,
         c.relrowsecurity AS rls_enabled,
         c.relforcerowsecurity AS rls_forced,
         (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r'
  ORDER BY c.relname`;

// Grants held by the PostgREST-exposed roles.
const grants = await sql`
  SELECT table_name, grantee, privilege_type
  FROM information_schema.role_table_grants
  WHERE table_schema = 'public'
    AND grantee IN ('anon', 'authenticated')
  ORDER BY table_name, grantee, privilege_type`;

const grantMap = new Map();
for (const g of grants) {
  const k = g.table_name;
  if (!grantMap.has(k)) grantMap.set(k, {});
  const byRole = grantMap.get(k);
  (byRole[g.grantee] ??= []).push(g.privilege_type);
}

let exposedCount = 0;
let rlsOffNoGrant = 0;
const exposed = [];

console.log(
  "TABLE".padEnd(34),
  "RLS".padEnd(5),
  "POL".padEnd(4),
  "anon".padEnd(28),
  "authenticated"
);
console.log("-".repeat(110));
for (const t of tables) {
  const g = grantMap.get(t.table) ?? {};
  const anon = (g.anon ?? []).join(",") || "—";
  const auth = (g.authenticated ?? []).join(",") || "—";
  const hasGrant = (g.anon ?? []).length || (g.authenticated ?? []).length;
  const flag = t.rls_enabled ? "on" : "OFF";
  const danger = !t.rls_enabled && hasGrant ? "  <== EXPOSED" : "";
  if (!t.rls_enabled && hasGrant) {
    exposedCount++;
    exposed.push(t.table);
  }
  if (!t.rls_enabled && !hasGrant) rlsOffNoGrant++;
  console.log(
    t.table.padEnd(34),
    flag.padEnd(5),
    String(t.policies).padEnd(4),
    anon.padEnd(28),
    auth + danger
  );
}

console.log("\n=== SUMMARY ===");
console.log(`total public tables:            ${tables.length}`);
console.log(`RLS enabled:                    ${tables.filter((t) => t.rls_enabled).length}`);
console.log(`RLS disabled, NO anon/auth grant (inert warning): ${rlsOffNoGrant}`);
console.log(`RLS disabled, WITH grant (GENUINELY EXPOSED):     ${exposedCount}`);
if (exposed.length) console.log(`  exposed tables: ${exposed.join(", ")}`);

// Also surface any table that has grants at all (even with RLS on, worth seeing).
const anyGrant = [...grantMap.keys()].sort();
console.log(`\ntables with ANY anon/authenticated grant: ${anyGrant.length}`);
if (anyGrant.length) console.log(`  ${anyGrant.join(", ")}`);

await sql.end();
