"use client";

import { useState } from "react";
import Link from "next/link";
import { Money } from "@/components/money";

type PlData = {
  revenueCents: number;
  operatingExpenseCents: number;
  noiCents: number;
  depreciationCents: number;
  interestCents: number;
  totalExpenseCents: number;
  netProfitCents: number;
};

type PeriodDataKey =
  | "30d" | "365d" | "lastYear"
  | "30d_noDepr" | "365d_noDepr" | "lastYear_noDepr";

type EntityData = {
  entityId: string;
  name: string | null;
  // The LOGGED-IN user's ownership % in this entity (first-name matched to the
  // entity's owners; null when they aren't an owner here). Never owner-specific.
  ownPct: number | null;
  // Owner-share of net profit per period, computed server-side and
  // time-weighted across dated ownership changes; null = not an owner.
  ownProfit?: Record<PeriodDataKey, number> | null;
  // Ownership % as of each period's END — the badge for historic periods
  // shows the split that actually earned that period's profit.
  ownPctByPeriod?: Record<"30d" | "365d" | "lastYear", number | null>;
  marketValueCents?: number;
  totalDebtCents?: number;
  equityCents?: number;
  "30d": PlData;
  "365d": PlData;
  lastYear: PlData;
  "30d_noDepr": PlData;
  "365d_noDepr": PlData;
  lastYear_noDepr: PlData;
};

type Period = "30d" | "365d" | "lastYear";
type View = "portfolio" | "own";

