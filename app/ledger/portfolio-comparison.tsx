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

type EntityData = {
  entityId: string;
  name: string | null;
  ownerPct: number | null;
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
type View = "portfolio" | "owner";

export function PortfolioComparison({
  data,
  lastYear,
}: {
  data: EntityData[];
  lastYear: number;
}) {
  const [period, setPeriod] = useState<Period>("365d");
  const [excludeDepr, setExcludeDepr] = useState(true);
  const [view, setView] = useState<View>("portfolio");

  const periodLabels: Record<Period, string> = {
    "30d": "Last 30 days",
    "365d": "Last 365 days",
    lastYear: `${lastYear}`,
  };

  function getData(entity: EntityData): PlData {
    if (excludeDepr) {
      return entity[`${period}_noDepr`];
    }
    return entity[period];
  }

  const relevant = data.filter((e) => {
    const d = getData(e);
    return d.revenueCents !== 0 || d.totalExpenseCents !== 0;
  });

  const isOwner = view === "owner";

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

  // Owner pro-rata total
  const ownerTotal = relevant.reduce((acc, e) => {
    const d = getData(e);
    const pct = e.ownerPct ?? 0;
    return acc + Math.round(d.netProfitCents * pct / 100);
  }, 0);

  // Equity totals
  const hasEquity = data.some((e) => e.equityCents != null && e.equityCents !== 0);
  const totalEquity = relevant.reduce((acc, e) => acc + (e.equityCents ?? 0), 0);
  const ownerEquity = relevant.reduce((acc, e) => {
    const pct = e.ownerPct ?? 0;
    return acc + Math.round((e.equityCents ?? 0) * pct / 100);
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
        <div className="flex items-center gap-1">
          {(["owner", "portfolio"] as View[]).map((v) => (
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
              {v === "portfolio" ? "Portfolio" : "Owner"}
            </button>
          ))}
        </div>

        <span className="text-faint">|</span>

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
              {isOwner && <th className="py-2.5 text-right">Ownership</th>}
              {!isOwner && <th className="py-2.5 text-right">Revenue</th>}
              {!isOwner && <th className="py-2.5 text-right">Expenses</th>}
              <th className="py-2.5 text-right">Net Profit</th>
              {hasEquity && <th className="py-2.5 pr-4 text-right">RE Equity</th>}
            </tr>
          </thead>
          <tbody>
            {relevant.map((e) => {
              const d = getData(e);
              const pct = e.ownerPct ?? 0;
              const ownerProfit = Math.round(d.netProfitCents * pct / 100);
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
                  {isOwner && (
                    <td className="py-2.5 text-right font-mono text-xs tabular-nums text-muted-foreground">
                      {pct ? `${pct}%` : "—"}
                    </td>
                  )}
                  {!isOwner && (
                    <td className="py-2.5 text-right">
                      <Money cents={d.revenueCents} />
                    </td>
                  )}
                  {!isOwner && (
                    <td className="py-2.5 text-right">
                      <Money cents={d.totalExpenseCents} />
                    </td>
                  )}
                  <td className="py-2.5 text-right font-medium">
                    <Money cents={isOwner ? ownerProfit : d.netProfitCents} tone="auto" />
                  </td>
                  {hasEquity && (
                    <td className="py-2.5 pr-4 text-right font-mono text-xs tabular-nums">
                      <Money cents={isOwner ? Math.round((e.equityCents ?? 0) * (e.ownerPct ?? 0) / 100) : (e.equityCents ?? 0)} />
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
                  {isOwner ? "Owner total" : "Portfolio total"}
                </td>
                {isOwner && <td />}
                {!isOwner && (
                  <td className="py-2.5 text-right font-medium">
                    <Money cents={totals.revenueCents} />
                  </td>
                )}
                {!isOwner && (
                  <td className="py-2.5 text-right font-medium">
                    <Money cents={totals.totalExpenseCents} />
                  </td>
                )}
                <td className="py-2.5 text-right font-semibold">
                  <Money cents={isOwner ? ownerTotal : totals.netProfitCents} tone="auto" />
                </td>
                {hasEquity && (
                  <td className="py-2.5 pr-4 text-right font-semibold font-mono text-xs tabular-nums">
                    <Money cents={isOwner ? ownerEquity : totalEquity} />
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
