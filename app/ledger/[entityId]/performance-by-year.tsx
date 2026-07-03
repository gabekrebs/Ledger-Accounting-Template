"use client";

import { useState } from "react";
import Link from "next/link";
import { Money } from "@/components/money";
import { usd } from "@/lib/ledger/format";
import { depreciationTaxBenefit } from "@/lib/ledger/tax";
import { useReturnsAssumptions } from "./returns-assumptions";

export type YearRow = {
  year: number;
  revenueCents: number;
  operatingExpenseCents: number;
  noiCents: number;
  otherIncomeCents: number; // non-operating: gains on sale, interest income
  mortgageInterestCents: number;
  principalCents: number; // scheduled mortgage principal (balance-sheet paydown)
  depreciationCents: number;
  belowLineOtherCents: number; // non-operating / one-time (e.g. §481(a) adjustment)
  netIncomeCents: number;
};

type Lens = "none" | "cash" | "bridge";

/**
 * Operating performance by year, in the figure system. NOI is the headline; an
 * unlevered yield on cost sits beside it. Two collapsible lenses, never both at
 * once:
 *   • Cash flow — NOI − interest − principal (after debt service). Depreciation,
 *     a non-cash expense, is added back, so this is real cash, with its own
 *     cash-on-cash return on net invested basis.
 *   • Tax bridge — interest + depreciation → GAAP net income for K-1s.
 *
 * The two return columns use DIFFERENT denominators on purpose, because their
 * numerators sit on opposite sides of the debt line:
 *   • Yield on cost = NOI ÷ total cost basis. NOI is UNLEVERED (it's before any
 *     debt service), so its denominator must also be unlevered — the full cost
 *     of the asset (debt + equity), not the equity slice. NOI ÷ equity would
 *     credit the whole property's income against only the cash invested, which
 *     isn't a real metric.
 *   • Cash return = after-debt-service cash ÷ net invested basis. That cash IS
 *     levered (interest + principal already taken out), so cash-on-cash against
 *     the equity actually invested is the right, coherent pairing — same
 *     denominator as the hero card's ROE.
 */
