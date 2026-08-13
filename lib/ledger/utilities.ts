import { asc, eq } from "drizzle-orm";
import { inArray, gte, and, ne } from "drizzle-orm";
import { db } from "@/lib/db/client";
import {
  bkPlaidAccounts,
  bkPlaidTransactions,
  bkUtilityGroups,
  bkUtilityMatchers,
} from "@/lib/db/schema";
import {
  utilityMonthKey,
  utilityMonthSpan,
  type UtilityCategory,
  type UtilityGroupReport,
  type UtilityMonthRow,
} from "@/lib/ledger/utilities-shared";

/**
 * Utility tracker — Plaid-sourced owner-covered utilities per building.
 * Config lives in bk_utility_groups / bk_utility_matchers (see schema.ts);
 * this module is read-only aggregation. Matching happens in JS over one
 * bulk query (a handful of matchers × a few hundred rows — trivial), so the
 * exact matching rule lives in one visible place: a transaction counts for
 * a category when it sits on the matcher's BANK ACCOUNT and its raw
 * descriptor contains the matcher's fragment, case-insensitively. Pending
 * rows never count (they re-post); ignored rows never count.
 */

/** Does this entity track utilities? (gates the nav tab) */
export async function entityHasUtilities(entityId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: bkUtilityGroups.id })
    .from(bkUtilityGroups)
    .where(eq(bkUtilityGroups.entityId, entityId))
    .limit(1);
  return !!row;
}

/** Current LA month as 'YYYY-MM-01' (ledger-local copy — operational "today"
 *  is the owner's local day). */
function laMonth(now: Date): string {
  const d = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  return utilityMonthKey(d);
}

export async function utilityReport(
  entityId: string,
  now = new Date()
): Promise<UtilityGroupReport[]> {
  const groups = await db
    .select()
    .from(bkUtilityGroups)
    .where(eq(bkUtilityGroups.entityId, entityId))
    .orderBy(asc(bkUtilityGroups.sortOrder), asc(bkUtilityGroups.name));
  if (groups.length === 0) return [];

  const matchers = await db
    .select({
      groupId: bkUtilityMatchers.groupId,
      category: bkUtilityMatchers.category,
      matchContains: bkUtilityMatchers.matchContains,
      plaidAccountId: bkUtilityMatchers.plaidAccountId,
      optional: bkUtilityMatchers.optional,
      sortOrder: bkUtilityMatchers.sortOrder,
      plaidAccountExtId: bkPlaidAccounts.plaidAccountId,
    })
    .from(bkUtilityMatchers)
    .innerJoin(bkPlaidAccounts, eq(bkUtilityMatchers.plaidAccountId, bkPlaidAccounts.id))
    .where(
      inArray(
        bkUtilityMatchers.groupId,
        groups.map((g) => g.id)
      )
    )
    .orderBy(asc(bkUtilityMatchers.sortOrder));

  const minStart = groups.map((g) => g.trackingStart).sort()[0];
  const accountExtIds = [...new Set(matchers.map((m) => m.plaidAccountExtId))];
  const txns = accountExtIds.length
    ? await db
        .select({
          plaidAccountId: bkPlaidTransactions.plaidAccountId,
          txnDate: bkPlaidTransactions.txnDate,
          name: bkPlaidTransactions.name,
          amountCents: bkPlaidTransactions.amountCents,
        })
        .from(bkPlaidTransactions)
        .where(
          and(
            inArray(bkPlaidTransactions.plaidAccountId, accountExtIds),
            gte(bkPlaidTransactions.txnDate, minStart),
            eq(bkPlaidTransactions.pending, false),
            ne(bkPlaidTransactions.status, "ignored")
          )
        )
    : [];

  const end = laMonth(now);
  return groups.map((g): UtilityGroupReport => {
    const gm = matchers.filter((m) => m.groupId === g.id);
    // Matchers may share a category (several accounts, one label) — dedupe,
    // keeping first-sort order and OR-ing optional? No: a category is optional
    // only when every matcher in it is (a required matcher anchors it).
    const categories: UtilityCategory[] = [];
    for (const m of gm) {
      const existing = categories.find((c) => c.name === m.category);
      if (!existing) categories.push({ name: m.category, optional: m.optional });
      else existing.optional = existing.optional && m.optional;
    }
    const months = utilityMonthSpan(g.trackingStart, end);
    const rows: UtilityMonthRow[] = months.map((month) => ({
      month,
      cells: Object.fromEntries(categories.map((c) => [c.name, 0])),
      inProgress: month === end,
    }));
    const rowByMonth = new Map(rows.map((r) => [r.month, r]));
    for (const t of txns) {
      if (t.txnDate < g.trackingStart) continue;
      const raw = (t.name ?? "").toLowerCase();
      const hit = gm.find(
        (m) =>
          m.plaidAccountExtId === t.plaidAccountId &&
          raw.includes(m.matchContains.toLowerCase())
      );
      if (!hit) continue;
      const row = rowByMonth.get(utilityMonthKey(t.txnDate));
      if (row) row.cells[hit.category] += t.amountCents;
    }
    return {
      id: g.id,
      name: g.name,
      trackingStart: g.trackingStart,
      categories,
      months: rows,
    };
  });
}
