/**
 * Phase: unified valuation model. Adds the component + estimate tables and the
 * equity-stake columns, then backfills components for the existing market
 * entities (single structure each, except 1032 = duplex + house). Idempotent.
 *
 *   node scripts/add-valuation-components.mjs
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

const Z = "https://www.zillow.com/homedetails";
// entityId → components [{label, address, zillowUrl?, chosenSource?, zillow?:cents}]
const BACKFILL = {
  "4d167556-c6e8-4732-bc1f-1c6e3a777a3a": [
    { label: "House — 3820 SE Belmont St", address: "3820 SE Belmont St, Portland, OR 97214",
      zillowUrl: `${Z}/3820-SE-Belmont-St-Portland-OR-97214/53821335_zpid/`, chosen: "zillow", zillow: 81740000 },
  ],
  "06cd5b45-0f54-428d-950e-a97c08f6a27a": [
    { label: "House — 1200 SW 20th Ave", address: "1200 SW 20th Ave, Portland, OR 97205",
      zillowUrl: `${Z}/1200-SW-20th-Ave-Portland-OR-97205/248438144_zpid/`, chosen: "zillow", zillow: 70150000 },
  ],
  "4d0204c2-0888-4019-96c7-27dbb2d02249": [
    { label: "Townhome — 5012 NE 26th Ave", address: "5012 NE 26th Ave, Portland, OR 97211",
      zillowUrl: `${Z}/5012-NE-26th-Ave-Portland-OR-97211/2081504951_zpid/`, chosen: "zillow", zillow: 61060000 },
  ],
  "af90b9ad-c63b-40b3-98c3-cdd53285ff40": [
    { label: "Duplex — 1032-1036 SE 12th Ave", address: "1032-1036 SE 12th Ave, Portland, OR 97214",
      zillowUrl: `${Z}/1032-SE-12th-Ave-Portland-OR-97214/456892982_zpid/`, chosen: null },
    { label: "House — 123 Main St", address: "123 Main St, Springfield, OR 97400", chosen: null },
  ],
};

for (const [entityId, comps] of Object.entries(BACKFILL)) {
  const [{ n }] = await sql`SELECT COUNT(*)::int n FROM bk_valuation_components WHERE entity_id=${entityId}`;
  if (n > 0) { console.log(`skip ${entityId} (already has ${n} components)`); continue; }
  let i = 0;
  for (const c of comps) {
    const [comp] = await sql`
      INSERT INTO bk_valuation_components (entity_id, label, address, zillow_url, chosen_source, sort_order)
      VALUES (${entityId}, ${c.label}, ${c.address}, ${c.zillowUrl ?? null}, ${c.chosen ?? null}, ${i++})
      RETURNING id`;
    if (c.zillow) {
      await sql`INSERT INTO bk_valuation_estimates (component_id, source, value_cents, as_of, url)
        VALUES (${comp.id}, 'zillow', ${c.zillow}, '2026-06-07', ${c.zillowUrl ?? null})`;
    }
    console.log(`  + ${c.label}${c.zillow ? ` ($${(c.zillow/100).toLocaleString()})` : " (no value yet)"}`);
  }
}

const summary = await sql`
  SELECT e.name, c.label, est.source, est.value_cents
    FROM bk_valuation_components c
    JOIN bk_ledger_entities e ON e.id=c.entity_id
    LEFT JOIN bk_valuation_estimates est ON est.component_id=c.id
   ORDER BY e.name, c.sort_order`;
console.log("\ncomponents:");
for (const r of summary) console.log(`  ${r.name} :: ${r.label} :: ${r.source ?? "—"} ${r.value_cents ?? ""}`);
await sql.end();
