import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { accountBalances } from "@/lib/ledger/reports";
import { RECONCILABLE_TYPES, toNaturalSign } from "@/lib/ledger/reconcile";
import { livePlaidBalanceCents, livePlaidPendingCents } from "@/lib/plaid/balances";

const {
  bkAccounts,
  bkPlaidAccounts,
  bkPlaidTransactions,
  bkLoans,
  bkAccountRecon,
  bkAccountReconState,
  bkReconciliations,
} = schema;

/**
 * Balance health per account — the one-glance "is the book balance right?"
 * behind the Reconciliation tab. NOT the statement-tie workflow (that lives in
 * lib/ledger/reconcile.ts, per account); this only compares a book balance to
 * an externally verifiable one and reports the variance.
 *
 * Two sources of "actual":
 *   - PLAID — accounts mapped to a live bank feed. Compared CURRENT book vs the
 *     bank's CURRENT reported balance, fetched at render (fail-soft).
 *   - MANUAL — non-mortgage loans + unlinked bank/CC accounts. Compared book
 *     AS OF the user's last checkpoint date vs the balance they entered
 *     (bk_account_recon, latest as_of_date row wins).
 *
 * Mortgages are excluded on purpose: escrow expensing + servicer timing make
 * their book balance legitimately drift from the servicer's figure, and the
 * 1098 true-up is an annual owner ritual, not a variance to nag about. All
 * balances are NATURAL sign (a loan/credit-card balance owed is positive).
 */

// Row shape + tolerance live in recon-status-shared.ts (client-safe — the row
// component must not pull this db-touching module into the browser bundle).
export type { ReconStatusRow } from "@/lib/ledger/recon-status-shared";
import {
  IN_SYNC_TOLERANCE_CENTS,
  SETTLING_GRACE_DAYS,
  type ReconStatusRow,
} from "@/lib/ledger/recon-status-shared";

/**
 * A loan is a MORTGAGE when its name says so or it escrows — either marks the
 * escrow-expensing servicer pattern this view deliberately stays out of.
 */
function isMortgage(loan: { name: string; monthlyEscrowCents: number }): boolean {
  return /mortgage/i.test(loan.name) || loan.monthlyEscrowCents > 0;
}

