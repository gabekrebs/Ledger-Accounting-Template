import { sql } from "drizzle-orm";
import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import {
  normalizeMerchant,
  extractParty,
  candidateKeys,
} from "@/lib/ledger/merchant";

/**
 * Similar-transactions retrieval (ADR-021) — the few-shot engine behind the AI
 * categorizer. Instead of asking the model to guess from the chart alone, we
 * show it up to 8 precedents from THIS entity's booked ledger ("here is how
 * the owner categorized transactions like this one") plus any recorded corrections
 * ("the model suggested X here before and the owner posted Y").
 *
 * Candidate generation is deterministic and cheap — no embeddings:
 *   1. exact normalized-merchant-key match (strongest),
 *   2. meaningful token overlap between merchant keys,
 *   3. ranked by amount proximity on a LOG scale, so a $92 Home Depot line is a
 *      neighbor of a $184 one but not of a $7,800 one, with recency as the
 *      tiebreak.
 *
 * Read-only; consumed by lib/plaid/suggest-categories.ts when it builds the
 * model prompt, and snapshotted into the event's evidence for replay.
 */

const { bkCategorizationEvents } = schema;

export interface Precedent {
  merchantKey: string;
  /** display payee as the books carry it */
  payee: string;
  /** category-line amount, abs cents */
  amountCents: number;
  txnDate: string;
  accountId: string;
  accountLabel: string;
}

export interface Correction {
  merchantKey: string;
  suggestedLabel: string;
  postedLabel: string;
}

/**
 * Load the entity's precedent pool once per suggestion run: every booked
 * single-category entry (the same "exactly one non-bank line" rule the history
 * fingerprint uses — splits are ambiguous about "the" category), most recent
 * first, capped so the scan stays cheap.
 */
export async function buildPrecedents(entityId: string): Promise<Precedent[]> {
  const rows = (await db.execute(sql`
    select e.txn_date::text as txn_date, e.name, e.memo,
           (array_agg(l.line_memo) filter (where l.line_memo is not null))[1] as line_memo,
           (array_agg(l.account_id) filter (where a.account_type not in ('Bank','Credit Card','CreditCard')))[1] as account_id,
           (array_agg(coalesce(a.fully_qualified_name, a.name)) filter (where a.account_type not in ('Bank','Credit Card','CreditCard')))[1] as acct_label,
           (array_agg(coalesce(l.debit_cents,0) + coalesce(l.credit_cents,0)) filter (where a.account_type not in ('Bank','Credit Card','CreditCard')))[1] as amount_cents
    from bk_journal_entries e
    join bk_journal_lines l on l.entry_id = e.id
    join bk_accounts a on a.id = l.account_id
    where e.entity_id = ${entityId}
    group by e.id
    having count(*) filter (where a.account_type not in ('Bank','Credit Card','CreditCard')) = 1
    order by e.txn_date desc
    limit 4000
  `)) as unknown as Array<{
    txn_date: string;
    name: string | null;
    memo: string | null;
    line_memo: string | null;
    account_id: string | null;
    acct_label: string | null;
    amount_cents: number | string | null;
  }>;

  const out: Precedent[] = [];
  for (const r of rows) {
    const payee =
      r.name ?? extractParty({ lineMemo: r.line_memo, memo: r.memo }) ?? "";
    const key = normalizeMerchant(payee);
    if (key.length < 3 || !r.account_id) continue;
    out.push({
      merchantKey: key,
      payee,
      amountCents: Math.abs(Number(r.amount_cents ?? 0)),
      txnDate: String(r.txn_date).slice(0, 10),
      accountId: r.account_id,
      accountLabel: r.acct_label ?? "",
    });
  }
  return out;
}

const tokensOf = (key: string): Set<string> =>
  new Set(key.split(" ").filter((t) => t.length >= 4));

/**
 * Score + pick the k most relevant precedents for one transaction. Only
 * merchant-related precedents qualify (exact key or token overlap) — amount
 * proximity ranks WITHIN the related set, it never qualifies an unrelated one.
 */
