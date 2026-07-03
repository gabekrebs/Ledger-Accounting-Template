/**
 * Widen bk_loans.annual_rate_bps from integer → numeric(8,3).
 *
 * The Drizzle schema already DECLARES this column `numeric` (lib/db/schema.ts),
 * but the physical column was created `integer` by an early migration — so
 * rates like 2.569% (256.9 bps) or 3.625% (362.5 bps) rounded to whole bps,
 * costing ~$1–2/month of interest-split drift on the affected mortgages until
 * the annual 1098 true-up. This brings the physical column in line with the
 * declaration so the liability engine can store exact half-bps rates and split
 * every payment to the penny.
 *
 * Non-destructive: integer → numeric is a widening cast; every existing value
 * is preserved (650 → 650.000). Idempotent — re-running is a no-op once the
 * column is already numeric. No RLS step (no new table).
 *
 *   node scripts/add-loan-rate-precision.mjs
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
  const [before] = await sql`
    SELECT data_type, numeric_scale FROM information_schema.columns
    WHERE table_name = 'bk_loans' AND column_name = 'annual_rate_bps'`;
  if (before.data_type === "numeric" && Number(before.numeric_scale) >= 3) {
    console.log("✓ annual_rate_bps already numeric(_,3+) — nothing to do");
  } else {
    await sql`ALTER TABLE bk_loans
      ALTER COLUMN annual_rate_bps TYPE numeric(8,3)
      USING annual_rate_bps::numeric(8,3)`;
    console.log(`✓ annual_rate_bps: ${before.data_type} → numeric(8,3)`);
  }
  const [after] = await sql`
    SELECT data_type, numeric_precision, numeric_scale FROM information_schema.columns
    WHERE table_name = 'bk_loans' AND column_name = 'annual_rate_bps'`;
  console.log(`  now: ${after.data_type}(${after.numeric_precision},${after.numeric_scale})`);
  const [{ n }] = await sql`SELECT COUNT(*)::int AS n FROM bk_loans WHERE annual_rate_bps IS NOT NULL`;
  console.log(`  ${n} loan rows carry a rate (all preserved).`);
} finally {
  await sql.end();
}