export function PerformanceByYear({
  entityId,
  rows,
  totals,
  costBasisCents,
  contributedCapitalCents,
  depreciationToDateCents,
  netIncomeToDateCents,
  notes,
}: {
  entityId: string;
  rows: YearRow[];
  totals: Omit<YearRow, "year">;
  costBasisCents: number; // total cost basis = fixed assets at cost (debt + equity that bought them)
  contributedCapitalCents: number;
  depreciationToDateCents: number; // cumulative depreciation (+amortization), positive
  netIncomeToDateCents: number; // cumulative net income (negative = loss)
  notes?: string; // optional entity-specific footnotes
}) {
  const [lens, setLens] = useState<Lens>("none");
  const toggle = (l: Lens) => setLens((cur) => (cur === l ? "none" : l));

  // Net invested basis = contributed capital less the depreciation tax DEFERRED,
  // recomputed live from the hero's shared tax-rate / losses-usable assumptions so
  // these returns and the hero ROE always share one denominator. Depreciation
  // shelters the property's income (always tax-deferred) plus, when usable, the
  // excess passive loss — see depreciationTaxBenefit().
  const { taxRate, lossesUsable } = useReturnsAssumptions();
  const taxDeferredCents = depreciationTaxBenefit({
    depreciationCents: depreciationToDateCents,
    netIncomeCents: netIncomeToDateCents,
    taxRatePct: taxRate,
    lossesUsable,
  }).benefitCents;
  const netInvestedBasisCents = contributedCapitalCents - taxDeferredCents;
  const base = netInvestedBasisCents;
  const basisNote =
    taxDeferredCents > 0
      ? `${usd(contributedCapitalCents)} contributed capital less ${usd(taxDeferredCents)} of cumulative depreciation tax deferred (at a ${taxRate.toFixed(1)}% combined fed + state marginal rate)`
      : `${usd(contributedCapitalCents)} contributed capital`;
  const cashFlow = (r: Pick<YearRow, "noiCents" | "mortgageInterestCents" | "principalCents">) =>
    r.noiCents - r.mortgageInterestCents - r.principalCents;
  // One-time gains (asset sales) and interest income sit outside NOI; only show
  // the bridge column when the entity actually has any.
  const hasOtherIncome =
    totals.otherIncomeCents !== 0 || rows.some((r) => r.otherIncomeCents !== 0);
  // One-time / non-operating expenses (renovation, loan costs, §481(a) catch-up,
  // anything in QBO's "Other Expense" type) sit below NOI; only show the column
  // when the entity actually has any.
  const hasBelowLineOther =
    totals.belowLineOtherCents !== 0 || rows.some((r) => r.belowLineOtherCents !== 0);

  return (
    <div>
      <div className="mb-3 flex justify-end gap-5">
        <LensToggle active={lens === "cash"} onClick={() => toggle("cash")} label="cash flow" />
        <LensToggle active={lens === "bridge"} onClick={() => toggle("bridge")} label="tax bridge" />
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-hair text-[11px] font-medium uppercase tracking-[0.06em] text-faint">
              <th className="py-2 text-left font-medium">Year</th>
              <th className="py-2 text-right font-medium">Income</th>
              <th className="py-2 text-right font-medium">Operating exp.</th>
              <th className="py-2 text-right font-medium">Net Profit</th>
              <th className="py-2 text-right font-medium">Yield on cost</th>
              {lens === "cash" && (
                <>
                  <th className="py-2 text-right font-medium">− Mtg int.</th>
                  <th className="py-2 text-right font-medium">− Principal</th>
                  <th className="py-2 text-right font-medium">Cash flow</th>
                  <th className="py-2 text-right font-medium">Cash return</th>
                </>
              )}
              {lens === "bridge" && (
                <>
                  {hasOtherIncome && (
                    <th className="py-2 text-right font-medium">+ Other inc.</th>
                  )}
                  <th className="py-2 text-right font-medium">− Mtg int.</th>
                  <th className="py-2 text-right font-medium">− Deprec.</th>
                  {hasBelowLineOther && (
                    <th className="py-2 text-right font-medium">− Other</th>
                  )}
                  <th className="py-2 text-right font-medium">Net income</th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {rows.filter((a) => a.revenueCents !== 0 || a.operatingExpenseCents !== 0).map((a) => {
              const cf = cashFlow(a);
              return (
                <tr key={a.year} className="border-b border-hair/60">
                  <td className="py-2.5 font-medium">
                    <Link href={`/ledger/${entityId}/pl?year=${a.year}`} className="hover:text-evergreen hover:underline">
                      {a.year}
                    </Link>
                  </td>
                  <td className="py-2.5 text-right"><Money cents={a.revenueCents} /></td>
                  <td className="py-2.5 text-right"><Money cents={a.operatingExpenseCents} /></td>
                  <td className="py-2.5 text-right"><Money cents={a.noiCents - a.mortgageInterestCents} tone="auto" className={a.noiCents - a.mortgageInterestCents >= 0 ? "text-evergreen" : ""} /></td>
                  <td className="py-2.5 text-right"><Pct cents={a.noiCents - a.mortgageInterestCents} base={costBasisCents} /></td>
                  {lens === "cash" && (
                    <>
                      <td className="py-2.5 text-right text-faint"><Money cents={a.mortgageInterestCents} /></td>
                      <td className="py-2.5 text-right text-faint"><Money cents={a.principalCents} /></td>
                      <td className="py-2.5 text-right"><Money cents={cf} tone="auto" className={cf >= 0 ? "text-evergreen" : ""} /></td>
                      <td className="py-2.5 text-right"><Pct cents={cf} base={base} /></td>
                    </>
                  )}
                  {lens === "bridge" && (
                    <>
                      {hasOtherIncome && (
                        <td className="py-2.5 text-right text-faint"><Money cents={a.otherIncomeCents} /></td>
                      )}
                      <td className="py-2.5 text-right text-faint"><Money cents={a.mortgageInterestCents} /></td>
                      <td className="py-2.5 text-right text-faint"><Money cents={a.depreciationCents} /></td>
                      {hasBelowLineOther && (
                        <td className="py-2.5 text-right text-faint"><Money cents={a.belowLineOtherCents} /></td>
                      )}
                      <td className="py-2.5 text-right text-faint"><Money cents={a.netIncomeCents} tone="auto" /></td>
                    </>
                  )}
                </tr>
              );
            })}
            <tr className="border-t border-ink font-medium">
              <td className="pt-3">All-time</td>
              <td className="pt-3 text-right"><Money cents={totals.revenueCents} /></td>
              <td className="pt-3 text-right"><Money cents={totals.operatingExpenseCents} /></td>
              <td className="pt-3 text-right"><Money cents={totals.noiCents - totals.mortgageInterestCents} tone="auto" className={totals.noiCents - totals.mortgageInterestCents >= 0 ? "text-evergreen" : ""} /></td>
              <td className="pt-3 text-right"><Pct cents={totals.noiCents - totals.mortgageInterestCents} base={costBasisCents} /></td>
              {lens === "cash" && (
                <>
                  <td className="pt-3 text-right text-faint"><Money cents={totals.mortgageInterestCents} /></td>
                  <td className="pt-3 text-right text-faint"><Money cents={totals.principalCents} /></td>
                  <td className="pt-3 text-right"><Money cents={cashFlow(totals)} tone="auto" className={cashFlow(totals) >= 0 ? "text-evergreen" : ""} /></td>
                  <td className="pt-3 text-right"><Pct cents={cashFlow(totals)} base={base} /></td>
                </>
              )}
              {lens === "bridge" && (
                <>
                  {hasOtherIncome && (
                    <td className="pt-3 text-right text-faint"><Money cents={totals.otherIncomeCents} /></td>
                  )}
                  <td className="pt-3 text-right text-faint"><Money cents={totals.mortgageInterestCents} /></td>
                  <td className="pt-3 text-right text-faint"><Money cents={totals.depreciationCents} /></td>
                  {hasBelowLineOther && (
                    <td className="pt-3 text-right text-faint"><Money cents={totals.belowLineOtherCents} /></td>
                  )}
                  <td className="pt-3 text-right text-faint"><Money cents={totals.netIncomeCents} tone="auto" /></td>
                </>
              )}
            </tr>
          </tbody>
        </table>
      </div>

      {lens === "cash" ? (
        <p className="mt-3 text-xs leading-relaxed text-faint">
          Cash flow is NOI − mortgage interest − scheduled principal — the cash left after debt
          service. Depreciation, a paper deduction, is added back (it’s never cash out the door).
          Because that cash is <em>after</em> debt service, its return is a cash-on-cash yield on net
          invested basis of {usd(netInvestedBasisCents)} — {basisNote}, the same denominator as the
          headline ROE above. Yield on cost stays unlevered (NOI ÷ {usd(costBasisCents)} cost basis).
        </p>
      ) : lens === "bridge" ? (
        <p className="mt-3 text-xs leading-relaxed text-faint">
          The grayed “tax bridge” — mortgage interest and depreciation — turns NOI into the GAAP net
          income used for K-1s. Depreciation is a paper deduction, not cash out the door. Yield on
          cost is NOI ÷ total cost basis of {usd(costBasisCents)} — unlevered, since NOI is measured
          before any debt service.
        </p>
      ) : (
        <p className="mt-3 text-xs leading-relaxed text-faint">
          Net Profit is revenue minus all operating expenses including mortgage interest (debt service).
          Yield on cost is Net Profit ÷ total cost basis of {usd(costBasisCents)}.
          Open the cash-flow lens for after-principal cash and its cash-on-cash return.
        </p>
      )}
      {notes && (
        <div className="mt-4 rounded-lg border border-hair bg-muted/30 px-4 py-3">
          <p className="text-xs font-medium text-muted-foreground mb-1.5">Notes</p>
          {notes!.split("\n").map((line, i) => (
            <p key={i} className="text-xs leading-relaxed text-faint">{line}</p>
          ))}
        </div>
      )}
    </div>
  );
}

function LensToggle({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      className={`text-sm transition-colors hover:text-evergreen ${
        active ? "font-medium text-evergreen" : "text-muted-foreground"
      }`}
    >
      {active ? `Hide ${label} ▾` : `Show ${label} ▸`}
    </button>
  );
}

/** A return percentage = cents ÷ net invested basis. Evergreen positive, oxblood negative. */
function Pct({ cents, base }: { cents: number; base: number }) {
  if (base <= 0) return <span className="font-mono tabular-nums text-faint">—</span>;
  const v = (cents / base) * 100;
  return (
    <span className={`font-mono tabular-nums ${v >= 0 ? "text-evergreen" : "text-oxblood"}`}>
      {v.toFixed(1)}%
    </span>
  );
}
