/**
 * bk_ledger_entities.nickname — optional short display name for the home-page
 * launcher (null = show the full entity name). Additive, idempotent.
 *
 *   node scripts/add-entity-nickname.mjs
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

await sql`ALTER TABLE bk_ledger_entities ADD COLUMN IF NOT EXISTS nickname text`;
console.log("bk_ledger_entities.nickname ensured");
await sql.end();
