import { and, eq, ne, inArray, isNotNull } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { getPlaid } from "@/lib/plaid/client";
import { decryptToken } from "@/lib/plaid/crypto";
import { restampPendingForAccount } from "@/lib/plaid/sync";
import { reconcileBookedExactMatches } from "@/lib/plaid/reconcile";

const { bkPlaidItems, bkPlaidAccounts, bkPlaidTransactions } = schema;

/**
 * Replace-connection flow — the only way to deepen a bank's transaction history.
 *
 * Plaid locks days_requested the moment Transactions initializes on an Item
 * ("Once Transactions has been added to an Item, this value cannot be updated"),
 * so an item linked at the 90-day default can never reach 730 days in place —
 * the Item must be removed and the bank linked fresh. A naive disconnect loses
 * two things a re-link can't recover: the per-account entity assignments (33
 * dropdowns on a big login) and the provenance of already-posted staging rows.
 *
 * So instead of deleting, `markItemReplaced` retires the Item to a tombstone:
 * status 'replaced', accounts + assignments kept as the migration map, posted
 * staging rows kept for provenance/unpost. Plaid-side the Item is removed
 * (stops billing). Replaced items are excluded from sync, the webhook, the
 * connections UI, and duplicate detection.
 *
 * When the SAME institution is then linked fresh, `migrateReplacedAssignments`
 * (called from the exchange route, before the initial sync so incoming txns are
 * stamped correctly) copies each assignment old → new by account mask+name and
 * clears it off the tombstone. The ~90-day overlap the new item re-delivers is
 * suppressed by reconcileBookedExactMatches, which matches against EVERYTHING
 * already on the mapped bank account — including entries the old item posted.
 */

export async function markItemReplaced(
  itemId: string
): Promise<{ ok: boolean; error?: string }> {
  const [item] = await db
    .select()
    .from(bkPlaidItems)
    .where(eq(bkPlaidItems.id, itemId));
  if (!item) return { ok: false, error: "Connection not found" };
  if (item.status === "replaced") {
    return { ok: false, error: "Connection is already replaced" };
  }

  // Plaid-side removal stops billing. Best-effort — tolerate already-removed.
  try {
    await getPlaid().itemRemove({
      access_token: decryptToken(item.accessToken),
    });
  } catch {
    // The tombstone below is what matters locally; a stale Plaid Item stops
    // billing once we never call it again.
  }

  // Drop the un-posted staging rows (the fresh link re-delivers this window
  // with new transaction ids). Posted rows stay — they're the provenance link
  // behind journal entries that must survive the swap.
  const accounts = await db
    .select({ plaidAccountId: bkPlaidAccounts.plaidAccountId })
    .from(bkPlaidAccounts)
    .where(eq(bkPlaidAccounts.itemId, itemId));
  const plaidAccountIds = accounts.map((a) => a.plaidAccountId);
  if (plaidAccountIds.length) {
    await db
      .delete(bkPlaidTransactions)
      .where(
        and(
          inArray(bkPlaidTransactions.plaidAccountId, plaidAccountIds),
          ne(bkPlaidTransactions.status, "posted")
        )
      );
  }

  await db
    .update(bkPlaidItems)
    .set({ status: "replaced", lastError: null, updatedAt: new Date() })
    .where(eq(bkPlaidItems.id, itemId));

  return { ok: true };
}

/**
 * Copy account assignments from this institution's replaced (tombstoned) items
 * onto the freshly linked item's accounts, matching by mask (+ name when one
 * mask appears twice). Clears each migrated assignment off the tombstone so the
 * account can't be double-mapped. Returns how many assignments were restored.
 *
 * Call BEFORE the new item's first sync: the sync stamps each transaction with
 * its account's entity, so assignments must be in place when the rows land.
 */
export async function migrateReplacedAssignments(
  newItemId: string
): Promise<{ migrated: number; entityIds: string[] }> {
  const none = { migrated: 0, entityIds: [] };
  const [newItem] = await db
    .select()
    .from(bkPlaidItems)
    .where(eq(bkPlaidItems.id, newItemId));
  if (!newItem) return none;

  const replacedItems = await db
    .select({ id: bkPlaidItems.id })
    .from(bkPlaidItems)
    .where(
      and(
        eq(bkPlaidItems.status, "replaced"),
        newItem.institutionId
          ? eq(bkPlaidItems.institutionId, newItem.institutionId)
          : eq(bkPlaidItems.institutionName, newItem.institutionName ?? "")
      )
    );
  if (!replacedItems.length) return none;
  const replacedIds = replacedItems.map((r) => r.id);

  const oldAccounts = await db
    .select()
    .from(bkPlaidAccounts)
    .where(
      and(
        inArray(bkPlaidAccounts.itemId, replacedIds),
        isNotNull(bkPlaidAccounts.entityId)
      )
    );
  if (!oldAccounts.length) return none;

  const newAccounts = await db
    .select()
    .from(bkPlaidAccounts)
    .where(eq(bkPlaidAccounts.itemId, newItemId));

  let migrated = 0;
  const touchedEntities = new Set<string>();
  for (const na of newAccounts) {
    if (na.entityId) continue; // already assigned — don't overwrite
    const byMask = oldAccounts.filter(
      (o) => o.entityId && o.mask && o.mask === na.mask
    );
    const match =
      byMask.length === 1
        ? byMask[0]
        : byMask.find((o) => (o.name ?? "") === (na.name ?? ""));
    if (!match?.entityId) continue;
    const entityId = match.entityId;
    const mappedAccountId = match.mappedAccountId;

    await db
      .update(bkPlaidAccounts)
      .set({ entityId, mappedAccountId, updatedAt: new Date() })
      .where(eq(bkPlaidAccounts.id, na.id));
    await db
      .update(bkPlaidAccounts)
      .set({ entityId: null, mappedAccountId: null, updatedAt: new Date() })
      .where(eq(bkPlaidAccounts.id, match.id));
    // Consume in-memory too, so a second new account with the same mask can't
    // claim the same assignment.
    match.entityId = null;
    match.mappedAccountId = null;

    await restampPendingForAccount(na.plaidAccountId, entityId);
    touchedEntities.add(entityId);
    migrated++;
  }

  return { migrated, entityIds: [...touchedEntities] };
}

/**
 * Suppress the overlap window after a replace + re-link: the fresh item
 * re-delivers ~the old item's whole history with new transaction ids, and
 * everything the old item already posted must not be re-postable. Run AFTER the
 * new item's first sync (there's nothing to reconcile before rows land).
 */
export async function reconcileEntitiesAfterReplace(
  entityIds: string[]
): Promise<number> {
  let suppressed = 0;
  for (const id of entityIds) {
    suppressed += await reconcileBookedExactMatches(id);
  }
  return suppressed;
}
