import { and, eq, inArray, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import {
  normalizeMerchant,
  candidateKeys,
  extractParty,
} from "@/lib/ledger/merchant";

/**
 * Phase 1 — deterministic, NO-AI categorization from posting history.
 *
 * The strongest categorization signal is precedent: how this exact merchant was
 * booked before. We build a per-entity fingerprint mapping each normalized payee
 * to the category account(s) it has historically landed in — drawing on EVERY
 * source of truth we have for that entity: imported QuickBooks/Wave history
 * (`qbo_import` / `wave_import`), prior human Plaid postings (`plaid`), and prior
 * auto-postings (`plaid_auto`). Because the imported books already encode the
 * recurring stuff ("PGE → Utilities", the mortgage servicer → the loan account),
 * a freshly-linked Plaid feed gets high-confidence answers immediately — no
 * waiting for new history to accumulate.
 *
 * This module decides nothing about WRITING — it only reports what history says.
 * The auto-poster (`auto-post.ts`) applies the strict gate; the AI layer and the
 * review UI consume the softer suggestions for everything history can't pin.
 */

const { bkJournalEntries, bkJournalLines, bkAccounts } = schema;

// A merchant must have at least this many clean, unanimous prior postings before
// the auto-poster will write without a human. History-as-suggestion has no floor.
export const AUTOPOST_MIN_SAMPLES = 6;

/**
 * Account types that are the BANK side of a posting, never the category side.
 * These are QuickBooks `AccountType` strings verbatim — note "Credit Card" has a
 * space. (A prior set used "CreditCard" with no space, which silently failed to
 * recognize the credit-card line on every card-funded expense, making those
 * 2-line entries look like 2-category "splits" that the fingerprint skips — i.e.
 * it threw away roughly half the usable history. Both spellings are kept so a
 * future provider variant can't reintroduce the bug.)
 */
const BANK_TYPES = new Set(["Bank", "Credit Card", "CreditCard"]);

// normalizeMerchant / candidateKeys / extractParty now live in the neutral pure
// module lib/ledger/merchant.ts (so the rules engine + learner can share them
// without importing this legacy file). Imported above.

export interface CategoryTally {
  accountId: string;
  count: number;
}
/** normalized-merchant → category accounts seen, sorted most-frequent first. */
export type MerchantHistory = Map<string, CategoryTally[]>;

/**
 * Build the merchant→category fingerprint for one entity from its full posting
 * history. Only single-category entries count (exactly one non-bank line) — a
 * split entry is ambiguous about "the" category, so we skip it rather than guess.
 */
export async function buildMerchantHistory(
  entityId: string
): Promise<MerchantHistory> {
  const rows = await db
    .select({
      entryId: bkJournalEntries.id,
      name: bkJournalEntries.name,
      memo: bkJournalEntries.memo,
      lineMemo: bkJournalLines.lineMemo,
      accountId: bkJournalLines.accountId,
      accountType: bkAccounts.accountType,
    })
    .from(bkJournalEntries)
    .innerJoin(bkJournalLines, eq(bkJournalLines.entryId, bkJournalEntries.id))
    .innerJoin(bkAccounts, eq(bkAccounts.id, bkJournalLines.accountId))
    .where(eq(bkJournalEntries.entityId, entityId));

  // Parent links for the chain-fold below (qbo parent id → our uuid).
  const acctRows = await db
    .select({
      id: bkAccounts.id,
      qboAccountId: bkAccounts.qboAccountId,
      parentQboId: bkAccounts.parentQboId,
    })
    .from(bkAccounts)
    .where(eq(bkAccounts.entityId, entityId));
  const idByQbo = new Map(acctRows.map((a) => [a.qboAccountId, a.id]));
  const parentOf = new Map<string, string>();
  for (const a of acctRows) {
    const p = a.parentQboId ? idByQbo.get(a.parentQboId) : undefined;
    if (p) parentOf.set(a.id, p);
  }

  // Group lines by entry; keep only the category (non-bank) lines. Imported
  // bank-feed entries often carry NO payee name — the merchant lives in the
  // NACHA descriptor on a line memo ("PORTLAND GENERAL DES:BILLPAY …"), so we
  // recover it with the same high-confidence extractParty the P&L drill-down
  // uses. Without this, years of recurring utility/servicer precedent are
  // invisible to the fingerprint and trivially-identifiable transactions fall
  // through to the AI layer.
  const catLinesByEntry = new Map<
    string,
    { name: string | null; memo: string | null; lineMemo: string | null; accountIds: string[] }
  >();
  for (const r of rows) {
    const slot = catLinesByEntry.get(r.entryId) ?? {
      name: r.name,
      memo: r.memo,
      lineMemo: null,
      accountIds: [],
    };
    if (r.lineMemo && !slot.lineMemo) slot.lineMemo = r.lineMemo;
    if (!BANK_TYPES.has(r.accountType ?? "")) slot.accountIds.push(r.accountId);
    catLinesByEntry.set(r.entryId, slot);
  }

  // Tally category account per normalized merchant — single-category entries only.
  const tally = new Map<string, Map<string, number>>();
  for (const { name, memo, lineMemo, accountIds } of catLinesByEntry.values()) {
    if (accountIds.length !== 1) continue; // skip splits / pure transfers
    const key = normalizeMerchant(name ?? extractParty({ lineMemo, memo }));
    if (key.length < 3) continue; // too generic to be a reliable key
    const byAcct = tally.get(key) ?? new Map<string, number>();
    byAcct.set(accountIds[0], (byAcct.get(accountIds[0]) ?? 0) + 1);
    tally.set(key, byAcct);
  }

  // Parent-chain fold: a merchant whose history is split between an account and
  // its own parent ("NW Natural" booked 51× to Utilities:Gas and 48× to plain
  // Utilities) is NOT genuinely ambiguous — the bookkeeper refined the category
  // over time within one family. When every tallied account sits on a single
  // ancestor chain, fold all counts into the most specific (deepest) account so
  // the agreement gate reads the precedent as unanimous. Accounts in SIBLING
  // branches (Electric vs Gas) never fold — that ambiguity is real.
  const chain = (id: string): string[] => {
    const out = [id];
    for (let p = parentOf.get(id); p; p = parentOf.get(p)) out.push(p);
    return out;
  };
  const out: MerchantHistory = new Map();
  for (const [key, byAcct] of tally) {
    let entries = [...byAcct.entries()].map(([accountId, count]) => ({
      accountId,
      count,
    }));
    if (entries.length > 1) {
      const deepest = entries.reduce((a, b) =>
        chain(b.accountId).length > chain(a.accountId).length ? b : a
      );
      const lineage = new Set(chain(deepest.accountId));
      if (entries.every((e) => lineage.has(e.accountId))) {
        entries = [
          {
            accountId: deepest.accountId,
            count: entries.reduce((s, e) => s + e.count, 0),
          },
        ];
      }
    }
    out.set(
      key,
      entries.sort((a, b) => b.count - a.count)
    );
  }
  return out;
}

/**
 * Resolve a merchant to its history tallies. Tries the exact normalized key
 * first; on a miss, falls back to a CONSERVATIVE prefix match so a feed that
 * truncates the descriptor still finds its precedent — Plaid caps `merchant_name`
 * at 16 chars, so "Northwest Natura" must still reach the imported "Northwest
 * Natural" history. Guardrails keep this from over-merging:
 *   - one normalized key must be a prefix of the other (handles truncation),
 *   - the shorter key is ≥10 chars (so short generic stems can't collide),
 *   - EXACTLY ONE history key matches (ambiguity → no match, never a guess).
 * The downstream unanimous-+-≥6 gate still has to hold, so even the fuzzy path
 * can't force a wrong auto-post.
 */
const FUZZY_MIN_LEN = 10;

function lookupTallies<T>(
  history: Map<string, T[]>,
  keys: string[]
): T[] | null {
  for (const key of keys) {
    const exact = history.get(key);
    if (exact) return exact;
  }
  for (const key of keys) {
    let hit: T[] | null = null;
    let ambiguous = false;
    for (const [k, tallies] of history) {
      const shorter = k.length <= key.length ? k : key;
      const longer = k.length <= key.length ? key : k;
      if (shorter.length < FUZZY_MIN_LEN) continue;
      if (!longer.startsWith(shorter)) continue;
      if (hit) {
        ambiguous = true; // more than one candidate → ambiguous, bail
        break;
      }
      hit = tallies;
    }
    if (hit && !ambiguous) return hit;
  }
  return null;
}

export interface HistoryVerdict {
  accountId: string;
  /** total clean prior postings for this merchant */
  samples: number;
  /** share that went to `accountId` (1 = unanimous) */
  agreement: number;
  /** passes the strict auto-post gate (unanimous + enough samples) */
  autoPostable: boolean;
}

/**
 * What history says for one merchant, or null if there's no usable precedent.
 * Pass every name you have for the transaction (e.g. Plaid's `merchant_name`
 * AND the raw descriptor `name`) — candidates are tried strongest-first.
 */
export function historyVerdict(
  history: MerchantHistory,
  ...merchants: (string | null | undefined)[]
): HistoryVerdict | null {
  const tallies = lookupTallies(history, candidateKeys(...merchants));
  if (!tallies || !tallies.length) return null;
  const samples = tallies.reduce((n, t) => n + t.count, 0);
  const top = tallies[0];
  const agreement = top.count / samples;
  return {
    accountId: top.accountId,
    samples,
    agreement,
    autoPostable: agreement === 1 && samples >= AUTOPOST_MIN_SAMPLES,
  };
}

// ---------------------------------------------------------------------------
// Cross-ledger (portfolio) precedent
//
// A vendor most ledgers have never seen is often well-established in ANOTHER
// entity's books — every property pays the same utilities, county, and trades.
// Account ids don't travel across entities, so portfolio history tallies by
// normalized ACCOUNT NAME + classification ("gas" + expense) and only resolves
// into the target entity when it has exactly one active account with that same
// name on the same side of the books. Entity-local precedent always wins:
// callers consult this ONLY when the entity's own history has no auto-postable
// verdict, and a conflicting entity verdict vetoes the portfolio one.
// ---------------------------------------------------------------------------

export interface PortfolioTally {
  /** normalized account name, e.g. "gas", "property tax" */
  nameKey: string;
  classification: string;
  count: number;
}
/** normalized merchant → (account name + classification) tallies, desc. */
export type PortfolioHistory = Map<string, PortfolioTally[]>;

const normalizeAccountName = (raw: string | null | undefined): string =>
  (raw ?? "").toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Build the portfolio-wide merchant fingerprint. Single-category entries only,
 * same rule as the per-entity build — but aggregated in SQL (one row per
 * qualifying entry, not one per line) so the whole-portfolio scan stays cheap
 * enough for the interactive suggest path, not just the cron.
 */
export async function buildPortfolioMerchantHistory(): Promise<PortfolioHistory> {
  const rows = (await db.execute(sql`
    select e.name, e.memo,
           (array_agg(l.line_memo) filter (where l.line_memo is not null))[1] as line_memo,
           (array_agg(a.name) filter (where a.account_type not in ('Bank','Credit Card','CreditCard')))[1] as acct_name,
           (array_agg(a.classification) filter (where a.account_type not in ('Bank','Credit Card','CreditCard')))[1] as classification
    from bk_journal_entries e
    join bk_journal_lines l on l.entry_id = e.id
    join bk_accounts a on a.id = l.account_id
    group by e.id
    having count(*) filter (where a.account_type not in ('Bank','Credit Card','CreditCard')) = 1
  `)) as unknown as Array<{
    name: string | null;
    memo: string | null;
    line_memo: string | null;
    acct_name: string | null;
    classification: string | null;
  }>;

  const tally = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const key = normalizeMerchant(
      r.name ?? extractParty({ lineMemo: r.line_memo, memo: r.memo })
    );
    if (key.length < 3) continue;
    const nameKey = normalizeAccountName(r.acct_name);
    if (!nameKey || !r.classification) continue;
    const bucket = `${nameKey}\u0000${r.classification}`;
    const byAcct = tally.get(key) ?? new Map<string, number>();
    byAcct.set(bucket, (byAcct.get(bucket) ?? 0) + 1);
    tally.set(key, byAcct);
  }

  const out: PortfolioHistory = new Map();
  for (const [key, byAcct] of tally) {
    out.set(
      key,
      [...byAcct.entries()]
        .map(([bucket, count]) => {
          const [nameKey, classification] = bucket.split("\u0000");
          return { nameKey, classification, count };
        })
        .sort((a, b) => b.count - a.count)
    );
  }
  return out;
}

