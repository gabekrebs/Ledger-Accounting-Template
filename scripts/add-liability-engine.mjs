/**
 * Liability-engine recognition state on `bk_loans` (design: 2026-07 session;
 * see lib/plaid/loan-match.ts header for how the engine uses these).
 *
 *   payee_aliases          jsonb   — learned servicer descriptors (loan = identity, servicer = label)
 *   expected_payment_cents bigint  — current full draft; null = engine off for this loan
 *   recognized_count       int     — payments auto-recognized (visibility/confidence)
 *   last_recognized_date   date
 *
 * Direct ALTER (not drizzle-kit), idempotent — safe to re-run. No new table,
 * so no RLS/grant step needed (bk_loans is already locked; run
 * scripts/rls-audit.mjs after as standard practice).
 *
 *   node scripts/add-liability-engine.mjs
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

try {
  await sql.begin(async (tx) => {
    await tx`ALTER TABLE bk_loans ADD COLUMN IF NOT EXISTS payee_aliases jsonb NOT NULL DEFAULT '[]'::jsonb`;
    await tx`ALTER TABLE bk_loans ADD COLUMN IF NOT EXISTS expected_payment_cents bigint`;
    await tx`ALTER TABLE bk_loans ADD COLUMN IF NOT EXISTS recognized_count integer NOT NULL DEFAULT 0`;
    await tx`ALTER TABLE bk_loans ADD COLUMN IF NOT EXISTS last_recognized_date date`;
  });
  const cols = await sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'bk_loans' AND column_name IN
      ('payee_aliases','expected_payment_cents','recognized_count','last_recognized_date')`;
  console.log(`✓ bk_loans liability-engine columns present: ${cols.length}/4`);
  if (cols.length !== 4) process.exit(1);
} finally {
  await sql.end();
}
