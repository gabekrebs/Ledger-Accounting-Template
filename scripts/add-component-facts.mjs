/**
 * Adds property-fact columns to bk_valuation_components. These feed the AI
 * estimate prompt: the scraper fills the public ones (property_type/beds/baths/
 * sqft) from the Zillow/Redfin pages it already reads, the owner provides the
 * rest, and the Valuation tab prefills the AI form from them. Idempotent.
 *
 *   node scripts/add-component-facts.mjs
 */
import { readFileSync } from "fs";
import postgres from "postgres";

const url = readFileSync(".env.local", "utf8")
  .match(/^SUPABASE_DB_URL=(.*)$/m)[1]
  .trim()
  .replace(/^["']|["']$/g, "")
  .replace(/\\n$/, "");
const sql = postgres(url, { ssl: "require" });

await sql`ALTER TABLE bk_valuation_components
  ADD COLUMN IF NOT EXISTS property_type text,
  ADD COLUMN IF NOT EXISTS units text,
  ADD COLUMN IF NOT EXISTS beds text,
  ADD COLUMN IF NOT EXISTS baths text,
  ADD COLUMN IF NOT EXISTS sqft text,
  ADD COLUMN IF NOT EXISTS monthly_rent text,
  ADD COLUMN IF NOT EXISTS condition text,
  ADD COLUMN IF NOT EXISTS facts_note text`;

const cols = await sql`
  SELECT column_name FROM information_schema.columns
   WHERE table_name = 'bk_valuation_components'
     AND column_name IN ('property_type','units','beds','baths','sqft','monthly_rent','condition','facts_note')
   ORDER BY column_name`;
console.log("fact columns present:", cols.map((c) => c.column_name).join(", "));
await sql.end();
