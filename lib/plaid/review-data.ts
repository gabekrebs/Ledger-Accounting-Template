import { and, eq, inArray, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import {
  listItems,
  listPendingTransactions,
  listPostableAccounts,
  getBookedBankLines,
  matchBooked,
  listKnownPayees,
} from "@/lib/plaid/data";
import { readPersistedSuggestions, type PersistedSuggestion } from "@/lib/plaid/suggest-categories";
import { hiddenFromReviewQueue } from "@/lib/plaid/transfer-match";
import { loadRules, selectRule } from "@/lib/rules/engine";
import { extractFacts } from "@/lib/rules/facts";

const { bkPlaidTransactions, bkPlaidAccounts, bkLedgerEntities } = schema;

/**
 * Shared assembly for the transaction REVIEW inbox — used by the per-entity
 * Review tab (app/ledger/[entityId]/bank) and the cross-entity /review queue.
 * One implementation so the enrichment (live rule match, AI suggestion,
 * already-booked proximity flag, mapped-account readiness) can never drift
 * between the two surfaces.
 *
 * AUTHORIZATION NOTE: these helpers do NOT check access — callers are the
 * authorization boundary (`assertEntityAccess` on the entity page;
 * `accessibleEntityIds` filtering on /review). Never expose them to a route
 * without one of those gates.
 */

/** Pending-review counts per entity, one indexed query
 * (bk_plaid_txns_entity_status_idx). `ids === "all"` counts every entity.
 * `settledOnly` excludes rows flagged PENDING AT THE BANK. The sync never
 * stores bank-pending transactions any more, so this filter (like post.ts's
 * refusal) is a defensive guard for pre-policy stragglers — the Review Queue
 * and its badge must only ever count real, settled items.
 * `excludeQueueHidden` applies the /review card-payment quieting (see
 * transfer-match.ts) so the queue badge always agrees with what the queue
 * actually shows — it joins the source feed's account type and classifies in
 * JS, fine at inbox scale (the queue is near-empty by design). */
export async function pendingCountsByEntity(
  ids: Set<string> | "all",
  opts: { settledOnly?: boolean; excludeQueueHidden?: boolean } = {}
): Promise<Map<string, number>> {
  if (ids !== "all" && ids.size === 0) return new Map();
  const conds = [eq(bkPlaidTransactions.status, "pending_review")];
  if (opts.settledOnly) conds.push(eq(bkPlaidTransactions.pending, false));
  if (ids !== "all") conds.push(inArray(bkPlaidTransactions.entityId, [...ids]));
  const where = and(...conds);
  const out = new Map<string, number>();
  if (opts.excludeQueueHidden) {
    const rows = await db
      .select({
        entityId: bkPlaidTransactions.entityId,
        amountCents: bkPlaidTransactions.amountCents,
        name: bkPlaidTransactions.name,
        merchantName: bkPlaidTransactions.merchantName,
        plaidCategory: bkPlaidTransactions.plaidCategory,
        createdAt: bkPlaidTransactions.createdAt,
        txnDate: bkPlaidTransactions.txnDate,
        accountType: bkPlaidAccounts.type,
      })
      .from(bkPlaidTransactions)
      .leftJoin(
        bkPlaidAccounts,
        eq(bkPlaidAccounts.plaidAccountId, bkPlaidTransactions.plaidAccountId)
      )
      .where(where);
    for (const r of rows) {
      if (!r.entityId || hiddenFromReviewQueue(r)) continue;
      out.set(r.entityId, (out.get(r.entityId) ?? 0) + 1);
    }
    return out;
  }
  const rows = await db
    .select({
      entityId: bkPlaidTransactions.entityId,
      n: sql<number>`COUNT(*)::int`,
    })
    .from(bkPlaidTransactions)
    .where(where)
    .groupBy(bkPlaidTransactions.entityId);
  for (const r of rows) if (r.entityId) out.set(r.entityId, Number(r.n));
  return out;
}

/** The pieces the ReviewList client island needs, per entity. Shapes mirror
 * app/ledger/[entityId]/bank exactly (they feed the same component). */
export interface EntityReviewData {
  entityId: string;
  hasItems: boolean;
  pendingCount: number;
  reviewRows: {
    txn: {
      id: string;
      txnDate: string;
      name: string | null;
      merchantName: string | null;
      amountCents: number;
      category: string | null;
      pending: boolean;
      /** Source bank account / card — "Checking ··1234" — so a mixed inbox
       * shows where each line came from. */
      accountLabel: string | null;
      alreadyBooked: { source: string; daysOff: number } | null;
    };
    mappedReady: boolean;
    matchedRule?: { id: string; name: string; autoApply: boolean };
    reviewReason?: string | null;
    merchantKey?: string;
    /** Likely card-payment half still inside its auto-match window — the
     * cross-entity /review queue drops these; the entity tab shows everything. */
    queueHidden: boolean;
  }[];
  postableOpts: { id: string; label: string; classification: string }[];
  initialSuggestions: PersistedSuggestion[];
  knownPayees: string[];
}

export async function buildEntityReviewData(
  entityId: string
): Promise<EntityReviewData> {
  const [items, pending, postable, persistedSugg, knownPayees] =
    await Promise.all([
      listItems(entityId),
      listPendingTransactions(entityId),
      listPostableAccounts(entityId),
      readPersistedSuggestions(entityId),
      listKnownPayees(entityId),
    ]);

  const mapByPlaidAcct = new Map<string, string | null>();
  const subtypeByPlaidAcct = new Map<string, string | null>();
  const typeByPlaidAcct = new Map<string, string | null>();
  const last4ByPlaidAcct = new Map<string, string | null>();
  const labelByPlaidAcct = new Map<string, string>();
  for (const it of items)
    for (const a of it.accounts) {
      mapByPlaidAcct.set(a.plaidAccountId, a.mappedAccountId);
      subtypeByPlaidAcct.set(a.plaidAccountId, a.subtype ?? null);
      typeByPlaidAcct.set(a.plaidAccountId, a.type ?? null);
      last4ByPlaidAcct.set(a.plaidAccountId, a.mask ?? null);
      labelByPlaidAcct.set(
        a.plaidAccountId,
        `${a.name ?? it.institutionName ?? "Account"}${a.mask ? ` ··${a.mask}` : ""}`
      );
    }
  const rules = await loadRules(entityId);
  const factsCtx = { subtypeByPlaidAcct, last4ByPlaidAcct };
  const bankAccountIds = [
    ...new Set([...mapByPlaidAcct.values()].filter((v): v is string => !!v)),
  ];
  const [bookedLines, [entityRow]] = await Promise.all([
    getBookedBankLines(entityId, bankAccountIds),
    db
      .select({ importedThrough: bkLedgerEntities.importedThrough })
      .from(bkLedgerEntities)
      .where(eq(bkLedgerEntities.id, entityId)),
  ]);
  const importedThrough = entityRow?.importedThrough ?? null;

  const reviewRows = pending.map((t) => {
    const mappedAcct = mapByPlaidAcct.get(t.plaidAccountId) ?? null;
    const inImportedWindow =
      !!importedThrough && String(t.txnDate).slice(0, 10) <= importedThrough;
    const m =
      mappedAcct && inImportedWindow
        ? matchBooked(bookedLines, mappedAcct, Math.abs(t.amountCents), t.txnDate)
        : null;
    const alreadyBooked = m
      ? {
          source: m.source === "wave_import" ? "Wave" : "QuickBooks",
          daysOff: m.daysOff,
        }
      : null;
    const facts = extractFacts(t, factsCtx);
    const match = selectRule(rules, facts);
    return {
      txn: {
        id: t.id,
        txnDate: t.txnDate,
        name: t.name,
        merchantName: t.merchantName,
        amountCents: t.amountCents,
        category:
          (t.plaidCategory as { primary?: string } | null)?.primary ?? null,
        pending: t.pending,
        accountLabel: labelByPlaidAcct.get(t.plaidAccountId) ?? null,
        alreadyBooked,
      },
      mappedReady: !!mappedAcct,
      matchedRule: match
        ? { id: match.id, name: match.name, autoApply: match.autoApply }
        : undefined,
      reviewReason: t.reviewReason,
      merchantKey: facts.merchant,
      queueHidden: hiddenFromReviewQueue({
        ...t,
        accountType: typeByPlaidAcct.get(t.plaidAccountId) ?? null,
      }),
    };
  });

  return {
    entityId,
    hasItems: items.length > 0,
    pendingCount: pending.length,
    reviewRows,
    postableOpts: postable.map((a) => ({
      id: a.id,
      label: a.fullyQualifiedName ?? a.name ?? "",
      classification: a.classification,
    })),
    initialSuggestions: Array.from(persistedSugg.values()),
    knownPayees,
  };
}
