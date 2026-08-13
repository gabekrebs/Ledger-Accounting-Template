/**
 * Generate Review-only categorization rules from recent history (the launch).
 *
 * Authors one ACTIVE, auto_apply=FALSE `categorize` rule per AUTO-eligible
 * merchant — the merchants that, under the "when in doubt, review" policy, have
 * sufficient RECENT (≤36mo, ≥10), all-time-unanimous history and are not
 * transfer/loan/owner/person-like. Nothing auto-posts: each rule pre-fills the
 * Review dropdown and must EARN auto_apply through clean confirmations.
 *
 * Each rule's description carries provenance (samples used, window, oldest /
 * newest / last-seen dates, whether >12mo was needed). Idempotent: skips a
 * merchant that already has an entity rule with the same predicate.
 *
 *   npx tsx scripts/generate-rules.mts            # DRY RUN (writes nothing)
 *   npx tsx scripts/generate-rules.mts --live     # actually create the rules
 */
import fs from "fs";
import type { Condition, ConditionGroup } from "../lib/rules/types";
for (const line of fs.readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const LIVE = process.argv.includes("--live");
const postgres = (await import("postgres")).default;
const { normalizeMerchant, extractParty } = await import("../lib/ledger/merchant");
const { createRule } = await import("../lib/rules/store");
const sql = postgres((process.env.SUPABASE_DB_URL || "").replace(/\s+/g, ""), { prepare: false });

const NOW = new Date("2026-06-29");
const cut = (mo: number) => { const d = new Date(NOW); d.setMonth(d.getMonth() - mo); return d.toISOString().slice(0, 10); };
const C12 = cut(12), C24 = cut(24), C36 = cut(36);
const BANK = new Set(["Bank", "Credit Card", "CreditCard"]);
const reAcct = /transfer|clearing|due to|due from|intercompany|credit ?card|\bvisa\b|mastercard|amex|discover|\bloan\b|note payable|mortgage|escrow|principal|line of credit|\bloc\b|heloc|owner|capital|distribution|contribution|draw/i;
const reDescPay = /payment thank|automatic payment|auto ?pay|epay|e-?payment|cardmember|card member|ba electronic payment|online pmt|web pmt|\btransfer\b|xfer|wire/i;
const rePerson = /\bzelle\b|venmo|cash app|quickpay/i;
const reWasteRent = /waste connection|heritage propert/i;

const ents = await sql<{ id: string; name: string }[]>`select id, name from bk_ledger_entities`;
// existing predicates to skip (idempotency): entity_id|merchant-eq-value
const existing = new Set<string>();
for (const r of await sql<{ entity_id: string; predicate: ConditionGroup }[]>`select entity_id, predicate from bk_rules where scope='entity'`) {
  const c = r.predicate?.all?.find((x): x is Condition => "field" in x && x.field === "merchant" && x.op === "eq");
  if (c) existing.add(`${r.entity_id}|${c.value}`);
}

type GLRow = {
  eid: string; d: string; name: string | null; memo: string | null; lm: string | null;
  aid: string; at: string | null; an: string; pq: string | null; qid: string | null;
};
type Entry = { d: string; name: string | null; memo: string | null; lm: string | null; accts: string[] };
type Sample = { d: string; acct: string };

let created = 0, skipped = 0;
const perEntity: Record<string, number> = {};
const samples: string[] = [];
for (const e of ents) {
  const rows = await sql<GLRow[]>`
    select e.id eid, e.txn_date::text d, e.name, e.memo, l.line_memo lm, l.account_id aid,
           a.account_type at, a.name an, a.parent_qbo_id pq, a.qbo_account_id qid
    from bk_journal_entries e join bk_journal_lines l on l.entry_id=e.id join bk_accounts a on a.id=l.account_id
    where e.entity_id=${e.id}`;
  const idByQbo = new Map<string | null, string>(), an = new Map<string, string>(), pq = new Map<string, string | null>();
  for (const r of rows) { idByQbo.set(r.qid, r.aid); an.set(r.aid, r.an); pq.set(r.aid, r.pq); }
  const parentOf = new Map<string, string>();
  for (const [id, p] of pq) { const x = p ? idByQbo.get(p) : undefined; if (x) parentOf.set(id, x); }
  const chain = (id: string) => { const o = [id]; for (let p = parentOf.get(id); p; p = parentOf.get(p)) o.push(p); return o; };
  const byEntry = new Map<string, Entry>();
  for (const r of rows) {
    const s: Entry = byEntry.get(r.eid) ?? { d: r.d, name: r.name, memo: r.memo, lm: null, accts: [] };
    if (r.lm && !s.lm) s.lm = r.lm;
    if (!BANK.has(r.at ?? "")) s.accts.push(r.aid);
    byEntry.set(r.eid, s);
  }
  const byKey = new Map<string, Sample[]>();
  for (const s of byEntry.values()) {
    if (s.accts.length !== 1) continue;
    const key = normalizeMerchant(s.name ?? extractParty({ lineMemo: s.lm, memo: s.memo }));
    if (key.length < 3) continue;
    (byKey.get(key) ?? byKey.set(key, []).get(key)!).push({ d: s.d, acct: s.accts[0] });
  }
  const foldUnanimous = (ss: Sample[]) => {
    let accts = [...new Set(ss.map((x) => x.acct))];
    if (accts.length > 1) { const deep = accts.reduce((a, b) => chain(b).length > chain(a).length ? b : a); const lin = new Set(chain(deep)); if (accts.every((a) => lin.has(a))) accts = [deep]; }
    return accts.length === 1 ? accts[0] : null;
  };
  for (const [key, ss] of byKey) {
    ss.sort((a, b) => a.d < b.d ? -1 : 1);
    const lastSeen = ss[ss.length - 1].d;
    const acctNm0 = an.get(foldUnanimous(ss) ?? ss[ss.length - 1].acct) ?? "";
    if ((reAcct.test(acctNm0) || reDescPay.test(key)) && !reWasteRent.test(key)) continue; // gate 5
    if (rePerson.test(key)) continue;
    const in36 = ss.filter((x) => x.d >= C36);
    if (in36.length === 0) continue; // stale
    let win = 0, winS: Sample[] = [];
    for (const [w, c] of [[12, C12], [24, C24], [36, C36]] as [number, string][]) { const s = ss.filter((x) => x.d >= c); if (s.length >= 10) { win = w; winS = s; break; } }
    if (!win) continue; // insufficient recent
    const u = foldUnanimous(ss); // gate 3/4/7: ALL-TIME unanimity
    if (!u) continue;
    // AUTO-eligible → author a Review-only rule
    if (existing.has(`${e.id}|${key}`)) { skipped++; continue; }
    const acctNm = an.get(u);
    const beyond12 = win > 12 || winS.some((x) => x.d < C12);
    const desc = `History: ${winS.length} samples in last ${win}mo (${winS[0].d}→${winS[winS.length - 1].d}); last seen ${lastSeen}${beyond12 ? "; required >12mo window" : ""}. Review-only until confirmed.`;
    samples.push(`${e.name} | ${key} → ${acctNm} | ${desc}`);
    perEntity[e.name] = (perEntity[e.name] ?? 0) + 1;
    created++;
    if (LIVE) {
      await createRule({
        scope: "entity", entityId: e.id,
        name: `${key} → ${acctNm}`,
        description: desc,
        enabled: true, autoApply: false, rank: 100,
        predicate: { all: [{ field: "merchant", op: "eq", value: key }] },
        action: { kind: "categorize", target: { by: "account", accountId: u } },
      }, "generate-rules.mts");
    }
  }
}
console.log(`\n${LIVE ? "CREATED" : "WOULD CREATE"} ${created} Review-only rules (auto_apply=false). Skipped ${skipped} already-existing.`);
console.table(Object.entries(perEntity).sort((a, b) => b[1] - a[1]).map(([entity, n]) => ({ entity, rules: n })));
console.log("\nFirst 15 samples:");
for (const s of samples.slice(0, 15)) console.log("  " + s);
if (!LIVE) console.log("\n(DRY RUN — nothing written. Re-run with --live to create.)");
await sql.end();
