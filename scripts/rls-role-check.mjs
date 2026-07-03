/** READ-ONLY: what role does the app connect as, and does it bypass RLS? */
import { readFileSync } from "fs";
import postgres from "postgres";
const env = readFileSync(".env.local", "utf8");
const url = env.match(/^SUPABASE_DB_URL=(.*)$/m)[1].trim().replace(/^["']|["']$/g, "").replace(/\\n$/, "");
const sql = postgres(url, { ssl: "require", max: 1 });

const [who] = await sql`SELECT current_user, session_user`;
const [r] = await sql`
  SELECT rolname, rolsuper, rolbypassrls
  FROM pg_roles WHERE rolname = current_user`;
console.log("current_user :", who.current_user);
console.log("session_user :", who.session_user);
console.log("rolsuper     :", r?.rolsuper);
console.log("rolbypassrls :", r?.rolbypassrls, r?.rolsuper || r?.rolbypassrls ? "  → bypasses RLS (enabling RLS won't break the app)" : "  → does NOT bypass RLS (enabling RLS with no policy WOULD block this role)");

// Prove it empirically: can this role read a table that already has RLS ON?
try {
  const [c] = await sql`SELECT count(*)::int AS n FROM bk_rules`;
  console.log(`\nRead bk_rules (RLS already ON): ${c.n} rows → confirms the app role sees RLS-protected tables.`);
} catch (e) {
  console.log("\nRead bk_rules FAILED:", e.message);
}
await sql.end();
