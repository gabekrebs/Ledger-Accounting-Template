/**
 * Backup RESTORE DRILL (one-off, repeatable) — proves the quarterly Drive
 * backup actually restores, not just writes.
 *
 * 1. Latest snapshot: parse EVERY tables/*.jsonl.gz line-by-line; row counts
 *    must equal manifest.json's counts (files complete + parseable).
 * 2. Real restore: create scratch schema `restore_drill`, clone column
 *    definitions for the core tables (entities, accounts, journal entries,
 *    journal lines), bulk-insert every backed-up row via
 *    jsonb_populate_recordset, then verify INSIDE the restored copy:
 *    counts match + every journal entry balances (Σdebit = Σcredit).
 * 3. Drop the scratch schema. Production tables are never touched; the
 *    scratch schema is not in PostgREST's exposed schemas.
 */
import { readFileSync, readdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { gunzipSync } from "zlib";
import postgres from "postgres";

const env = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const url = env.match(/^SUPABASE_DB_URL=(.*)$/m)![1].trim().replace(/^["']|["']$/g, "");
const sql = postgres(url, { ssl: "require", max: 1 });

const root = join(homedir(), "My Drive", "Ledger Backups");
const snap = readdirSync(root).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().at(-1)!;
const dir = join(root, snap);
const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
console.log(`snapshot: ${snap} (created ${manifest.createdAt ?? "?"})`);

// ---- 1. every table file parses and matches the manifest count
const counts: Record<string, number> = manifest.tables ?? manifest.counts ?? manifest;
const rowsByTable = new Map<string, unknown[]>();
let fileErrors = 0;
for (const f of readdirSync(join(dir, "tables")).sort()) {
  const table = f.replace(/\.jsonl\.gz$/, "");
  const text = gunzipSync(readFileSync(join(dir, "tables", f))).toString("utf8");
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  let parsed: unknown[] = [];
  try {
    parsed = lines.map((l) => JSON.parse(l));
  } catch (e) {
    console.log(`❌ ${table}: JSON parse failure — ${e}`);
    fileErrors++;
    continue;
  }
  const expected = typeof counts[table] === "number" ? counts[table] : (counts[table] as { rows?: number })?.rows;
  const ok = expected == null || expected === parsed.length;
  if (!ok) fileErrors++;
  console.log(`${ok ? "✅" : "❌"} ${table}: ${parsed.length} rows${expected != null ? ` (manifest ${expected})` : ""}`);
  rowsByTable.set(table, parsed);
}

// ---- 2. restore core tables into a scratch schema and verify inside it
const CORE = ["bk_ledger_entities", "bk_accounts", "bk_journal_entries", "bk_journal_lines"];
await sql`drop schema if exists restore_drill cascade`;
await sql`create schema restore_drill`;
try {
  for (const t of CORE) {
    await sql.unsafe(`create table restore_drill.${t} (like public.${t})`);
    const rows = (rowsByTable.get(t) ?? []) as Record<string, unknown>[];
    for (let i = 0; i < rows.length; i += 1000) {
      // postgres.js double-encodes a pre-stringified param (arrives as a jsonb
      // string scalar) — pass the raw array so it serializes to a jsonb array.
      const batch = rows.slice(i, i + 1000);
      await sql.unsafe(
        `insert into restore_drill.${t} select * from jsonb_populate_recordset(null::restore_drill.${t}, $1::jsonb)`,
        [batch as never]
      );
    }
    const [{ n }] = await sql.unsafe(`select count(*)::int as n from restore_drill.${t}`);
    const ok = n === (rowsByTable.get(t)?.length ?? 0);
    if (!ok) fileErrors++;
    console.log(`${ok ? "✅" : "❌"} restored restore_drill.${t}: ${n} rows`);
  }

  const [bal] = await sql`
    select count(*)::int as unbalanced
    from (
      select jl.entry_id
      from restore_drill.bk_journal_lines jl
      group by jl.entry_id
      having sum(jl.debit_cents) <> sum(jl.credit_cents)
    ) x`;
  const [tot] = await sql`
    select count(distinct jl.entry_id)::int as entries,
           sum(jl.debit_cents)::bigint as debits, sum(jl.credit_cents)::bigint as credits
    from restore_drill.bk_journal_lines jl`;
  const balanced = Number(bal.unbalanced) === 0 && tot.debits === tot.credits;
  if (!balanced) fileErrors++;
  console.log(
    `${balanced ? "✅" : "❌"} restored journal: ${tot.entries} entries, Σdebits=$${(Number(tot.debits) / 100).toFixed(2)} Σcredits=$${(Number(tot.credits) / 100).toFixed(2)}, unbalanced entries=${bal.unbalanced}`
  );

  const live = await sql`
    select (select count(*)::int from public.bk_journal_entries) as entries,
           (select count(*)::int from public.bk_journal_lines) as lines`;
  console.log(
    `ℹ️  live today: ${live[0].entries} entries / ${live[0].lines} lines (backup ${rowsByTable.get("bk_journal_entries")?.length} / ${rowsByTable.get("bk_journal_lines")?.length} — drift since ${snap} is expected)`
  );
} finally {
  await sql`drop schema if exists restore_drill cascade`;
  console.log("scratch schema dropped");
}

console.log(`\nRESTORE DRILL ${fileErrors === 0 ? "PASSED" : `FAILED (${fileErrors} problems)`}`);
await sql.end();
process.exit(fileErrors ? 1 : 0);