export function similarFor(
  txn: { merchantName: string | null; name: string | null; amountCents: number },
  precedents: Precedent[],
  k = 8
): Precedent[] {
  const keys = candidateKeys(txn.merchantName, txn.name);
  if (!keys.length) return [];
  const keySet = new Set(keys);
  const txnTokens = new Set<string>();
  for (const key of keys) for (const t of tokensOf(key)) txnTokens.add(t);
  const absAmount = Math.max(1, Math.abs(txn.amountCents));

  const scored: { p: Precedent; score: number }[] = [];
  for (const p of precedents) {
    let score = 0;
    if (keySet.has(p.merchantKey)) {
      score += 60;
    } else if (txnTokens.size) {
      const pt = tokensOf(p.merchantKey);
      let shared = 0;
      for (const t of pt) if (txnTokens.has(t)) shared++;
      if (shared === 0) continue; // unrelated merchant — never pad with these
      const union = new Set([...pt, ...txnTokens]).size;
      score += 30 * (shared / union);
    } else {
      continue;
    }
    // Log-scale amount proximity: same order of magnitude ≈ no penalty; 10×
    // apart ≈ −18. This is what separates the $28 Home Depot run from the
    // $7,800 renovation draw.
    const ratio = Math.abs(Math.log(Math.max(1, p.amountCents) / absAmount));
    score -= Math.min(25, 8 * ratio);
    if (score < 10) continue;
    scored.push({ p, score });
  }

  scored.sort(
    (a, b) => b.score - a.score || b.p.txnDate.localeCompare(a.p.txnDate)
  );
  return scored.slice(0, k).map((s) => s.p);
}

/**
 * Recorded corrections for a set of merchants — "the model suggested X and the
 * owner posted Y" — shown to the model as counter-examples so a repeated
 * mistake dies after one correction, not many.
 */
export async function correctionsFor(
  entityId: string,
  merchantKeys: string[]
): Promise<Map<string, Correction[]>> {
  const uniq = [...new Set(merchantKeys.filter(Boolean))];
  if (!uniq.length) return new Map();
  const sug = schema.bkAccounts;
  const rows = await db
    .select({
      merchantKey: bkCategorizationEvents.merchantKey,
      suggestedAccountId: bkCategorizationEvents.suggestedAccountId,
      postedAccountId: bkCategorizationEvents.postedAccountId,
    })
    .from(bkCategorizationEvents)
    .where(
      and(
        eq(bkCategorizationEvents.entityId, entityId),
        eq(bkCategorizationEvents.outcome, "corrected"),
        inArray(bkCategorizationEvents.merchantKey, uniq)
      )
    )
    .limit(200);

  const accountIds = [
    ...new Set(
      rows
        .flatMap((r) => [r.suggestedAccountId, r.postedAccountId])
        .filter((v): v is string => !!v)
    ),
  ];
  const labelById = new Map<string, string>();
  if (accountIds.length) {
    const accts = await db
      .select({
        id: sug.id,
        name: sug.name,
        fullyQualifiedName: sug.fullyQualifiedName,
      })
      .from(sug)
      .where(inArray(sug.id, accountIds));
    for (const a of accts)
      labelById.set(a.id, a.fullyQualifiedName ?? a.name ?? "");
  }

  const out = new Map<string, Correction[]>();
  for (const r of rows) {
    if (!r.merchantKey || !r.suggestedAccountId || !r.postedAccountId) continue;
    const list = out.get(r.merchantKey) ?? [];
    if (list.length >= 3) continue; // a few examples per merchant is plenty
    list.push({
      merchantKey: r.merchantKey,
      suggestedLabel: labelById.get(r.suggestedAccountId) ?? "?",
      postedLabel: labelById.get(r.postedAccountId) ?? "?",
    });
    out.set(r.merchantKey, list);
  }
  return out;
}