export function PortfolioComparison({
  data,
  lastYear,
  ownerName,
  canSeeOwnView,
}: {
  data: EntityData[];
  lastYear: number;
  /** First name of the signed-in user, used to label their own-share view. */
  ownerName: string;
  /** False for accountants (no ownership) — they see the Portfolio view only. */
  canSeeOwnView: boolean;
}) {
  const [period, setPeriod] = useState<Period>("365d");
  const [excludeDepr, setExcludeDepr] = useState(true);
  // Owners (admin + business partners) default to their own slice; accountants
  // can only ever see the portfolio-wide view.
  const [view, setView] = useState<View>(canSeeOwnView ? "own" : "portfolio");

  const periodLabels: Record<Period, string> = {
    "30d": "Last 30 days",
    "365d": "Last 365 days",
    lastYear: `${lastYear}`,
  };

  const dataKey: PeriodDataKey = excludeDepr ? `${period}_noDepr` : period;

  function getData(entity: EntityData): PlData {
    return entity[dataKey];
  }

  // Owner-share profit: prefer the server's time-weighted figure; the flat
  // multiplication remains only as a fallback for callers not sending it.
  function getOwnProfit(entity: EntityData): number {
    return (
      entity.ownProfit?.[dataKey] ??
      Math.round((getData(entity).netProfitCents * (entity.ownPct ?? 0)) / 100)
    );
  }

  const relevant = data.filter((e) => {
    const d = getData(e);
    return d.revenueCents !== 0 || d.totalExpenseCents !== 0;
  });

  // An accountant can never land on the own view even if state were forced.
  const isOwn = canSeeOwnView && view === "own";
  const availableViews: View[] = canSeeOwnView ? ["own", "portfolio"] : ["portfolio"];

  if (data.length < 1) return null;

  // Portfolio totals
  const totals = relevant.reduce(
    (acc, e) => {
      const d = getData(e);
      return {
        revenueCents: acc.revenueCents + d.revenueCents,
        totalExpenseCents: acc.totalExpenseCents + d.totalExpenseCents,
        netProfitCents: acc.netProfitCents + d.netProfitCents,
      };
    },
    { revenueCents: 0, totalExpenseCents: 0, netProfitCents: 0 }
  );

  // The signed-in user's pro-rata profit total (their % of each entity).
  const ownTotal = relevant.reduce((acc, e) => acc + getOwnProfit(e), 0);

  // Equity totals
  const hasEquity = data.some((e) => e.equityCents != null && e.equityCents !== 0);
  const totalEquity = relevant.reduce((acc, e) => acc + (e.equityCents ?? 0), 0);
  const ownEquity = relevant.reduce((acc, e) => {
    const pct = e.ownPct ?? 0;
    return acc + Math.round(((e.equityCents ?? 0) * pct) / 100);
  }, 0);

  return (
    <section className="space-y-4 pt-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-serif text-lg font-medium tracking-tight">
            Portfolio comparison
          </h2>
          <p className="text-xs text-muted-foreground">
            Real Estate P&L across all entities
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {availableViews.length > 1 && (
          <div className="flex items-center gap-1">
            {availableViews.map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setView(v)}
                className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs transition-colors ${
                  view === v
                    ? "border-evergreen bg-evergreen-soft text-evergreen"
                    : "border-hair text-muted-foreground hover:border-evergreen/40 hover:text-evergreen"
                }`}
              >
                {v === "portfolio" ? "Portfolio" : ownerName}
              </button>
            ))}
          </div>
        )}

        {availableViews.length > 1 && <span className="text-faint">|</span>}

        <div className="flex items-center gap-1">
          {(["30d", "365d", "lastYear"] as Period[]).map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setPeriod(p)}
              className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs transition-colors ${
                period === p
                  ? "border-evergreen bg-evergreen-soft text-evergreen"
                  : "border-hair text-muted-foreground hover:border-evergreen/40 hover:text-evergreen"
              }`}
            >
              {periodLabels[p]}
            </button>
          ))}
        </div>

        <label className="flex cursor-pointer select-none items-center gap-1.5 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={excludeDepr}
            onChange={(e) => setExcludeDepr(e.target.checked)}
            className="size-3.5 accent-evergreen"
          />
          Exclude depreciation
        </label>
      </div>

      <div className="overflow-x-auto rounded-xl border border-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/40 text-[11px] font-medium uppercase tracking-[0.06em] text-faint">
              <th className="py-2.5 pl-4 text-left">Entity</th>
              {isOwn && <th className="py-2.5 text-right">Ownership</th>}
              {!isOwn && <th className="py-2.5 text-right">Revenue</th>}
              {!isOwn && <th className="py-2.5 text-right">Expenses</th>}
              <th className="py-2.5 text-right">Net Profit</th>
              {hasEquity && <th className="py-2.5 pr-4 text-right">RE Equity</th>}
            </tr>
          </thead>
          <tbody>
            {relevant.map((e) => {
              const d = getData(e);
              const pct = e.ownPct ?? 0;
              const badgePct = e.ownPctByPeriod?.[period] ?? pct;
              const ownProfit = getOwnProfit(e);
              return (
                <tr key={e.entityId} className="border-b border-border/60 last:border-0">
                  <td className="py-2.5 pl-4">
                    <Link
                      href={`/ledger/${e.entityId}`}
                      className="font-medium hover:text-evergreen hover:underline"
                    >
                      {e.name}
                    </Link>
                  </td>
                  {isOwn && (
                    <td className="py-2.5 text-right font-mono text-xs tabular-nums text-muted-foreground">
                      {badgePct ? `${badgePct}%` : "—"}
                    </td>
                  )}
                  {!isOwn && (
                    <td className="py-2.5 text-right">
                      <Money cents={d.revenueCents} />
                    </td>
                  )}
                  {!isOwn && (
                    <td className="py-2.5 text-right">
                      <Money cents={d.totalExpenseCents} />
                    </td>
                  )}
                  <td className="py-2.5 text-right font-medium">
                    <Money cents={isOwn ? ownProfit : d.netProfitCents} tone="auto" />
                  </td>
                  {hasEquity && (
                    <td className="py-2.5 pr-4 text-right font-mono text-xs tabular-nums">
                      <Money cents={isOwn ? Math.round(((e.equityCents ?? 0) * pct) / 100) : (e.equityCents ?? 0)} />
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
          {relevant.length > 1 && (
            <tfoot>
              <tr className="border-t border-border bg-muted/20">
                <td className="py-2.5 pl-4 font-medium">
                  {isOwn ? `${ownerName} total` : "Portfolio total"}
                </td>
                {isOwn && <td />}
                {!isOwn && (
                  <td className="py-2.5 text-right font-medium">
                    <Money cents={totals.revenueCents} />
                  </td>
                )}
                {!isOwn && (
                  <td className="py-2.5 text-right font-medium">
                    <Money cents={totals.totalExpenseCents} />
                  </td>
                )}
                <td className="py-2.5 text-right font-semibold">
                  <Money cents={isOwn ? ownTotal : totals.netProfitCents} tone="auto" />
                </td>
                {hasEquity && (
                  <td className="py-2.5 pr-4 text-right font-semibold font-mono text-xs tabular-nums">
                    <Money cents={isOwn ? ownEquity : totalEquity} />
                  </td>
                )}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </section>
  );
}
