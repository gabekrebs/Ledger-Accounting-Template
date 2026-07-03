/**
 * Unified valuation model. Adds the component + estimate tables and the
 * equity-stake columns on bk_ledger_entities. Idempotent.
 *
 *   node scripts/add-valuation-components.mjs
 *
 * (Components/estimates are created per-entity at runtime from the Valuation
 * tab — this migration only creates the schema.)
 */
import { readFileSync } from "fs";
import postgres from "postgres";

const url = readFileSync(".env.local", "utf8")
  .match(/^SUPABASE_DB_URL=(.*)$/m)[1]
  .trim()
  .replace(/^["']|["']$/g, "")
  .replace(/\\n$/, "");
const sql = postgres(url, { ssl: "require" });

await sql`ALTER TABLE bk_ledger_entities
  ADD COLUMN IF NOT EXISTS parent_entity_id uuid,
  ADD COLUMN IF NOT EXISTS ownership_pct numeric`;

await sql`CREATE TABLE IF NOT EXISTS bk_valuation_components (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id uuid NOT NULL REFERENCES bk_ledger_entities(id) ON DELETE CASCADE,
  label text NOT NULL,
  address text,
  zillow_url text,
  redfin_url text,
  chosen_source text,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz DEFAULT now()
)`;
await sql`CREATE INDEX IF NOT EXISTS bk_valuation_components_entity_idx ON bk_valuation_components(entity_id)`;

await sql`CREATE TABLE IF NOT EXISTS bk_valuation_estimates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  component_id uuid NOT NULL REFERENCES bk_valuation_components(id) ON DELETE CASCADE,
  source text NOT NULL,
  value_cents bigint NOT NULL,
  as_of date,
  url text,
  reasoning text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  CONSTRAINT bk_valuation_estimates_component_source_uq UNIQUE (component_id, source)
)`;
await sql`CREATE INDEX IF NOT EXISTS bk_valuation_estimates_component_idx ON bk_valuation_estimates(component_id)`;

// RLS lockdown in the SAME migration (ADR-007): the app uses the service /
// postgres role (bypasses RLS); the public PostgREST roles get deny-all.
for (const t of ["bk_valuation_components", "bk_valuation_estimates"]) {
  await sql.unsafe(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`);
  await sql.unsafe(`REVOKE ALL ON ${t} FROM anon, authenticated`);
}

console.log("✓ valuation component + estimate tables ready (RLS enabled)");
await sql.end();
