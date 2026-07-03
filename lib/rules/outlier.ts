/**
 * Gate 6 — per-transaction sanity guard for auto_apply rules. Philosophy:
 * AUTOMATION-FIRST. A trusted rule should post; we only pause a transaction whose
 * amount is GROSSLY anomalous versus the merchant's own established history
 * (likely a typo, fraud, or mis-read) — the kind of thing worth a human glance.
 *
 * Deliberately permissive: a first-time merchant is NOT deferred (a trusted rule
 * posts it; corrections train the system), an unfamiliar bank account is NOT
 * deferred (a fresh Plaid connection legitimately flows through a new account),
 * and ordinary variance is fine. Only a band that EXISTS and an amount many
 * multiples outside it still defers. The band is the merchant's recent amount
 * envelope (min/max) from single-category posted history.
 */
import { eq, gte, and } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { normalizeMerchant, extractParty } from "@/lib/ledger/merchant";
import type { ReviewReason } from "@/lib/rules/review-reasons";

const BANK_TYPES = new Set(["Bank", "Credit Card", "CreditCard"]);

/** Flag amounts more than this multiple ABOVE the historical max (gross spike). */
export const OUTLIER_MAX_MULT = 8;
/** Flag amounts more than this multiple BELOW the historical min (gross drop). */
export const OUTLIER_MIN_DIV = 8;

export interface MerchantBand {
  minCents: number;
  maxCents: number;
  bankAccounts: Set<string>;
  count: number;
}
export type MerchantBands = Map<string, MerchantBand>;

/**
 * Build the recent amount/bank-account envelope per normalized merchant for one
 * entity (single-category posted history since `sinceISO`). Keyed identically to
 * the learner / engine facts (`normalizeMerchant` of payee, or `extractParty` of
 * the NACHA memo) so a band lookup lines up with the rule's predicate key.
 */
export async function buildMerchantBands(
  entityId: string,
  sinceISO: string
): Promise<MerchantBands> {
  const { bkJournalEntries, bkJournalLines, bkAccounts } = schema;
  const rows = await db
    .select({
      entryId: bkJournalEntries.id,
      name: bkJournalEntries.name,
      memo: bkJournalEntries.memo,
      totalCents: bkJournalEntries.totalCents,
      lineMemo: bkJournalLines.lineMemo,
      accountType: bkAccounts.accountType,
      accountId: bkJournalLines.accountId,
    })
    .from(bkJournalEntries)
    .innerJoin(bkJournalLines, eq(bkJournalLines.entryId, bkJournalEntries.id))
    .innerJoin(bkAccounts, eq(bkAccounts.id, bkJournalLines.accountId))
    .where(
      and(
        eq(bkJournalEntries.entityId, entityId),
        gte(bkJournalEntries.txnDate, sinceISO)
      )
    );

  // Group by entry → keep single-category entries; track the BANK line's account.
  type Slot = { name: string | null; memo: string | null; lineMemo: string | null; total: number; cat: string[]; bank: string | null };
  const byEntry = new Map<string, Slot>();
  for (const r of rows) {
    const s = byEntry.get(r.entryId) ?? { name: r.name, memo: r.memo, lineMemo: null, total: Math.abs(Number(r.totalCents)), cat: [], bank: null };
    if (r.lineMemo && !s.lineMemo) s.lineMemo = r.lineMemo;
    if (BANK_TYPES.has(r.accountType ?? "")) s.bank = r.accountId;
    else s.cat.push(r.accountId);
    byEntry.set(r.entryId, s);
  }

  const bands: MerchantBands = new Map();
  for (const s of byEntry.values()) {
    if (s.cat.length !== 1) continue; // splits/transfers don't define a merchant band
    const key = normalizeMerchant(s.name ?? extractParty({ lineMemo: s.lineMemo, memo: s.memo }));
    if (key.length < 3) continue;
    const b = bands.get(key) ?? { minCents: Infinity, maxCents: 0, bankAccounts: new Set<string>(), count: 0 };
    b.minCents = Math.min(b.minCents, s.total);
    b.maxCents = Math.max(b.maxCents, s.total);
    if (s.bank) b.bankAccounts.add(s.bank);
    b.count++;
    bands.set(key, b);
  }
  return bands;
}

/**
 * Gate 6 verdict for one transaction. Returns a ReviewReason to DEFER, or null
 * to allow (automation-first). A merchant with no established band posts (first
 * sight is fine); only a band that EXISTS with a grossly-off amount defers.
 * Unfamiliar bank accounts no longer defer.
 */
export function gate6(
  facts: { merchant: string; amountCents: number; bankAccountId: string | null },
  band: MerchantBand | undefined
): ReviewReason | null {
  if (!band || band.count === 0) return null; // first time seeing it → trust the rule, post it
  const amt = Math.abs(facts.amountCents);
  if (amt > band.maxCents * OUTLIER_MAX_MULT) return "unusual_amount";
  if (band.minCents > 0 && amt < band.minCents / OUTLIER_MIN_DIV) return "unusual_amount";
  return null;
}
