/**
 * Universal chart-of-accounts hygiene (standard across all entities).
 * Metadata-only (active flag), NO journal touch, reversible. Dry default / --live / --reverse.
 *
 * Deactivates, per entity, $0-balance accounts that are clutter:
 *   (a) NEVER-USED template defaults — $0 with ZERO journal lines (QBO ships ~100 of these), and
 *   (b) DEAD transitional/debt strays — $0 but with history, matching known-stray name patterns
 *       (generic "Mortgage Payable"/"Escrow Account" swept to per-property, refinance proceeds,
 *       cash on hand, undeposited funds, opening-balance equity, uncategorized, capitalized costs).
 * Guards: never deactivates a nonzero account; never an in-use clearing/AP/AR account that nets $0
 * but is actively posted to (those keep their lines AND don't match a stray pattern → left active).
 * The BS already hides $0 leaves (code); this declutters the accounts/trial-balance + loan pickers.
 */
import postgres from '../node_modules/postgres/src/index.js';
import fs from 'fs';
const ENV = fs.readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
const DBURL = ENV.match(/^SUPABASE_DB_URL=(.*)$/m)[1].trim().replace(/\\n$/, '').replace(/^["']|["']$/g, '');
const sql = postgres(DBURL, { ssl: 'require', max: 1, connect_timeout: 20 });
const LIVE = process.argv.includes('--live'), REVERSE = process.argv.includes('--reverse');

// dead-stray name patterns — $0 NON-DEBT transitional accounts safe to retire. Deliberately
// EXCLUDES anything mortgage/loan/note (debt accounts may hide unresolved misposts — e.g. Salmon's
// dead Flagstar loan has a pending H1 correction — so debt is handled per-entity, never swept).
const STRAY = [
  /^escrow account$/, /^cash on hand$/, /^capitalized costs$/, /undeposited funds/,
  /opening balance equity/, /^uncategorized (asset|expense|income)$/, /^transfer clearing$/,
  /^furniture and fixtures$/, /escrow overdraft( - \d+ ne)?$/,
];
// never auto-deactivate: any debt account, or the per-member equity buckets we just structured
const PROTECT = name => /mortgage|loan|note payable| - (initial contribution|capital calls|distributions)$/i.test(name);
const isStray = name => !PROTECT(name) && STRAY.some(r => r.test(name.toLowerCase()));

async function main() {
  const ents = await sql`select id, name from bk_ledger_entities order by name`;
  if (REVERSE) {
    // reactivate only the ones THIS tool would deactivate (can't perfectly know; reactivate all $0 inactive that match rules)
    let n = 0;
    for (const e of ents) {
      const rows = await sql`select a.id, a.name, count(l.id)::int nl, coalesce(sum(l.debit_cents-l.credit_cents),0)::bigint net
        from bk_accounts a left join bk_journal_lines l on l.account_id=a.id where a.entity_id=${e.id} and a.active=false group by a.id,a.name`;
      for (const r of rows) if (Number(r.net) === 0 && !PROTECT(r.name) && (Number(r.nl) === 0 || isStray(r.name))) { if (LIVE) await sql`update bk_accounts set active=true where id=${r.id}`; n++; }
    }
    console.log(`${LIVE ? 'REACTIVATED' : 'would reactivate'} ${n} accounts`);
    await sql.end(); return;
  }

  let total = 0;
  for (const e of ents) {
    // App-native accounts (canon:/grossup:/reorg:/slug ids) are intentional
    // standardized targets — never deactivate them even when freshly $0. QBO ids
    // are numeric; app-native ids carry a ':' prefix.
    const rows = await sql`select a.id, a.name, a.account_type, a.qbo_account_id qid, count(l.id)::int nl, coalesce(sum(l.debit_cents-l.credit_cents),0)::bigint net
      from bk_accounts a left join bk_journal_lines l on l.account_id=a.id where a.entity_id=${e.id} and a.active=true group by a.id,a.name,a.account_type,a.qbo_account_id`;
    const kill = rows.filter(r => Number(r.net) === 0 && !PROTECT(r.name) && !String(r.qid).includes(':') && (Number(r.nl) === 0 || isStray(r.name)));
    if (!kill.length) continue;
    const templates = kill.filter(r => Number(r.nl) === 0), strays = kill.filter(r => Number(r.nl) > 0);
    console.log(`\n### ${e.name}: ${kill.length} to deactivate (${templates.length} never-used templates, ${strays.length} dead strays)`);
    for (const r of strays) console.log(`   STRAY  [${r.account_type}] ${r.name} (${r.nl} lines, $0)`);
    if (templates.length) console.log(`   templates: ${templates.slice(0, 8).map(r => r.name).join(', ')}${templates.length > 8 ? ` … +${templates.length - 8} more` : ''}`);
    if (LIVE) for (const r of kill) await sql`update bk_accounts set active=false, updated_at=now() where id=${r.id}`;
    total += kill.length;
  }
  console.log(`\n${LIVE ? '✅ DEACTIVATED' : 'DRY — would deactivate'} ${total} accounts across ${ents.length} entities${LIVE ? '' : ' (re-run --live; --reverse to undo)'}`);
  await sql.end();
}
main().catch(async e => { console.error('FAIL:', e.message); await sql.end({ timeout: 1 }).catch(() => {}); process.exit(1); });
