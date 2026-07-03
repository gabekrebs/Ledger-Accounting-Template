/**
 * Adds the per-entity valuation methodology columns to bk_ledger_entities and
 * seeds the obvious classifications. Idempotent — safe to re-run.
 *
 *   valuation_method   'income' (default) | 'market' | 'none'
 *   market_value_cents bigint, nullable   — for method='market'
 *   market_value_source / _as_of          — provenance of that value
 *   property_address / valuation_url      — keys for (re)pulling an AVM
 *
 * Direct ALTER (not drizzle-kit), matching the bk_journal_lines.location
 * precedent, so we don't sweep unrelated schema drift into a migration.
 *
 *   node scripts/add-valuation-fields.mjs
 */
import { readFileSync } from "fs";
import postgres from "postgres";

const env = readFileSync(".env.local", "utf8");
const url = env
  .match(/^SUPABASE_DB_URL=(.*)$/m)[1]
  .trim()
  .replace(/^["']|["']$/g, "")
  .replace(/\\n$/, "");
const sql = postgres(url, { ssl: "require" });

await sql`ALTER TABLE bk_ledger_entities
  ADD COLUMN IF NOT EXISTS valuation_method   text NOT NULL DEFAULT 'income',
  ADD COLUMN IF NOT EXISTS market_value_cents  bigint,
  ADD COLUMN IF NOT EXISTS market_value_source text,
  ADD COLUMN IF NOT EXISTS market_value_as_of  date,
  ADD COLUMN IF NOT EXISTS property_address    text,
  ADD COLUMN IF NOT EXISTS valuation_url       text`;

const rows = await sql`
  SELECT name, valuation_method FROM bk_ledger_entities ORDER BY name`;
console.log("\nvaluation_method by entity:");
for (const r of rows) console.log(`  ${r.valuation_method.padEnd(7)}  ${r.name}`);

await sql.end();
