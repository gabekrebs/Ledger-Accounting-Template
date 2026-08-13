import { eq, and, inArray, isNotNull, ne, sql } from "drizzle-orm";
import type { Transaction } from "plaid";
import { db, schema } from "@/lib/db/client";
import { getPlaid } from "@/lib/plaid/client";
import { decryptToken } from "@/lib/plaid/crypto";
import { reconcileBookedExactMatches } from "@/lib/plaid/reconcile";

const { bkPlaidItems, bkPlaidAccounts, bkPlaidTransactions, bkAuditLog } = schema;

type ItemRow = typeof bkPlaidItems.$inferSelect;

function toCents(amount: number | null | undefined): number {
  return Math.round((amount ?? 0) * 100);
}

/**
 * Map a Plaid transaction to a staging row. The entity is the txn's ACCOUNT
 * assignment (entityForAccount) — NOT the Item's. A txn whose account isn't
 * routed to a business yet gets entityId=null and sits out of every inbox until
 * the account is assigned (at which point its pending rows are re-stamped).
 */
function toRow(entityId: string | null, t: Transaction) {
  return {
    entityId,
    plaidAccountId: t.account_id,
    plaidTransactionId: t.transaction_id,
    pending: t.pending,
    txnDate: t.date, // ISO yyyy-mm-dd
    name: t.name ?? null,
    merchantName: t.merchant_name ?? null,
    amountCents: toCents(t.amount),
    isoCurrencyCode: t.iso_currency_code ?? t.unofficial_currency_code ?? null,
    plaidCategory:
      t.personal_finance_category ??
      (t.category ? { legacy: t.category } : null),
    raw: t as unknown,
    updatedAt: new Date(),
  };
}

/**
 * Surface (never apply) Plaid changes to transactions we already posted or
 * ignored. Their staged financial fields are frozen (see the upsert's WHERE),
 * so when the bank's version of amount/date/name diverges from what the books
 * were written from, this files a `plaid_source_drift` row in the owner's
 * review log (/teamactivity) instead of silently mutating anything.
 * Best-effort: a logging failure must never abort the sync.
 */
async function flagPostedDrift(txns: Transaction[]): Promise<void> {
  try {
    const frozen = await db
      .select({
        id: bkPlaidTransactions.id,
        plaidTransactionId: bkPlaidTransactions.plaidTransactionId,
        entityId: bkPlaidTransactions.entityId,
        status: bkPlaidTransactions.status,
        txnDate: bkPlaidTransactions.txnDate,
        name: bkPlaidTransactions.name,
        amountCents: bkPlaidTransactions.amountCents,
      })
      .from(bkPlaidTransactions)
      .where(
        and(
          inArray(
            bkPlaidTransactions.plaidTransactionId,
            txns.map((t) => t.transaction_id)
          ),
          ne(bkPlaidTransactions.status, "pending_review")
        )
      );
    if (!frozen.length) return;
    const incoming = new Map(txns.map((t) => [t.transaction_id, t]));
    for (const row of frozen) {
      const t = incoming.get(row.plaidTransactionId);
      if (!t || !row.entityId) continue;
      const newCents = toCents(t.amount);
      const changes: string[] = [];
      if (newCents !== Number(row.amountCents)) {
        changes.push(
          `amount $${(Number(row.amountCents) / 100).toFixed(2)} → $${(newCents / 100).toFixed(2)}`
        );
      }
      if (t.date !== row.txnDate) changes.push(`date ${row.txnDate} → ${t.date}`);
      if ((t.name ?? null) !== row.name) changes.push(`descriptor changed`);
      if (!changes.length) continue;
      await db.insert(bkAuditLog).values({
        actorEmail: "plaid-sync",
        actorRole: "system",
        entityId: row.entityId,
        actionType: "plaid_source_drift",
        objectTable: "bk_plaid_transactions",
        objectId: row.id,
        description:
          `Bank changed a ${row.status} transaction ("${row.name ?? "?"}", ` +
          `${row.txnDate}) after it was booked: ${changes.join("; ")}. ` +
          `The books were left untouched — review and correct manually if needed.`,
        afterJson: { plaidTransactionId: row.plaidTransactionId, changes },
        affectedLedger: true,
      });
    }
  } catch (e) {
    console.error("plaid sync: drift flagging failed:", e);
  }
}

