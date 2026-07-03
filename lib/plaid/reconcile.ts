import { eq, and, max } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import {
  getBookedBankLines,
  matchBooked,
  IMPORT_SOURCES,
  type BookedBankLine,
} from "@/lib/plaid/data";

const { bkPlaidTransactions, bkPlaidAccounts, bkPlaidItems } = schema;

const IMPORTS = new Set<string>(IMPORT_SOURCES);

/**
 * The replace-overlap boundary for an entity: the latest txn date among rows
 * POSTED from a now-replaced connection's accounts. A fresh re-link re-delivers
 * that history under new transaction ids, so any pending line dated on/before
 * this boundary may be a re-delivery of something the old connection already
 * posted. Null when the entity has no replaced-connection history.
 */
async function replacedOverlapBoundary(entityId: string): Promise<string | null> {
  const [row] = await db
    .select({ boundary: max(bkPlaidTransactions.txnDate) })
    .from(bkPlaidTransactions)
    .innerJoin(
      bkPlaidAccounts,
      eq(bkPlaidTransactions.plaidAccountId, bkPlaidAccounts.plaidAccountId)
    )
    .innerJoin(bkPlaidItems, eq(bkPlaidAccounts.itemId, bkPlaidItems.id))
    .where(
      and(
        eq(bkPlaidTransactions.entityId, entityId),
        eq(bkPlaidTransactions.status, "posted"),
        eq(bkPlaidItems.status, "replaced")
      )
    );
  return row?.boundary ? String(row.boundary).slice(0, 10) : null;
}

/**
 * Suppress pending Plaid txns that EXACTLY match a transaction already booked
 * on the same mapped bank account (same |amount|, date within
 * BOOKED_EXACT_DAYS). Matched rows move to status 'already_booked' so they never
 * enter the review inbox and can't be double-posted. Near matches (≤ near window)
 * are intentionally left pending — flagged in the UI, not hidden. Idempotent;
 * returns how many were newly suppressed. Run after every sync, after an
 * account is (re)assigned, and at the top of every auto-post pass.
 *
 * What counts as "booked" depends on the txn's date:
 *   - QBO/Wave import lines always do (the original link-time overlap).
 *   - Lines posted from the bank feed itself (or manually) count ONLY for txns
 *     dated within a replaced connection's overlap window — a re-link
 *     re-delivers already-posted history under new ids. Outside that window two
 *     same-amount charges a day apart are distinct purchases, and both must
 *     stay postable.
 */
export async function reconcileBookedExactMatches(
  entityId: string
): Promise<number> {
  return suppressBookedMatches(entityId, false);
}

/**
 * Bulk-resolve the NEAR matches too — the rows the review inbox flags
 * "already in QuickBooks/Wave (±Nd)" with Post disabled. A 2-3 day drift is a
 * human call, so these are never suppressed automatically; this function IS
 * that human call, made once for the whole inbox instead of row by row (the
 * "Ignore already-booked" button). Marks them 'already_booked' (same terminal
 * status as the exact-match suppression) so they count in the hidden-booked
 * note rather than vanishing as generic ignores. Idempotent.
 */
export async function suppressBookedNearMatches(
  entityId: string
): Promise<number> {
  return suppressBookedMatches(entityId, true);
}

async function suppressBookedMatches(
  entityId: string,
  includeNear: boolean
): Promise<number> {
  const pending = await db
    .select({
      id: bkPlaidTransactions.id,
      plaidAccountId: bkPlaidTransactions.plaidAccountId,
      amountCents: bkPlaidTransactions.amountCents,
      txnDate: bkPlaidTransactions.txnDate,
    })
    .from(bkPlaidTransactions)
    .where(
      and(
        eq(bkPlaidTransactions.entityId, entityId),
        eq(bkPlaidTransactions.status, "pending_review")
      )
    );
  if (!pending.length) return 0;

  // plaid account → its mapped ledger bank account (the booked side to match on).
  const accts = await db
    .select({
      plaidAccountId: bkPlaidAccounts.plaidAccountId,
      mappedAccountId: bkPlaidAccounts.mappedAccountId,
    })
    .from(bkPlaidAccounts)
    .where(eq(bkPlaidAccounts.entityId, entityId));
  const bankOf = new Map(accts.map((a) => [a.plaidAccountId, a.mappedAccountId]));
  const bankIds = [
    ...new Set(
      [...bankOf.values()].filter((v): v is string => !!v)
    ),
  ];
  if (!bankIds.length) return 0;

  const booked = await getBookedBankLines(entityId, bankIds, "all");
  if (!booked.length) return 0;
  const importLines = booked.filter((l) => IMPORTS.has(l.source));
  const boundary = await replacedOverlapBoundary(entityId);

  let suppressed = 0;
  for (const t of pending) {
    const bank = bankOf.get(t.plaidAccountId);
    if (!bank) continue;
    const txnYmd = String(t.txnDate).slice(0, 10);
    const lines: BookedBankLine[] =
      boundary && txnYmd <= boundary ? booked : importLines;
    const m = matchBooked(lines, bank, Math.abs(t.amountCents), txnYmd);
    if (m && (includeNear || m.exact)) {
      await db
        .update(bkPlaidTransactions)
        .set({ status: "already_booked", updatedAt: new Date() })
        .where(eq(bkPlaidTransactions.id, t.id));
      suppressed++;
    }
  }
  return suppressed;
}
