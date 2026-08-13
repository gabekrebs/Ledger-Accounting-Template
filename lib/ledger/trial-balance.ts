import { and, eq, lte, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";

const { bkJournalEntries, bkJournalLines, bkAccounts, bkLedgerEntities } = schema;

/**
 * CPA trial balance — the year-end workpaper the accountant starts from
 * (their "Unadjusted" column; they layer AJEs on top in their own workbook).
 *
 * Built from the ENTRY's entity, not the account's. The distinction matters:
 * when a property is split out of a holding entity, its prefixed accounts MOVE
 * to the new entity while the historical journal entries stay behind — so
 * hundreds of balanced historical entries can carry lines pointing at
 * another entity's accounts. Summing by account-entity leaves both entities'
 * books individually unbalanced; summing by entry-entity keeps every TB
 * balanced BY CONSTRUCTION (each entry is internally balanced and date
 * cutoffs never split an entry). It also reproduces the CPA's historical
 * workpapers exactly, G: rows included.
 *
 * Shape follows the CPA's existing working TB:
 *   • SIGNED balances — debits positive, credits negative (net = dr − cr).
 *   • Balance-sheet accounts: CUMULATIVE through 12/31 of the report year.
 *   • P&L accounts: activity WITHIN the report year only.
 *   • "Profit for all prior years" — computed equity row (this ledger never
 *     closes years; credit-negative when historically profitable).
 *   • "Net Income" — display subtotal of the P&L rows.
 *   • "Check Total" — Σ(everything incl. prior-years row). The TOTAL column
 *     is exactly zero; individual ACTIVITY columns may legitimately be
 *     non-zero (one activity's cash funding another's items shifts equity
 *     between columns — that per-column residue IS the inter-activity
 *     balance, informative to the CPA, not an error).
 *
 * Activity columns are DYNAMIC: one per distinct bk_accounts.activity tag
 * carrying a value. A line whose account lives in a DIFFERENT entity is
 * columned under that entity's NAME — matching how a CPA would break the
 * property out as its own column pre-split. Entities with a
 * single column collapse to a plain Balance column. All-zero rows are omitted.
 */

/** Statement order for TB rows — assets → liabilities → equity → income → expenses. */
const CLS_ORDER: Record<string, number> = {
  asset: 0,
  liability: 1,
  equity: 2,
  revenue: 3,
  expense: 4,
};

const PL = new Set(["revenue", "expense"]);

export interface TrialBalanceRow {
  code: string; // qbo_account_id — stable identifier
  name: string;
  classification: string;
  accountType: string;
  /** Column this row lands in: the account's activity tag, or the owning
   * entity's name when the account belongs to another entity. */
  activity: string;
  byActivity: Record<string, number>;
  totalCents: number;
}

export interface TrialBalance {
  entityId: string;
  year: number;
  asOf: string; // yyyy-12-31
  /** Column order; empty = single column ("Balance"). */
  activities: string[];
  /** Subset of `activities` that are OTHER ENTITIES' names (cross-entity
   * lines from a split), not activity tags — drives the explanatory note. */
  foreignColumns: string[];
  rows: TrialBalanceRow[];
  priorYearsProfit: Record<string, number>;
  priorYearsProfitTotal: number;
  netIncome: Record<string, number>;
  netIncomeTotal: number;
  checkTotal: Record<string, number>;
  /** Always 0 — per-entry balance + whole-entry cutoffs guarantee it. */
  checkTotalTotal: number;
}

export async function buildTrialBalance(
  entityId: string,
  year: number
): Promise<TrialBalance> {
  const asOf = `${year}-12-31`;
  const yearStart = `${year}-01-01`;

  // One pass: every line of this entity's entries through 12/31, joined to its
  // account WHEREVER that account lives, with conditional sums for the two
  // windows (cumulative ≤ asOf is the row filter; in-year is the CASE).
  const rows = await db
    .select({
      code: bkAccounts.qboAccountId,
      name: bkAccounts.name,
      classification: bkAccounts.classification,
      accountType: bkAccounts.accountType,
      activity: bkAccounts.activity,
      acctEntityId: bkAccounts.entityId,
      ownerName: bkLedgerEntities.name,
      cumCents: sql<string>`COALESCE(SUM(${bkJournalLines.debitCents} - ${bkJournalLines.creditCents}), 0)`,
      inYearCents: sql<string>`COALESCE(SUM(CASE WHEN ${bkJournalEntries.txnDate} >= ${yearStart} THEN ${bkJournalLines.debitCents} - ${bkJournalLines.creditCents} ELSE 0 END), 0)`,
    })
    .from(bkJournalLines)
    .innerJoin(bkJournalEntries, eq(bkJournalEntries.id, bkJournalLines.entryId))
    .innerJoin(bkAccounts, eq(bkAccounts.id, bkJournalLines.accountId))
    .innerJoin(bkLedgerEntities, eq(bkLedgerEntities.id, bkAccounts.entityId))
    .where(
      and(
        eq(bkJournalEntries.entityId, entityId),
        lte(bkJournalEntries.txnDate, asOf)
      )
    )
    .groupBy(
      bkAccounts.qboAccountId,
      bkAccounts.name,
      bkAccounts.classification,
      bkAccounts.accountType,
      bkAccounts.activity,
      bkAccounts.entityId,
      bkLedgerEntities.name
    );

  const tbRows: TrialBalanceRow[] = [];
  const priorByActivity: Record<string, number> = {};
  const foreignSet = new Set<string>();
  let priorTotal = 0;

  for (const r of rows) {
    const cum = Number(r.cumCents);
    const inYear = Number(r.inYearCents);
    const isPL = PL.has(r.classification);
    // Foreign-entity accounts column under their owner's name — the account's
    // own activity tag describes ITS entity's segments, not this one's.
    const foreign = r.acctEntityId !== entityId;
    const column = foreign ? (r.ownerName ?? "Other entity") : r.activity;
    if (foreign) foreignSet.add(column);

    if (isPL) {
      const prior = cum - inYear;
      if (prior !== 0) {
        priorByActivity[column] = (priorByActivity[column] ?? 0) + prior;
        priorTotal += prior;
      }
    }
    const cents = isPL ? inYear : cum;
    if (cents !== 0) {
      tbRows.push({
        code: r.code,
        name: r.name,
        classification: r.classification,
        accountType: r.accountType,
        activity: column,
        byActivity: { [column]: cents },
        totalCents: cents,
      });
    }
  }

  tbRows.sort(
    (a, b) =>
      (CLS_ORDER[a.classification] ?? 9) - (CLS_ORDER[b.classification] ?? 9) ||
      a.name.localeCompare(b.name)
  );

  // Columns come from CURRENT rows only. "Profit for all prior years" is an
  // entity-level equity roll (the CPA's own workpaper shows it as ONE number),
  // so it deliberately does NOT keep a dormant activity's column alive — a
  // wound-down activity disappears from future TBs once its accounts are quiet.
  const activitySet = new Set<string>(tbRows.map((r) => r.activity));
  const activities = activitySet.size > 1 ? [...activitySet].sort() : [];

  const netIncome: Record<string, number> = {};
  const checkTotal: Record<string, number> = {};
  let netIncomeTotal = 0;
  for (const r of tbRows) {
    const a = r.activity;
    checkTotal[a] = (checkTotal[a] ?? 0) + r.totalCents;
    if (PL.has(r.classification)) {
      netIncome[a] = (netIncome[a] ?? 0) + r.totalCents;
      netIncomeTotal += r.totalCents;
    }
  }
  const checkTotalTotal = tbRows.reduce((s, r) => s + r.totalCents, 0) + priorTotal;

  return {
    entityId,
    year,
    asOf,
    activities,
    foreignColumns: [...foreignSet].filter((f) => activities.includes(f)).sort(),
    rows: tbRows,
    // Rendered in the Total column only — see the columns note above.
    priorYearsProfit: {},
    priorYearsProfitTotal: priorTotal,
    netIncome,
    netIncomeTotal,
    checkTotal,
    checkTotalTotal,
  };
}

/** Years that have any journal activity — drives the UI year picker. */
export async function entityYears(entityId: string): Promise<number[]> {
  const rows = await db
    .selectDistinct({
      y: sql<number>`EXTRACT(YEAR FROM ${bkJournalEntries.txnDate})::int`,
    })
    .from(bkJournalEntries)
    .where(eq(bkJournalEntries.entityId, entityId));
  return rows
    .map((r) => Number(r.y))
    .filter((y) => Number.isFinite(y))
    .sort((a, b) => b - a);
}
