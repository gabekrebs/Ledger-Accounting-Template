import Link from "next/link";
import { notFound } from "next/navigation";
import {
  accountBalances,
  annualOperating,
  plSummary,
  balanceSheet,
  capitalStructure,
  capitalByOwner,
  equityCashFlowSeries,
  getEntity,
  isDistributionEquity,
  ledgerStats,
} from "@/lib/ledger/reports";
import { getEntityActivities } from "@/lib/ledger/manage-accounts";
import { listLoans, computePaydownFromGL } from "@/lib/ledger/loans";
import {
  getValuationComponents,
  sumComponents,
  componentChosenCents,
} from "@/lib/ledger/valuation";
import { summarize, amortize, summarizeFromNow } from "@/lib/ledger/amortization";
import { netAssetValue, type NetAssetValue } from "@/lib/ledger/net-asset";
import { InvestmentReturns } from "./investment-returns";
import { PerformanceByYear } from "./performance-by-year";
import { ReturnsAssumptionsProvider } from "./returns-assumptions";
import { Section, Rule } from "./section";
import { Money } from "@/components/money";
import { usd, usdCompact } from "@/lib/ledger/format";

export const dynamic = "force-dynamic";

export default async function Overview({
  params,
}: {
  params: Promise<{ entityId: string }>;
}) {
  const { entityId } = await params;
  const entity = await getEntity(entityId);
  if (!entity) notFound();

  const stats = await ledgerStats(entityId);
  const asOf = stats.lastDate ?? "2026-12-31";
  const firstYear = stats.firstDate ? +stats.firstDate.slice(0, 4) : 2022;
  const lastYear = stats.lastDate ? +stats.lastDate.slice(0, 4) : 2026;
  const years: number[] = [];
  for (let y = lastYear; y >= firstYear; y--) years.push(y);

  const [annual, bs, cap, capOwners, loans, lifeBals, equityFlows, paydown] =
    await Promise.all([
      annualOperating(entityId, years, { activity: "Real Estate" }),
      balanceSheet(entityId, asOf),
      capitalStructure(entityId, asOf),
      capitalByOwner(entityId, asOf),
      listLoans(entityId),
      accountBalances(entityId, { end: asOf }),
      equityCashFlowSeries(entityId, asOf),
      // GL-based paydown: initial debt (at first txn date) − current debt.
      // Works without any loan config; handles refi and forbearance correctly.
      stats.firstDate
        ? computePaydownFromGL(entityId)
        : Promise.resolve(null),
    ]);
  const sum = (f: (r: (typeof annual)[number]) => number) =>
    annual.reduce((s, a) => s + f(a), 0);

  // Long-term liabilities = the debt (mortgages/notes). Zero-balance accounts
  // (paid-off or never-drawn intercompany notes) are hidden — they'd otherwise
  // show as empty "+ add loan terms" rows that clutter the panel.
  const debtAccounts = lifeBals
    .filter((b) => b.accountType === "Long Term Liability" && b.netCents !== 0)
    .map((b) => ({ qboAccountId: b.qboAccountId, name: b.name, balanceCents: -b.netCents }));
  const lifetimeInterestCents = lifeBals
    .filter((b) => b.accountSubtype === "InterestPaid")
    .reduce((s, b) => s + b.netCents, 0);
  const loanByAccount = new Map(
    loans.filter((l) => l.liabilityAccountQboId).map((l) => [l.liabilityAccountQboId!, l])
  );

  // Flatten the equity tree to per-owner rows (the partner accounts are nested
  // under a "Partner's Equity" parent, which would otherwise roll them up).
  const ownerRows: { name: string; cents: number; qboAccountId: string }[] = [];
  const walkEquity = (nodes: typeof bs.equity) => {
    for (const n of nodes) {
      if (n.ownCents !== 0)
        ownerRows.push({ name: n.name, cents: n.ownCents, qboAccountId: n.qboAccountId });
      walkEquity(n.children);
    }
  };
  walkEquity(bs.equity);

  // Split contributions (capital IN) from distributions/draws (capital OUT) so
  // they show on separate lines — distributions are a return OF capital, never
  // netted into the basis. Matches capitalStructure()'s isDistributionEquity.
  const subtypeByAccount = new Map(lifeBals.map((b) => [b.qboAccountId, b.accountSubtype]));
  const isDistributionRow = (r: { name: string; qboAccountId: string }) =>
    isDistributionEquity({ name: r.name, accountSubtype: subtypeByAccount.get(r.qboAccountId) ?? null });
  const contributionRows = ownerRows.filter((r) => !isDistributionRow(r));

  // Partners for the per-partner returns view. Uses the ownership percentages
  // from the entity’s `owners` field when available; falls back to contributed
  // capital ratios for entities that haven’t set owners yet.
  const SYSTEM_EQUITY_SUBTYPES = new Set([
    "RetainedEarnings",
    "AccumulatedAdjustment",
    "OpeningBalanceEquity",
  ]);
  const equityPartners = contributionRows
    .filter((r) => r.cents > 0)
    .filter(
      (r) =>
        !SYSTEM_EQUITY_SUBTYPES.has(subtypeByAccount.get(r.qboAccountId) ?? "") &&
        !/retained earnings|opening balance/i.test(r.name)
    )
    .map((r) => {
      const cleanName = r.name.replace(/^Partner[‘’]?s Equity\s*[-–—]\s*/i, "").trim();
      // Match to entity owners by name to get the real ownership %
      const ownerMatch = entity.owners?.find((o) => {
        const ownerFirst = o.name.toLowerCase().split(/\s+/)[0];
        const acctFirst = cleanName.toLowerCase().split(/\s*[-–—\s]/)[0];
        return ownerFirst === acctFirst;
      });
      return {
        name: cleanName,
        contributedCents: r.cents,
        ownershipPct: ownerMatch?.pct ?? null,
      };
    })
    .sort((a, b) => b.contributedCents - a.contributedCents);
  const partners = equityPartners.map((p) => ({
    name: p.name,
    contributedCents: p.contributedCents,
    ownershipPct: p.ownershipPct,
  }));

  // ---- Investment-returns inputs (computed once, server-side) ----
  const currentYear = new Date().getFullYear();
  const stabilized =
    annual.find((a) => a.year < currentYear) ?? annual[0] ?? null;

  // Activity-based P&L summary (only fetched when entity has multiple activities)
  const activities = await getEntityActivities(entityId);
  const hasMultipleActivities = activities.length > 1;
  const activitySummaries = hasMultipleActivities
    ? await Promise.all(
        activities.map(async (activity) => {
          const data = await plSummary(entityId, {
            start: `${currentYear}-01-01`,
            end: asOf,
            activity,
          });
          return { activity, ...data };
        })
      )
    : [];
  const cashFlowCents =
    sum((a) => a.noiCents) - sum((a) => a.mortgageInterestCents);
  // Cumulative principal paid down — computed directly from the GL:
  // initial LT-liability balance (at first transaction date) minus current
  // balance. No loan config needed; handles refi and forbearance correctly.
  const principalPaidCents = paydown?.paydownCents ?? 0;
  const paydownByAccount = new Map(
    (paydown?.accounts ?? []).map((a) => [a.qboAccountId, a])
  );
  const hasDebt = debtAccounts.length > 0;
  // Liquid assets the entity is sitting on (bank balances + escrow + prepayments
  // held by servicers) as of the sync date. These belong in the IRR/equity
  // terminal: refi proceeds or operating cash that hasn't been distributed yet
  // is still owner value — "value − debt" alone would ignore it.
  // Prepayments (unapplied mortgage payments) are included here because they
  // offset the matching "Deferred Mortgage Balance" liability 1-for-1; excluding
  // them while counting the liability understates equity by the same amount.
  const liquidAssetsCents = lifeBals
    .filter(
      (b) =>
        b.accountType === "Bank" ||
        (b.classification === "asset" &&
          (/escrow/i.test(b.name) || /prepay/i.test(b.name)))
    )
    .reduce((s, b) => s + b.netCents, 0);
  const holdingYears =
    stats.firstDate && stats.lastDate
      ? (new Date(stats.lastDate).getTime() -
          new Date(stats.firstDate).getTime()) /
        (365.25 * 24 * 3600 * 1000)
      : 0;
  // Cost basis for appreciation = ALL fixed assets at cost (land + building +
  // capitalized improvements + furniture/FF&E), gross of depreciation —
  // straight from the fixed-asset accounts (per entity, no hardcoded numbers),
  // so appreciation nets out every dollar put into the property.
  const costBasisCents = lifeBals
    .filter(
      (b) =>
        b.accountType === "Fixed Asset" &&
        b.accountSubtype !== "AccumulatedDepreciation"
    )
    .reduce((s, b) => s + b.netCents, 0);

  // Per-year scheduled mortgage principal from the primary loan's amortization
  // schedule. Prefer the "remaining term" path (current balance + remaining
  // months) which stays accurate after a refi; fall back to the legacy full-
  // terms path for loans configured before this feature.
  const primaryLoan =
    loans.find((l) => !l.interestOnly && (l.remainingTermMonths || l.termMonths)) ?? null;
  const principalByYear = new Map<number, number>();
  if (primaryLoan) {
    const primaryAccountBal =
      primaryLoan.liabilityAccountQboId
        ? (debtAccounts.find((d) => d.qboAccountId === primaryLoan.liabilityAccountQboId)?.balanceCents ?? 0)
        : 0;
    const scheduleRows =
      primaryLoan.remainingTermMonths && primaryLoan.annualRateBps != null && primaryAccountBal > 0
        ? (await import("@/lib/ledger/amortization")).amortizeFromNow({
            currentBalanceCents: primaryAccountBal,
            annualRateBps: primaryLoan.annualRateBps,
            remainingTermMonths: primaryLoan.remainingTermMonths,
            monthlyPaymentCents: primaryLoan.monthlyPaymentCents,
            monthlyEscrowCents: primaryLoan.monthlyEscrowCents,
            asOfDate: asOf,
          })
        : primaryLoan.originalPrincipalCents != null &&
          primaryLoan.annualRateBps != null &&
          primaryLoan.termMonths != null &&
          primaryLoan.firstPaymentDate
          ? amortize({
              originalPrincipalCents: primaryLoan.originalPrincipalCents,
              annualRateBps: primaryLoan.annualRateBps,
              termMonths: primaryLoan.termMonths,
              firstPaymentDate: primaryLoan.firstPaymentDate,
              monthlyPaymentCents: primaryLoan.monthlyPaymentCents,
              monthlyEscrowCents: primaryLoan.monthlyEscrowCents,
            })
          : [];
    for (const r of scheduleRows) {
      if (r.date > asOf) break;
      const yr = +r.date.slice(0, 4);
      principalByYear.set(yr, (principalByYear.get(yr) ?? 0) + r.principalCents);
    }
  }
  const annualRows = annual.map((a) => ({
    ...a,
    principalCents: principalByYear.get(a.year) ?? 0,
  }));

  // Cumulative depreciation (+ amortization) to date drives the depreciation tax
  // benefit (and so the net invested basis), derived inside the returns
  // components live against the shared tax-rate / losses-usable assumptions.
  // Depreciation shelters the property's own income first (always tax-deferred),
  // then any excess spills into a passive loss — see depreciationTaxBenefit().
  const depreciationToDateCents = sum((a) => a.depreciationCents);

  // Valuation methodology drives whether (and how) the returns hero renders:
  //   income       — cap-rate on NOI; needs a stabilized year + debt to be meaningful.
  //   market       — Σ of each structure's chosen estimate (Zillow/Redfin/AI/manual).
  //   equity_stake — parent entity's value × ownership %.
  //   none         — entity holds no real estate (a holding company); no hero.
  const method = entity.valuationMethod;

  // Market: load this entity's structures + their multi-source estimates.
  const components = method === "market" ? await getValuationComponents(entityId) : [];
  const marketBreakdown = components.map((c) => ({
    label: c.label,
    chosenCents: componentChosenCents(c),
    estimates: c.estimates.map((e) => ({ source: e.source, valueCents: e.valueCents })),
  }));
  // Σ components, falling back to the legacy single value if not yet migrated.
  let marketValueCents =
    method === "market" ? sumComponents(components) || (entity.marketValueCents ?? 0) : 0;
  let valueSource = entity.marketValueSource;
  let valueAsOf = entity.marketValueAsOf;

  // Equity stake: value = ownership % × the parent entity's NET EQUITY (its asset
  // value minus its own debt). A member owns a share of the parent's equity, not
  // of its unlevered assets — so the parent's mortgage must be netted out before
  // the % is applied. The holding entity carries no debt of its own, so this is
  // the only place the parent's loan can come out. Parent figures resolve as of
  // the PARENT's own last-synced date (not this entity's).
  if (method === "equity_stake" && entity.parentEntityId && entity.ownershipPct) {
    const pct = parseFloat(entity.ownershipPct) / 100;
    const [parent, parentComps, parentStats] = await Promise.all([
      getEntity(entity.parentEntityId),
      getValuationComponents(entity.parentEntityId),
      ledgerStats(entity.parentEntityId),
    ]);
    const parentAsOf = parentStats.lastDate ?? asOf;
    let parentValueCents = sumComponents(parentComps) || (parent?.marketValueCents ?? 0);
    // Income-valued parent (e.g. Nine Creeks): cap its stabilized NOI at 5.5%.
    if (!parentValueCents && parent) {
      const pFirst = parentStats.firstDate ? +parentStats.firstDate.slice(0, 4) : currentYear;
      const pLast = parentStats.lastDate ? +parentStats.lastDate.slice(0, 4) : currentYear;
      const pYears: number[] = [];
      for (let y = pLast; y >= pFirst; y--) pYears.push(y);
      const pAnnual = await annualOperating(entity.parentEntityId, pYears);
      const pStab = pAnnual.find((a) => a.year < currentYear) ?? pAnnual[0] ?? null;
      if (pStab) parentValueCents = Math.round(pStab.noiCents / 0.055);
    }
    // Net the parent's own liabilities (mortgage, deposits) out of its asset value
    // to get parent EQUITY, then take this entity's share.
    const parentCap = await capitalStructure(entity.parentEntityId, parentAsOf);
    const parentEquityCents = parentValueCents - parentCap.totalLiabilitiesCents;
    marketValueCents = Math.round(parentEquityCents * pct);
    valueSource = `${entity.ownershipPct}% of ${parent?.name ?? "parent"} equity (${usdCompact(parentValueCents)} value − ${usdCompact(parentCap.totalLiabilitiesCents)} debt)`;
    valueAsOf = parentAsOf;
  }

  // Capital structure is anchored to what the property is WORTH TODAY, not the
  // historical invested basis. Owner equity is the residual — current value −
  // debt — and the debt/equity split is the LTV against that value. Value source
  // by method: market / equity_stake = the valuation resolved above; income =
  // stabilized NOI capitalized at the 5.5% default cap rate; otherwise fall back
  // to the current book value of assets. (Universal — no per-entity hardcoding.)
  const currentValueCents =
    marketValueCents > 0
      ? marketValueCents
      : method === "income" && stabilized
        ? Math.round(stabilized.noiCents / 0.055)
        : cap.totalAssetsCents;
  const currentEquityCents = currentValueCents - cap.totalLiabilitiesCents;
  // Bar widths clamp to [0,100] (an underwater entity would otherwise overflow);
  // the figures above the bar always show the true signed equity.
  const debtPct = Math.min(
    100,
    Math.round((cap.totalLiabilitiesCents / Math.max(currentValueCents, 1)) * 100)
  );
  const equityPct = 100 - debtPct;
  // One-line provenance for the current value (Jobs lens: show where it came from).
  const valueNote =
    marketValueCents > 0
      ? [valueSource, valueAsOf ? `as of ${valueAsOf}` : null]
          .filter(Boolean)
          .join(" · ") || "market valuation"
      : method === "income" && stabilized
        ? `income · 5.5% cap on ${stabilized.year} NOI`
        : "current book value of assets";

  // Net-asset-value entities (holding/operating cos) value as the sum
  // of what they hold — cash, loans receivable, investments, stated-value
  // property — net of real debt, instead of a cap rate on book assets.
  const nav: NetAssetValue | null =
    method === "net_asset" ? await netAssetValue(entityId, asOf) : null;

  const showHero =
    method === "income"
      ? Boolean(stabilized && hasDebt)
      : method === "market"
        ? marketValueCents > 0
        : method === "equity_stake"
          ? marketValueCents > 0
          : false;

  return (
    <ReturnsAssumptionsProvider>
      <div className="space-y-10">
        {/* identity strip */}
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-sm text-muted-foreground">
        {entity.taxType && (
          <span className="rounded-full bg-evergreen-soft px-2 py-0.5 text-[11px] font-medium uppercase tracking-[0.06em] text-evergreen">
            {entity.taxType}
          </span>
        )}
        <span>{entity.legalName}</span>
        <span className="text-hair">·</span>
        <span>Synced through {stats.lastDate ?? "—"}</span>
      </div>

      {/* HERO — investment returns (income or market valuation) */}
      {showHero && (
        <InvestmentReturns
          valuationMethod={method === "income" ? "income" : "market"}
          stabilizedNoiCents={stabilized?.noiCents ?? 0}
          stabilizedYear={stabilized?.year ?? lastYear}
          marketValueCents={marketValueCents}
          marketValueSource={valueSource}
          marketValueAsOf={valueAsOf}
          valuationUrl={entity.valuationUrl}
          marketBreakdown={marketBreakdown}
          costBasisCents={costBasisCents}
          contributedEquityCents={cap.contributedCapitalCents}
          totalDebtCents={cap.totalLiabilitiesCents}
          liquidAssetsCents={liquidAssetsCents}
          cashFlowCents={cashFlowCents}
          principalPaidCents={principalPaidCents}
          depreciationToDateCents={depreciationToDateCents}
          netIncomeToDateCents={cap.netIncomeToDateCents}
          holdingYears={holdingYears}
          partners={partners}
          asOf={asOf}
          cashFlowSeries={equityFlows.flows}
          cashContributedCents={equityFlows.totalContributedCents}
          cashDistributedCents={equityFlows.totalDistributedCents}
        />
      )}

      {method !== "none" && <>
      <Rule />

      {/* Performance by year */}
      <Section
        title="Real estate performance by year"
        description="Net Operating Income, its unlevered yield on cost, and the cash it throws off after debt service."
      >
        <PerformanceByYear
          entityId={entityId}
          rows={annualRows}
          totals={{
            revenueCents: sum((a) => a.revenueCents),
            operatingExpenseCents: sum((a) => a.operatingExpenseCents),
            noiCents: sum((a) => a.noiCents),
            otherIncomeCents: sum((a) => a.otherIncomeCents),
            mortgageInterestCents: sum((a) => a.mortgageInterestCents),
            principalCents: annualRows.reduce((s, a) => s + a.principalCents, 0),
            depreciationCents: sum((a) => a.depreciationCents),
            belowLineOtherCents: sum((a) => a.belowLineOtherCents),
            netIncomeCents: sum((a) => a.netIncomeCents),
          }}
          costBasisCents={costBasisCents}
          contributedCapitalCents={cap.contributedCapitalCents}
          depreciationToDateCents={depreciationToDateCents}
          netIncomeToDateCents={cap.netIncomeToDateCents}
        />
      </Section>
      </>}

      {hasMultipleActivities && activitySummaries.some((s) => s.revenueCents || s.operatingExpenseCents) && (
        <>
          <Rule />
          <Section
            title="P&L by activity"
            description={`YTD ${currentYear} — revenue, expenses, and NOI broken out by business activity.`}
          >
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-hair text-[11px] font-medium uppercase tracking-[0.06em] text-faint">
                    <th className="py-2 text-left">Activity</th>
                    <th className="py-2 text-right">Revenue</th>
                    <th className="py-2 text-right">Expenses</th>
                    <th className="py-2 text-right">Net Profit</th>
                  </tr>
                </thead>
                <tbody>
                  {activitySummaries.filter((s) => s.revenueCents || s.operatingExpenseCents).map((s) => (
                    <tr key={s.activity} className="border-b border-hair/60">
                      <td className="py-2.5">
                        <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] ${
                          s.activity === "Real Estate"
                            ? "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800/40 dark:bg-emerald-900/20 dark:text-emerald-300"
                            : "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-800/40 dark:bg-amber-900/20 dark:text-amber-300"
                        }`}>
                          {s.activity}
                        </span>
                      </td>
                      <td className="py-2.5 text-right"><Money cents={s.revenueCents} /></td>
                      <td className="py-2.5 text-right"><Money cents={s.totalExpenseCents} /></td>
                      <td className="py-2.5 text-right font-medium"><Money cents={s.netProfitCents} tone="auto" /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>
        </>
      )}

      {method !== "none" && <>
      <Rule />

      {/* Capital structure — net asset value for holding/operating entities,
          otherwise the property's value / debt / equity split. */}
      {nav ? (
        <NetAssetSection nav={nav} />
      ) : (
      <Section
        title="Capital structure"
        description="What the property is worth today, the debt against it, and your equity — the residual (current value − debt)."
      >
        <div className="grid gap-6 sm:grid-cols-3">
          <Figure label="Debt" value={usd(cap.totalLiabilitiesCents)} />
          <Figure label="Owner equity (current)" value={usd(currentEquityCents)} />
          <Figure label="Current value" value={usd(currentValueCents)} note={valueNote} strong />
        </div>
        <div>
          <div className="flex h-2.5 overflow-hidden rounded-full bg-[#EEEAE1]">
            <div className="bg-ink" style={{ width: `${debtPct}%` }} />
            <div className="bg-evergreen" style={{ width: `${equityPct}%` }} />
          </div>
          <div className="mt-1.5 flex justify-between text-xs text-muted-foreground">
            <span>Debt {debtPct}%</span>
            <span>Equity {equityPct}%</span>
          </div>
        </div>
        <div className="grid gap-x-10 gap-y-1.5 text-sm text-muted-foreground sm:grid-cols-2">
          <Kv label="Debt — long-term (mortgage & notes)" cents={cap.mortgageDebtCents} />
          <Kv label="Debt — other (cards, deposits, intercompany)" cents={cap.otherDebtCents} />
          <Kv label="Current value" cents={currentValueCents} />
          <Kv label="Owner equity (current value − debt)" cents={currentEquityCents} />
          <Kv label="Contributed capital (invested basis)" cents={cap.contributedCapitalCents} />
          {cap.distributionsCents !== 0 && (
            <Kv label="Distributions to owners (to date)" cents={-cap.distributionsCents} />
          )}
          <Kv label="Net income to date (depreciation & losses)" cents={cap.netIncomeToDateCents} />
          <Kv label="Book equity (after depreciation/losses)" cents={cap.bookEquityCents} />
        </div>
      </Section>
      )}

      </>}

      <Rule />

      <div className="grid gap-10 lg:grid-cols-2">
        {/* Capital by owner — actual contributed & distributed, one row each */}
        {method !== "none" && (
        <Section
          title="Capital by owner"
          description="Actual capital contributed and distributed, per owner."
        >
          <div className="text-sm">
            <div className="flex items-baseline justify-between pb-1 text-[0.7rem] font-medium uppercase tracking-wide text-faint">
              <span>Owner</span>
              <span className="flex gap-8">
                <span className="w-28 text-right">Contributed</span>
                <span className="w-28 text-right">Distributed</span>
              </span>
            </div>
            {capOwners.owners.map((o) => (
              <div key={o.name} className="flex items-baseline justify-between border-b border-hair/60 py-2">
                <span>{o.name}</span>
                <span className="flex gap-8">
                  <span className="w-28 text-right"><Money cents={o.contributedCents} tone="auto" /></span>
                  <span className="w-28 text-right text-muted-foreground">
                    {o.distributedCents ? <Money cents={-o.distributedCents} tone="auto" /> : "—"}
                  </span>
                </span>
              </div>
            ))}
            <div className="flex items-baseline justify-between border-t border-ink py-2 font-medium">
              <span>Total</span>
              <span className="flex gap-8">
                <span className="w-28 text-right"><Money cents={capOwners.totalContributedCents} tone="auto" /></span>
                <span className="w-28 text-right text-muted-foreground"><Money cents={-capOwners.totalDistributedCents} tone="auto" /></span>
              </span>
            </div>
            <div className="flex items-baseline justify-between py-2 text-muted-foreground">
              <span className="italic">Accumulated earnings/(loss) &amp; retained</span>
              <Money cents={capOwners.accumulatedEarningsCents} tone="auto" />
            </div>
            <div className="flex items-baseline justify-between border-t border-hair py-2 font-medium">
              <span>Total equity</span>
              <Money
                cents={capOwners.totalContributedCents - capOwners.totalDistributedCents + capOwners.accumulatedEarningsCents}
                tone="auto"
              />
            </div>
          </div>
        </Section>
        )}

        {/* Debt */}
        <Section
          title="Debt"
          description={`Lifetime interest paid ${usd(lifetimeInterestCents)}.`}
          action={
            <Link href={`/ledger/${entityId}/loans`} className="text-muted-foreground hover:text-evergreen">
              Manage →
            </Link>
          }
        >
          {debtAccounts.length === 0 && (
            <p className="text-sm text-muted-foreground">No long-term debt on the books.</p>
          )}
          <div className="space-y-5">
            {debtAccounts.map((d) => {
              const loan = loanByAccount.get(d.qboAccountId);
              const acctPaydown = paydownByAccount.get(d.qboAccountId);

              // Amortization summary: prefer "remaining term" path (current
              // balance + remaining months) which stays accurate after a refi;
              // fall back to legacy full-terms path for older loan records.
              const s = (() => {
                if (!loan || loan.interestOnly) return null;
                if (loan.remainingTermMonths && loan.annualRateBps != null) {
                  return summarizeFromNow({
                    currentBalanceCents: d.balanceCents,
                    annualRateBps: loan.annualRateBps,
                    remainingTermMonths: loan.remainingTermMonths,
                    monthlyPaymentCents: loan.monthlyPaymentCents,
                    monthlyEscrowCents: loan.monthlyEscrowCents,
                    asOfDate: asOf,
                  });
                }
                if (
                  loan.originalPrincipalCents != null &&
                  loan.annualRateBps != null &&
                  loan.termMonths != null &&
                  loan.firstPaymentDate
                ) {
                  return summarize({
                    originalPrincipalCents: loan.originalPrincipalCents,
                    annualRateBps: loan.annualRateBps,
                    termMonths: loan.termMonths,
                    firstPaymentDate: loan.firstPaymentDate,
                    monthlyPaymentCents: loan.monthlyPaymentCents,
                    monthlyEscrowCents: loan.monthlyEscrowCents,
                  });
                }
                return null;
              })();

              const ioMonthlyInterestCents =
                loan && loan.annualRateBps != null
                  ? Math.round((d.balanceCents * loan.annualRateBps) / 10000 / 12)
                  : 0;

              // Paydown progress bar: pct of initial debt retired
              const paydownPct =
                acctPaydown && acctPaydown.initialBalanceCents > 0
                  ? Math.min(100, Math.max(0, Math.round((acctPaydown.paydownCents / acctPaydown.initialBalanceCents) * 100)))
                  : null;

              return (
                <div key={d.qboAccountId} className="space-y-2">
                  <div className="flex items-baseline justify-between">
                    <span className="font-medium">{d.name}</span>
                    <Money cents={d.balanceCents} />
                  </div>

                  {/* Principal paydown (always shown when GL data exists) */}
                  {acctPaydown && acctPaydown.initialBalanceCents > 0 && (
                    <div className="space-y-1">
                      <div className="flex items-center justify-between text-xs text-muted-foreground">
                        <span>
                          Principal paid: <Money cents={Math.max(0, acctPaydown.paydownCents)} className="text-xs" />
                          {acctPaydown.paydownCents < 0 && (
                            <span className="ml-1 text-amber-600 dark:text-amber-400">(net debt added)</span>
                          )}
                        </span>
                        {paydownPct !== null && (
                          <span className="font-mono tabular-nums">{paydownPct}% retired</span>
                        )}
                      </div>
                      {paydownPct !== null && (
                        <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                          <div
                            className="h-full rounded-full bg-evergreen/60"
                            style={{ width: `${paydownPct}%` }}
                          />
                        </div>
                      )}
                    </div>
                  )}

                  {/* Loan terms / amortization */}
                  {loan && loan.interestOnly ? (
                    <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs text-muted-foreground">
                      <span>Type</span><span className="text-right">Interest-only</span>
                      {loan.annualRateBps != null && (
                        <><span>Rate</span><span className="text-right font-mono tabular-nums">{(loan.annualRateBps / 100).toFixed(3)}%</span></>
                      )}
                      {loan.annualRateBps != null && (
                        <><span>Monthly interest</span><span className="text-right"><Money cents={ioMonthlyInterestCents} className="text-xs" /></span></>
                      )}
                      {loan.monthlyEscrowCents > 0 && (<><span>Escrow</span><span className="text-right"><Money cents={loan.monthlyEscrowCents} className="text-xs" /></span></>)}
                    </div>
                  ) : loan && s ? (
                    <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs text-muted-foreground">
                      {loan.annualRateBps != null && (
                        <><span>Rate</span><span className="text-right font-mono tabular-nums">{(loan.annualRateBps / 100).toFixed(3)}%</span></>
                      )}
                      <span>Monthly P&amp;I</span><span className="text-right"><Money cents={s.paymentCents} className="text-xs" /></span>
                      {loan.monthlyEscrowCents > 0 && (<><span>Escrow</span><span className="text-right"><Money cents={loan.monthlyEscrowCents} className="text-xs" /></span></>)}
                      <span>Payoff</span><span className="text-right font-mono tabular-nums">{s.payoffDate ? s.payoffDate.slice(0, 7) : "—"}</span>
                      <span>Remaining interest</span><span className="text-right"><Money cents={s.totalInterestCents} className="text-xs" /></span>
                    </div>
                  ) : (
                    <Link href={`/ledger/${entityId}/loans`} className="text-xs text-evergreen hover:underline">
                      + Add rate &amp; term for payoff schedule
                    </Link>
                  )}
                  {loan?.notes && (
                    <p className="text-xs text-faint">{loan.notes}</p>
                  )}
                </div>
              );
            })}
          </div>
        </Section>
      </div>
      </div>
    </ReturnsAssumptionsProvider>
  );
}

function NetAssetSection({ nav }: { nav: NetAssetValue }) {
  return (
    <Section
      title="Net asset value"
      description="This entity holds no single rental property, so it's valued as the sum of what it holds — cash, loans it has made to others, equity investments, and property at stated value — net of its real debt."
    >
      <div className="grid gap-6 sm:grid-cols-3">
        <Figure label="Total assets" value={usd(nav.totalAssetsCents)} />
        <Figure label="Debt" value={usd(nav.totalDebtCents)} />
        <Figure
          label="Net asset value"
          value={usd(nav.navCents)}
          note="assets − debt"
          strong
        />
      </div>

      <div className="space-y-4 text-sm">
        {nav.groups.map((g) => (
          <div key={g.title}>
            <div className="flex items-baseline justify-between border-b border-hair py-1.5 text-[0.7rem] font-medium uppercase tracking-wide text-faint">
              <span>{g.title}</span>
              <Money cents={g.subtotalCents} tone="auto" className="text-xs" />
            </div>
            {g.lines.map((l) => (
              <div
                key={`${g.title}-${l.label}`}
                className="flex items-baseline justify-between gap-4 py-1 text-muted-foreground"
              >
                <span>
                  {l.label}
                  {l.note && <span className="ml-2 text-xs text-faint">{l.note}</span>}
                </span>
                <Money cents={l.cents} tone="auto" className="text-foreground/80" />
              </div>
            ))}
          </div>
        ))}

        {nav.debt.length > 0 && (
          <div>
            <div className="flex items-baseline justify-between border-b border-hair py-1.5 text-[0.7rem] font-medium uppercase tracking-wide text-faint">
              <span>Less: debt</span>
              <Money cents={-nav.totalDebtCents} tone="auto" className="text-xs" />
            </div>
            {nav.debt.map((l) => (
              <div
                key={`debt-${l.label}`}
                className="flex items-baseline justify-between gap-4 py-1 text-muted-foreground"
              >
                <span>{l.label}</span>
                <Money cents={-l.cents} tone="auto" className="text-foreground/80" />
              </div>
            ))}
          </div>
        )}

        <div className="flex items-baseline justify-between border-t border-ink py-2 font-medium">
          <span>Net asset value</span>
          <Money cents={nav.navCents} tone="auto" />
        </div>
      </div>

      {nav.excludedCashCents !== 0 && (
        <p className="max-w-prose text-xs text-faint">
          Excludes {usd(nav.excludedCashCents)} sitting in closed bank accounts
          (stale closing-transfer balances), plus operating working capital
          (receivables, payables) and fully-depreciated furniture — these net out
          and would distort a holdings valuation.
        </p>
      )}
    </Section>
  );
}

function Figure({ label, value, strong, note }: { label: string; value: string; strong?: boolean; note?: string }) {
  return (
    <div>
      <div className="text-[11px] font-medium uppercase tracking-[0.11em] text-muted-foreground">
        {label}
      </div>
      <div
        className={`mt-1 font-serif font-medium tracking-tight tabular-nums ${
          strong ? "text-3xl" : "text-2xl"
        }`}
      >
        {value}
      </div>
      {note && <div className="mt-0.5 text-xs text-faint">{note}</div>}
    </div>
  );
}

function Kv({ label, cents }: { label: string; cents: number }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span>{label}</span>
      <Money cents={cents} tone="auto" className="text-foreground/80" />
    </div>
  );
}
