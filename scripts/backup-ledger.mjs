/**
 * Ledger backup → Google Drive (owner request, 2026-07-11).
 *
 * Exports EVERY bk_* table to gzipped JSONL plus three human-readable CSVs
 * (journal, accounts, entities) into the Mac's synced Drive folder:
 *
 *   ~/My Drive/Ledger Backups/<YYYY-MM-DD>/
 *     manifest.json            — timestamp + per-table row counts
 *     tables/<bk_table>.jsonl.gz
 *     journal.csv              — one row per journal LINE, fully labeled
 *     accounts.csv, entities.csv
 *
 * READ-ONLY against the database. No pg_dump dependency (the binary isn't
 * installed); JSONL is restore-grade — each line is one row keyed by column
 * name, so re-inserting into a fresh schema (schema.ts is in git) recovers
 * the books. The CSVs make the books legible with no app at all.
 *
 * Scheduled quarterly via launchd (a launchd/cron job, installed from
 * this repo — see docs/DECISIONS.md ADR-021 follow-ups). Run manually:
 *
 *   node scripts/backup-ledger.mjs
 */
import { readFileSync, mkdirSync, writeFileSync, createWriteStream } from "fs";
import { homedir } from "os";
import { join } from "path";
import { createGzip } from "zlib";
import postgres from "postgres";

const env = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const url = env
  .match(/^SUPABASE_DB_URL=(.*)$/m)[1]
  .trim()
  .replace(/^["']|["']$/g, "");
const sql = postgres(url, { ssl: "require", max: 1 });

const stamp = new Date().toISOString().slice(0, 10);
const root = join(
  homedir(),
  "My Drive",
  "Real Estate",
  "Ledger Backups",
  stamp
);
mkdirSync(join(root, "tables"), { recursive: true });

// ── every bk_* table → JSONL.gz ──────────────────────────────────────────────
const tables = (
  await sql`select table_name from information_schema.tables
    where table_schema='public' and table_name like 'bk\\_%' order by table_name`
).map((r) => r.table_name);

const counts = {};
for (const table of tables) {
  const out = createWriteStream(join(root, "tables", `${table}.jsonl.gz`));
  const gz = createGzip();
  gz.pipe(out);
  let n = 0;
  // Cursor keeps memory flat on the big tables (journal lines, plaid txns).
  const cursor = sql`select * from ${sql(table)}`.cursor(500);
  for await (const rows of cursor) {
    for (const row of rows) {
      gz.write(JSON.stringify(row) + "\n");
      n++;
    }
  }
  await new Promise((res, rej) => {
    gz.end();
    out.on("finish", res);
    out.on("error", rej);
  });
  counts[table] = n;
  console.log(`  ${table}: ${n} rows`);
}

// ── human-readable CSVs ──────────────────────────────────────────────────────
const csvEscape = (v) => {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const writeCsv = (file, header, rows) =>
  writeFileSync(
    join(root, file),
    [header.join(","), ...rows.map((r) => r.map(csvEscape).join(","))].join("\n")
  );

const journal = await sql`
  select en.name as entity, e.txn_date, e.source, e.name as payee, e.memo,
         a.fully_qualified_name as account, a.classification,
         l.debit_cents::numeric/100 as debit, l.credit_cents::numeric/100 as credit,
         e.id as entry_id
  from bk_journal_lines l
  join bk_journal_entries e on e.id = l.entry_id
  join bk_accounts a on a.id = l.account_id
  left join bk_ledger_entities en on en.id = e.entity_id
  order by en.name, e.txn_date, e.id, l.line_no`;
writeCsv(
  "journal.csv",
  ["entity","date","source","payee","memo","account","classification","debit","credit","entry_id"],
  journal.map((r) => [r.entity, String(r.txn_date).slice(0, 10), r.source, r.payee, r.memo, r.account, r.classification, r.debit, r.credit, r.entry_id])
);

const accounts = await sql`
  select en.name as entity, a.fully_qualified_name, a.account_type, a.classification, a.active
  from bk_accounts a left join bk_ledger_entities en on en.id = a.entity_id
  order by en.name, a.fully_qualified_name`;
writeCsv(
  "accounts.csv",
  ["entity","account","type","classification","active"],
  accounts.map((r) => [r.entity, r.fully_qualified_name, r.account_type, r.classification, r.active])
);

const entities = await sql`select name, id, created_at from bk_ledger_entities order by name`;
writeCsv("entities.csv", ["name","id","created_at"], entities.map((r) => [r.name, r.id, r.created_at]));

writeFileSync(
  join(root, "manifest.json"),
  JSON.stringify(
    { backedUpAt: new Date().toISOString(), tables: counts, journalLines: journal.length },
    null,
    2
  )
);

await sql.end();
console.log(`backup-ledger: done → ${root} (${journal.length} journal lines)`);