export async function reconStatus(entityId: string): Promise<ReconStatusRow[]> {
  // Independent reads — the Plaid round-trips dominate, so everything else
  // rides alongside them.
  const [
    accounts,
    plaidLinks,
    loans,
    currentBals,
    liveBals,
    livePending,
    checkpoints,
    statements,
    stagedSums,
  ] = await Promise.all([
      db
        .select({
          id: bkAccounts.id,
          qboAccountId: bkAccounts.qboAccountId,
          name: bkAccounts.name,
          accountType: bkAccounts.accountType,
          normalBalance: bkAccounts.normalBalance,
          active: bkAccounts.active,
        })
        .from(bkAccounts)
        .where(eq(bkAccounts.entityId, entityId)),
      db
        .select({
          plaidAccountId: bkPlaidAccounts.plaidAccountId,
          mappedAccountId: bkPlaidAccounts.mappedAccountId,
        })
        .from(bkPlaidAccounts)
        .where(
          and(
            eq(bkPlaidAccounts.entityId, entityId),
            isNotNull(bkPlaidAccounts.mappedAccountId)
          )
        ),
      db
        .select({
          name: bkLoans.name,
          liabilityAccountQboId: bkLoans.liabilityAccountQboId,
          monthlyEscrowCents: bkLoans.monthlyEscrowCents,
        })
        .from(bkLoans)
        .where(eq(bkLoans.entityId, entityId)),
      accountBalances(entityId),
      livePlaidBalanceCents(entityId),
      livePlaidPendingCents(entityId),
      // Newest-first so "first row per account" below is the latest checkpoint.
      db
        .select()
        .from(bkAccountRecon)
        .where(eq(bkAccountRecon.entityId, entityId))
        .orderBy(desc(bkAccountRecon.asOfDate), desc(bkAccountRecon.createdAt)),
      db
        .select({
          accountId: bkReconciliations.accountId,
          statementDate: bkReconciliations.statementDate,
        })
        .from(bkReconciliations)
        .where(
          and(
            eq(bkReconciliations.entityId, entityId),
            eq(bkReconciliations.status, "completed")
          )
        )
        .orderBy(desc(bkReconciliations.statementDate)),
      // Staged-but-unposted bank-feed rows, per Plaid account. These are the
      // SETTLED in-flight items (awaiting the daily sweep or review) a live
      // bank balance can be ahead of the book by — the auto-reconcile math nets
      // them out below. Bank-PENDING items never reach staging (sync filters
      // them), so those come live from livePlaidPendingCents instead; the
      // pending=false guard keeps any legacy pending row from double-counting.
      db
        .select({
          plaidAccountId: bkPlaidTransactions.plaidAccountId,
          sumCents: sql<number>`COALESCE(SUM(${bkPlaidTransactions.amountCents}), 0)::bigint`,
          n: sql<number>`COUNT(*)::int`,
        })
        .from(bkPlaidTransactions)
        .where(
          and(
            eq(bkPlaidTransactions.entityId, entityId),
            eq(bkPlaidTransactions.status, "pending_review"),
            eq(bkPlaidTransactions.pending, false)
          )
        )
        .groupBy(bkPlaidTransactions.plaidAccountId),
    ]);

  // Prior sync observations (settling clocks) for this entity's accounts.
  const stateRows = await db
    .select()
    .from(bkAccountReconState)
    .where(eq(bkAccountReconState.entityId, entityId));
  const stateByAccount = new Map(stateRows.map((s) => [s.accountId, s]));

  const acctById = new Map(accounts.map((a) => [a.id, a]));
  const acctByQbo = new Map(accounts.map((a) => [a.qboAccountId, a]));
  const currentNet = new Map(currentBals.map((b) => [b.qboAccountId, b.netCents]));
  const latestCheckpoint = new Map<string, (typeof checkpoints)[number]>();
  for (const c of checkpoints) {
    if (!latestCheckpoint.has(c.accountQboId)) latestCheckpoint.set(c.accountQboId, c);
  }
  const lastStatement = new Map<string, string>();
  for (const s of statements) {
    if (!lastStatement.has(s.accountId)) lastStatement.set(s.accountId, s.statementDate);
  }

  // Settled-but-unposted staged sums per Plaid account.
  const staged = new Map(
    stagedSums.map((s) => [
      s.plaidAccountId,
      { settledCents: Number(s.sumCents), settledN: Number(s.n) },
    ])
  );

  // ── PLAID rows: current book vs the bank's live figure, netting out known
  // in-flight items. The bank's balance runs 1–2 days ahead of the book: bank-
  // pending txns we deliberately never stage or post (fetched live above —
  // credit cards especially report them inside the current balance), plus
  // settled ones awaiting the daily sweep or review. A variance FULLY explained
  // by those items is reconciled, not "off". Institutions differ on whether the
  // reported current balance includes their own pending txns, so we try the
  // explanation with and without the bank-pending bucket and keep whichever
  // leaves the smallest unexplained residual (ties → fewer items).
  const plaidRows: ReconStatusRow[] = [];
  const plaidMappedIds = new Set<string>();
  for (const link of plaidLinks) {
    const acct = link.mappedAccountId ? acctById.get(link.mappedAccountId) : null;
    if (!acct) continue; // mapping points outside this entity's CoA — skip
    plaidMappedIds.add(acct.id);
    const book = toNaturalSign(currentNet.get(acct.qboAccountId) ?? 0, acct.normalBalance);
    const actual = liveBals.get(link.plaidAccountId) ?? null;
    const variance = actual === null ? null : actual - book;

    // An in-flight txn's effect on the NATURAL book once posted. Plaid sign:
    // positive = outflow from a depository (book ↓) = new charge on a card
    // (owed ↑) — so debit-normal flips the sign, credit-normal keeps it.
    const s = staged.get(link.plaidAccountId);
    const p = livePending.get(link.plaidAccountId);
    const sign = acct.normalBalance === "debit" ? -1 : 1;
    const settledDelta = sign * (s?.settledCents ?? 0);
    const pendingDelta = sign * (p?.sumCents ?? 0);
    let residual = variance;
    let inflightCount = 0;
    if (variance !== null && (s || p)) {
      const candidates: { residual: number; count: number }[] = [
        { residual: variance, count: 0 },
        { residual: variance - settledDelta, count: s?.settledN ?? 0 },
        {
          residual: variance - settledDelta - pendingDelta,
          count: (s?.settledN ?? 0) + (p?.n ?? 0),
        },
      ];
      const best = candidates.reduce((a, b) =>
        Math.abs(b.residual) < Math.abs(a.residual) ? b : a
      );
      residual = best.residual;
      inflightCount = best.count;
    }

    // ── Settling clock. Every observation with a live balance stamps
    // bk_account_recon_state: in tolerance → reset the streak; out → start (or
    // keep) it. A young streak is "settling" — the bank's real-time balance
    // outrunning Plaid's periodically-extracted transactions — and stays green;
    // only a streak older than the grace window is a genuine discrepancy.
    let settling = false;
    let offSinceDays: number | null = null;
    if (variance !== null && residual !== null) {
      const now = new Date();
      const inSync = Math.abs(residual) < IN_SYNC_TOLERANCE_CENTS;
      const prior = stateByAccount.get(acct.id);
      const offSince = inSync ? null : (prior?.offSince ?? now);
      if (!inSync) {
        offSinceDays = Math.floor(
          (now.getTime() - offSince!.getTime()) / 86_400_000
        );
        settling = offSinceDays < SETTLING_GRACE_DAYS;
      }
      await db
        .insert(bkAccountReconState)
        .values({
          entityId,
          accountId: acct.id,
          offSince,
          lastInSyncAt: inSync ? now : (prior?.lastInSyncAt ?? null),
          lastResidualCents: residual,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: bkAccountReconState.accountId,
          set: {
            offSince,
            lastInSyncAt: inSync ? now : sql`${bkAccountReconState.lastInSyncAt}`,
            lastResidualCents: residual,
            updatedAt: now,
          },
        });
    }

    plaidRows.push({
      qboAccountId: acct.qboAccountId,
      name: acct.name,
      accountType: acct.accountType,
      source: "plaid",
      bookCents: book,
      actualCents: actual,
      varianceCents: variance,
      residualCents: residual,
      inflightCount,
      settling,
      offSinceDays,
      asOfDate: null,
      lastStatementDate: lastStatement.get(acct.id) ?? null,
      hasFullReconcile: (RECONCILABLE_TYPES as readonly string[]).includes(
        acct.accountType
      ),
    });
  }

  // ── MANUAL candidates: unlinked bank/CC accounts + non-mortgage loans. ───
  const manual: (typeof accounts)[number][] = accounts.filter(
    (a) =>
      (RECONCILABLE_TYPES as readonly string[]).includes(a.accountType) &&
      a.active && // closed accounts have nothing external left to verify
      !plaidMappedIds.has(a.id)
  );
  const seen = new Set(manual.map((a) => a.qboAccountId));
  for (const loan of loans) {
    if (isMortgage(loan) || !loan.liabilityAccountQboId) continue;
    if (seen.has(loan.liabilityAccountQboId)) continue; // one row per GL account
    const acct = acctByQbo.get(loan.liabilityAccountQboId);
    if (!acct || plaidMappedIds.has(acct.id)) continue;
    seen.add(acct.qboAccountId);
    manual.push(acct);
  }

  // A manual row compares book AS OF its checkpoint date — one balance pass per
  // distinct date (few in practice; checkpoints cluster on month-ends).
  const asOfDates = [
    ...new Set(
      manual
        .map((a) => latestCheckpoint.get(a.qboAccountId)?.asOfDate)
        .filter((d): d is string => !!d)
    ),
  ];
  const netAsOf = new Map<string, Map<string, number>>();
  await Promise.all(
    asOfDates.map(async (end) => {
      const bals = await accountBalances(entityId, { end });
      netAsOf.set(end, new Map(bals.map((b) => [b.qboAccountId, b.netCents])));
    })
  );

  const manualRows: ReconStatusRow[] = manual.map((acct) => {
    const cp = latestCheckpoint.get(acct.qboAccountId) ?? null;
    const net = cp
      ? (netAsOf.get(cp.asOfDate)?.get(acct.qboAccountId) ?? 0)
      : (currentNet.get(acct.qboAccountId) ?? 0);
    const book = toNaturalSign(net, acct.normalBalance);
    const actual = cp ? cp.actualBalanceCents : null;
    const variance = actual === null ? null : actual - book;
    return {
      qboAccountId: acct.qboAccountId,
      name: acct.name,
      accountType: acct.accountType,
      source: "manual",
      bookCents: book,
      actualCents: actual,
      varianceCents: variance,
      // Manual checkpoints compare as-of a date the user chose — no live feed,
      // no in-flight items to net out, no settling clock.
      residualCents: variance,
      inflightCount: 0,
      settling: false,
      offSinceDays: null,
      asOfDate: cp?.asOfDate ?? null,
      lastStatementDate: lastStatement.get(acct.id) ?? null,
      hasFullReconcile: (RECONCILABLE_TYPES as readonly string[]).includes(
        acct.accountType
      ),
    };
  });

  // Auto rows first (they're the always-fresh ones), then manual; name order
  // within each group so the list reads stably across renders.
  const byName = (a: ReconStatusRow, b: ReconStatusRow) =>
    a.name.localeCompare(b.name);
  return [...plaidRows.sort(byName), ...manualRows.sort(byName)];
}

/**
 * Stamp a sync observation for every entity with a mapped Plaid account — the
 * cron's contribution to the settling clocks. Page visits observe too, but the
 * daily sweeps guarantee the clocks tick even through an unvisited week, so
 * "off for N days" means N real days, not N page loads. Serial on purpose
 * (each pass makes live Plaid calls); per-entity failures are isolated.
 */
export async function observeReconPortfolio(): Promise<{
  entities: number;
  failed: number;
}> {
  const rows = await db
    .selectDistinct({ entityId: bkPlaidAccounts.entityId })
    .from(bkPlaidAccounts)
    .where(
      and(
        isNotNull(bkPlaidAccounts.entityId),
        isNotNull(bkPlaidAccounts.mappedAccountId)
      )
    );
  let entities = 0;
  let failed = 0;
  for (const r of rows) {
    try {
      await reconStatus(r.entityId!);
      entities++;
    } catch (e) {
      failed++;
      console.error(
        `[recon] observation failed for entity ${r.entityId}: ${e instanceof Error ? e.message : e}`
      );
    }
  }
  return { entities, failed };
}
