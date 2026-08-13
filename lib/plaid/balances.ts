import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { getPlaid, safePlaidError } from "@/lib/plaid/client";
import { decryptToken } from "@/lib/plaid/crypto";

const { bkPlaidItems, bkPlaidAccounts } = schema;

/**
 * Live balances straight from the bank, for the Reconciliation view's
 * book-vs-bank comparison. READ-ONLY — `accountsBalanceGet` never touches the
 * transaction cursor or the staging inbox, so calling it at render time can't
 * disturb the sync pipeline.
 *
 * Sign convention matches the ledger's NATURAL sign: Plaid reports `current`
 * positive for money in a depository account AND positive for a balance owed on
 * credit/loan accounts — exactly how `toNaturalSign` renders the book side — so
 * the two compare directly, no per-type flipping.
 */

/**
 * The Items holding this entity's mapped accounts. Items are provenance only —
 * ACCOUNT assignment is the source of truth for entity ownership, so resolve
 * the Items via the entity's mapped accounts.
 */
async function mappedItems(entityId: string) {
  const links = await db
    .select({ itemId: bkPlaidAccounts.itemId })
    .from(bkPlaidAccounts)
    .where(
      and(
        eq(bkPlaidAccounts.entityId, entityId),
        isNotNull(bkPlaidAccounts.mappedAccountId)
      )
    );
  const itemIds = [...new Set(links.map((l) => l.itemId))];
  if (itemIds.length === 0) return [];
  return db
    .select({
      id: bkPlaidItems.id,
      accessToken: bkPlaidItems.accessToken,
      institutionName: bkPlaidItems.institutionName,
    })
    .from(bkPlaidItems)
    .where(inArray(bkPlaidItems.id, itemIds));
}

/**
 * Fetch the bank-reported CURRENT balance for every Plaid account on the Items
 * that hold this entity's mapped accounts. Returns Map<plaid_account_id,
 * balanceCents>.
 *
 * FAIL-SOFT by design: one Item in `login_required` (or any Plaid error) must
 * not take down the whole page, so a failed Item is logged (safely — never the
 * raw AxiosError, it carries the API secret) and simply contributes no entries;
 * callers render those accounts as "balance unavailable".
 */
export async function livePlaidBalanceCents(
  entityId: string
): Promise<Map<string, number>> {
  const balances = new Map<string, number>();
  const items = await mappedItems(entityId);
  if (items.length === 0) return balances;

  const plaid = getPlaid();
  // One call per Item (Plaid's unit of auth), in parallel — a page render
  // shouldn't serialize bank round-trips.
  await Promise.all(
    items.map(async (item) => {
      try {
        const res = await plaid.accountsBalanceGet({
          access_token: decryptToken(item.accessToken),
        });
        for (const acct of res.data.accounts) {
          const current = acct.balances?.current;
          if (current == null) continue; // Plaid can omit it; skip, don't guess
          balances.set(acct.account_id, Math.round(current * 100));
        }
      } catch (err) {
        console.error(
          `[plaid] balance fetch failed for ${item.institutionName ?? item.id}: ${safePlaidError(err)}`
        );
      }
    })
  );
  return balances;
}

/** How far back to look for bank-pending txns — they settle in days, not weeks. */
const PENDING_LOOKBACK_DAYS = 30;

/**
 * Sum of the bank's PENDING transactions per Plaid account, fetched live for
 * the Reconciliation view. Staging deliberately stores no pending rows (sync
 * filters them — a pending txn must never be postable), but institutions that
 * include pending activity in their reported current balance (credit cards
 * especially) leave the book "off" by exactly this sum until charges settle,
 * so the recon math needs it to explain the variance.
 *
 * READ-ONLY and cursor-safe: `/transactions/get` never touches the
 * `/transactions/sync` cursor or the staging inbox. Same fail-soft contract as
 * livePlaidBalanceCents — a failed Item just contributes no entries. Amounts
 * keep Plaid's sign convention (positive = outflow / new charge), matching the
 * staged rows the caller nets alongside these.
 */
export async function livePlaidPendingCents(
  entityId: string
): Promise<Map<string, { sumCents: number; n: number }>> {
  const pending = new Map<string, { sumCents: number; n: number }>();
  const items = await mappedItems(entityId);
  if (items.length === 0) return pending;

  const ymd = (d: Date) => d.toISOString().slice(0, 10);
  const end = new Date();
  const start = new Date(end.getTime() - PENDING_LOOKBACK_DAYS * 86_400_000);

  const plaid = getPlaid();
  await Promise.all(
    items.map(async (item) => {
      try {
        const token = decryptToken(item.accessToken);
        // Paginated, but pending txns are recent and few — one page is the
        // norm; the cap is a runaway guard, not an expected limit.
        let offset = 0;
        for (let page = 0; page < 4; page++) {
          const res = await plaid.transactionsGet({
            access_token: token,
            start_date: ymd(start),
            end_date: ymd(end),
            options: { count: 500, offset },
          });
          for (const t of res.data.transactions) {
            if (!t.pending) continue;
            const cur = pending.get(t.account_id) ?? { sumCents: 0, n: 0 };
            cur.sumCents += Math.round(t.amount * 100);
            cur.n += 1;
            pending.set(t.account_id, cur);
          }
          offset += res.data.transactions.length;
          if (offset >= res.data.total_transactions || res.data.transactions.length === 0) break;
        }
      } catch (err) {
        console.error(
          `[plaid] pending fetch failed for ${item.institutionName ?? item.id}: ${safePlaidError(err)}`
        );
      }
    })
  );
  return pending;
}