export interface TargetAccount {
  id: string;
  name: string | null;
  classification: string | null;
  active: boolean | null;
}

/**
 * What the PORTFOLIO says for one merchant, resolved into `targets` (the
 * candidate entity's accounts). Null when there's no precedent OR the winning
 * (name, classification) doesn't resolve to exactly one active account in this
 * entity — a same-named pair is ambiguous, and a missing account is never
 * auto-created from precedent alone. samples/agreement reflect the whole
 * portfolio, and the auto-post gate is the same unanimous-+-≥6 bar.
 */
export function portfolioVerdict(
  portfolio: PortfolioHistory,
  targets: TargetAccount[],
  ...merchants: (string | null | undefined)[]
): HistoryVerdict | null {
  const tallies = lookupTallies(portfolio, candidateKeys(...merchants));
  if (!tallies || !tallies.length) return null;
  const samples = tallies.reduce((n, t) => n + t.count, 0);
  const top = tallies[0];
  const matches = targets.filter(
    (a) =>
      a.active !== false &&
      a.classification === top.classification &&
      normalizeAccountName(a.name) === top.nameKey
  );
  if (matches.length !== 1) return null;
  const agreement = top.count / samples;
  return {
    accountId: matches[0].id,
    samples,
    agreement,
    autoPostable: agreement === 1 && samples >= AUTOPOST_MIN_SAMPLES,
  };
}

/** Restrict a set of account ids to those still active + postable for the entity. */
export async function activeAccountIds(
  entityId: string,
  accountIds: string[]
): Promise<Set<string>> {
  if (!accountIds.length) return new Set();
  const rows = await db
    .select({ id: bkAccounts.id })
    .from(bkAccounts)
    .where(
      and(
        eq(bkAccounts.entityId, entityId),
        eq(bkAccounts.active, true),
        inArray(bkAccounts.id, accountIds)
      )
    );
  return new Set(rows.map((r) => r.id));
}