/**
 * Pull all new/changed transactions for one linked Item via Plaid's cursor-based
 * /transactions/sync, into the bk_plaid_transactions staging inbox. Idempotent:
 * upserts on plaid_transaction_id, persists the cursor so each run is a delta.
 *
 * Each transaction is stamped with its OWN account's current entity assignment,
 * so a single Item whose accounts fan out to many entities routes each line to
 * the right business. Removed transactions are deleted only while still
 * pending_review (a posted one would need a reversing entry — milestone 2).
 */
export async function syncItemTransactions(item: ItemRow): Promise<{
  /** Rows actually WRITTEN to staging from Plaid's `added` delta — bank-pending
   * and sync-excluded transactions are filtered before storage, and frozen
   * (posted/ignored) rows are never rewritten, so this is smaller than Plaid's
   * raw count whenever any were skipped. */
  added: number;
  /** Rows actually UPDATED in staging from Plaid's `modified` delta (same
   * filtering; a modified txn hitting a frozen row counts 0 and is surfaced by
   * flagPostedDrift instead). */
  modified: number;
  removed: number;
}> {
  const plaid = getPlaid();
  const accessToken = decryptToken(item.accessToken);

  // account_id → assigned entity (null = unassigned). Rebuilt each sync so a
  // reassignment is reflected on the next pull. sync_excluded accounts (e.g. a
  // personal card a bank login forced along) are never stored at all.
  const accts = await db
    .select({
      plaidAccountId: bkPlaidAccounts.plaidAccountId,
      entityId: bkPlaidAccounts.entityId,
      syncExcluded: bkPlaidAccounts.syncExcluded,
    })
    .from(bkPlaidAccounts)
    .where(eq(bkPlaidAccounts.itemId, item.id));
  const entityForAccount = new Map<string, string | null>();
  const excludedAccounts = new Set<string>();
  for (const a of accts) {
    entityForAccount.set(a.plaidAccountId, a.entityId);
    if (a.syncExcluded) excludedAccounts.add(a.plaidAccountId);
  }

  let cursor = item.txnCursor ?? undefined;
  let added = 0;
  let modified = 0;
  let removed = 0;

  try {
    for (;;) {
      const resp = await plaid.transactionsSync({
        access_token: accessToken,
        cursor,
        count: 500,
      });
      const data = resp.data;

      // Batch the whole page in one statement — a 24-month backfill is tens of
      // thousands of rows, and per-row round-trips made the drain outlive the
      // serverless time cap (the cursor only persists after a COMPLETE drain,
      // so a timeout meant nothing was saved, ever). `excluded.*` keeps upsert
      // semantics identical to the old per-row version.
      //
      // Only rows still `pending_review` accept updates (the WHERE below): a
      // posted/ignored row's financial fields are FROZEN — the journal was
      // written from them, and Plaid silently rewriting amount/date/name under
      // a posted entry would desync the books from their source. When Plaid
      // does change a settled txn after we posted it, flagPostedDrift() surfaces
      // it on /teamactivity as a review concern instead.
      //
      // Bank-PENDING transactions are never stored (owner request 2026-07-21,
      // Wave/QuickBooks behavior): they can change amount or vanish, so they
      // must not appear anywhere in the system. The settled version arrives
      // later as its own transaction_id and enters staging normally; a
      // cancelled pending simply never existed here.
      // Returns the number of rows the statement actually wrote (inserted or
      // updated) — filtered-out and frozen rows don't count, so the totals the
      // caller reports are stored counts, not raw Plaid delta sizes.
      const upsertBatch = async (txns: Transaction[]): Promise<number> => {
        txns = txns.filter(
          (t) => !excludedAccounts.has(t.account_id) && !t.pending
        );
        if (!txns.length) return 0;
        await flagPostedDrift(txns);
        const rows = txns.map((t) =>
          toRow(entityForAccount.get(t.account_id) ?? null, t)
        );
        const res = await db
          .insert(bkPlaidTransactions)
          .values(rows)
          .onConflictDoUpdate({
            target: bkPlaidTransactions.plaidTransactionId,
            set: {
              entityId: sql`excluded.entity_id`,
              pending: sql`excluded.pending`,
              txnDate: sql`excluded.txn_date`,
              name: sql`excluded.name`,
              merchantName: sql`excluded.merchant_name`,
              amountCents: sql`excluded.amount_cents`,
              isoCurrencyCode: sql`excluded.iso_currency_code`,
              plaidCategory: sql`excluded.plaid_category`,
              raw: sql`excluded.raw`,
              updatedAt: sql`excluded.updated_at`,
            },
            setWhere: sql`${bkPlaidTransactions.status} = 'pending_review'`,
          });
        return res.count ?? rows.length;
      };
      added += await upsertBatch(data.added);
      modified += await upsertBatch(data.modified);
      const removedIds = data.removed
        .map((r) => r.transaction_id)
        .filter((id): id is string => !!id);
      if (removedIds.length) {
        const res = await db
          .delete(bkPlaidTransactions)
          .where(
            and(
              inArray(bkPlaidTransactions.plaidTransactionId, removedIds),
              eq(bkPlaidTransactions.status, "pending_review")
            )
          );
        removed += res.count ?? removedIds.length;
      }

      // Pending→settled reconciliation. A SETTLED transaction carries
      // `pending_transaction_id` pointing at the pending row it replaces.
      // New pending rows are no longer stored (filter above), so this delete
      // is a safety net for any legacy pending row still in staging. Only
      // pending_review rows are touched (a posted/already_booked one is left as
      // is), so this can never unpost real money.
      const supersededIds = [...data.added, ...data.modified]
        .map((t) => t.pending_transaction_id)
        .filter((id): id is string => !!id);
      if (supersededIds.length) {
        const res = await db
          .delete(bkPlaidTransactions)
          .where(
            and(
              inArray(bkPlaidTransactions.plaidTransactionId, supersededIds),
              eq(bkPlaidTransactions.status, "pending_review")
            )
          );
        removed += res.count ?? 0;
      }

      cursor = data.next_cursor;
      if (!data.has_more) break;
    }

    await db
      .update(bkPlaidItems)
      .set({
        txnCursor: cursor ?? null,
        lastSyncedAt: new Date(),
        status: "active",
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(bkPlaidItems.id, item.id));

    return { added, modified, removed };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .update(bkPlaidItems)
      .set({ status: "error", lastError: message, updatedAt: new Date() })
      .where(eq(bkPlaidItems.id, item.id));
    throw err;
  }
}

/** Sync every linked Item (the global "Sync now" + the nightly cron). */
export async function syncAllItems() {
  // Replaced items are tombstones — removed Plaid-side, kept locally only for
  // posted-row provenance and assignment migration. Nothing to sync.
  const items = (await db.select().from(bkPlaidItems)).filter(
    (it) => it.status !== "replaced"
  );
  const results = [];
  for (const item of items) {
    const counts = await syncItemTransactions(item);
    results.push({ itemId: item.id, ...counts });
  }
  // Suppress newly-synced lines already booked by QBO/Wave, per assigned entity.
  const assigned = await db
    .selectDistinct({ entityId: bkPlaidAccounts.entityId })
    .from(bkPlaidAccounts)
    .where(isNotNull(bkPlaidAccounts.entityId));
  for (const a of assigned) {
    if (a.entityId) await reconcileBookedExactMatches(a.entityId);
  }
  return results;
}

/**
 * Sync the Items that hold at least one account assigned to this entity (the
 * per-entity "Sync now" on a Bank tab). Items are no longer owned by an entity,
 * so we resolve them through the account assignments.
 */
export async function syncEntityTransactions(entityId: string) {
  const rows = await db
    .selectDistinct({ itemId: bkPlaidAccounts.itemId })
    .from(bkPlaidAccounts)
    .where(eq(bkPlaidAccounts.entityId, entityId));
  const itemIds = rows.map((r) => r.itemId);
  if (!itemIds.length) return [];

  const items = (
    await db.select().from(bkPlaidItems).where(inArray(bkPlaidItems.id, itemIds))
  ).filter((it) => it.status !== "replaced");

  const results = [];
  for (const item of items) {
    const counts = await syncItemTransactions(item);
    results.push({ itemId: item.id, ...counts });
  }
  await reconcileBookedExactMatches(entityId);
  return results;
}

/**
 * Re-stamp a Plaid account's already-staged, still-pending transactions onto a
 * new entity when the account is (re)assigned. Posted rows are left alone — they
 * are already in the immutable journal of their old entity and moving them would
 * corrupt the books; only their pending lines follow the reassignment. Returns
 * the number of pending rows re-routed.
 */
export async function restampPendingForAccount(
  plaidAccountId: string,
  newEntityId: string | null
): Promise<number> {
  const res = await db
    .update(bkPlaidTransactions)
    .set({ entityId: newEntityId, updatedAt: new Date() })
    .where(
      and(
        eq(bkPlaidTransactions.plaidAccountId, plaidAccountId),
        eq(bkPlaidTransactions.status, "pending_review")
      )
    );
  return res.count ?? 0;
}
