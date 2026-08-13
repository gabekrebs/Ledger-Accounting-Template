"use client";

import { useState } from "react";
import { Money } from "@/components/money";
import { usd } from "@/lib/ledger/format";
import { depreciationTaxBenefit } from "@/lib/ledger/tax";
import { xirr } from "@/lib/ledger/irr";
import { useReturnsAssumptions } from "./returns-assumptions";

/**
 * The Overview hero — the partner-investor answer to "how is my money doing."
 * Total return since inception, ROE on NET invested basis, and the three ways
 * the property pays you (cash flow, principal paydown, appreciation). The
 * depreciation tax benefit is NOT a return line — it's the tax DEFERRED because
 * depreciation shelters the property's income, so the cash flow reaches you
 * tax-deferred. That's cash you've kept rather than sent to the IRS, so it
 * lowers the capital still at risk (the ROE denominator), not the return.
 * It's a deferral — recaptured only on a taxable sale — so we footnote that and
 * don't net it out while holding. Recomputed live as the cap-rate and tax-rate
 * assumptions move; inputs are precomputed server-side from the ledger.
 *
 * Two valuation methodologies drive the implied value (and so appreciation):
 *   'income' — cap-rate on stabilized NOI; the cap rate is a live slider.
 *              Right for multifamily / commercial / hospitality.
 *   'market' — a fixed Redfin/Zillow/comp value (single-family houses & duplexes
 *              trade on comps, not a cap rate); the cap-rate slider is replaced
 *              by the value's source + as-of date. Appreciation = value − cost basis
 *              either way. ('none' entities never render this component.)
 */
export function InvestmentReturns(props: {
  valuationMethod: "income" | "market";
  stabilizedNoiCents: number;
  stabilizedYear: number;
  marketValueCents: number; // for method='market'
  marketValueSource: string | null;
  marketValueAsOf: string | null;
  valuationUrl: string | null;
  // Per-structure breakdown with each source's estimate, for the provenance note.
  marketBreakdown?: {
    label: string;
    chosenCents: number;
    estimates: { source: string; valueCents: number }[];
  }[];
  costBasisCents: number; // all fixed assets at cost (gross of depreciation)
  contributedEquityCents: number;
  totalDebtCents: number;
  // Bank + escrow balances as of `asOf`. Owner equity on liquidation is the
  // property value PLUS the cash the entity is sitting on, minus debt —
  // without this, undistributed (e.g. refi or operating) cash never reaches
  // the IRR/equity-multiple terminal and the return reads low.
  liquidAssetsCents: number;
  cashFlowCents: number; // cumulative NOI − interest
  principalPaidCents: number; // cumulative paydown
  depreciationToDateCents: number; // cumulative depreciation (+amortization), positive
  netIncomeToDateCents: number; // cumulative net income (negative = loss)
  holdingYears: number;
  partners: { name: string; contributedCents: number; ownershipPct: number | null }[];
  asOf: string;
  // Dated owner cash flows (contributions negative, distributions positive) for
  // the money-weighted IRR. Terminal equity is appended here, client-side, so it
  // tracks the live cap-rate slider.
  cashFlowSeries: { date: string; amountCents: number }[];
  cashContributedCents: number;
  cashDistributedCents: number;
}) {
  const isMarket = props.valuationMethod === "market";
  const [capRate, setCapRate] = useState(5.5);
  // Shared with Performance-by-year so the sliders drive that table's returns too.
  // taxRate is the combined federal + state marginal rate the tax math consumes.
  const {
    fedRate,
    setFedRate,
    stateRate,
    setStateRate,
    taxRate,
    lossesUsable,
    setLossesUsable,
  } = useReturnsAssumptions();
  const [partnerIdx, setPartnerIdx] = useState<number | null>(null);

  // Per-partner view: scale every figure by the partner's ownership percentage.
  // Falls back to contributed capital ratios if ownership % isn't set.
  const selected = partnerIdx === null ? null : props.partners[partnerIdx];
  const share = (() => {
    if (!selected) return 1;
    if (selected.ownershipPct != null) return selected.ownershipPct / 100;
    const partnerTotalCents =
      props.partners.reduce((s, p) => s + p.contributedCents, 0) ||
      props.contributedEquityCents;
    return partnerTotalCents ? selected.contributedCents / partnerTotalCents : 1;
  })();
  const sc = (c: number) => Math.round(c * share);

  // Market: the value is a fixed comp/AVM figure (no cap-rate inference).
  // Income: value = stabilized NOI capitalized at the live cap-rate slider.
  const valueCents = isMarket
    ? props.marketValueCents
    : Math.round(props.stabilizedNoiCents / (capRate / 100));
  const cashFlowCents = sc(props.cashFlowCents);
  const principalPaidCents = sc(props.principalPaidCents);
  const appreciationCents = sc(valueCents - props.costBasisCents);
  // Depreciation tax benefit = tax DEFERRED, not profit. Depreciation shelters
  // the property's income (the cash flow reaches you tax-deferred), so it's cash
  // you've kept — it lowers the principal still at risk (the ROE denominator),
  // never a return line. Shelter of the property's own income always counts; the
  // excess passive loss only when usable. Deferral, recaptured at sale (footnoted).
  const tax = depreciationTaxBenefit({
    depreciationCents: props.depreciationToDateCents,
    netIncomeCents: props.netIncomeToDateCents,
    taxRatePct: taxRate,
    lossesUsable,
  });
  const depreciationCents = sc(props.depreciationToDateCents);
  const shelteredOwnIncomeCents = sc(tax.shelteredOwnIncomeCents);
  const excessLossCents = sc(tax.excessLossCents);
  const taxBenefitCents = sc(tax.benefitCents);
  const hasDepreciation = props.depreciationToDateCents > 0;
  const contributedEquityCents = selected
    ? selected.contributedCents
    : props.contributedEquityCents;
  const totalReturnCents = cashFlowCents + principalPaidCents + appreciationCents;
  const netInvestedCents = contributedEquityCents - taxBenefitCents;
  const marketEquityCents = sc(
    valueCents + props.liquidAssetsCents - props.totalDebtCents
  );
  const roePct =
    netInvestedCents > 0 ? (totalReturnCents / netInvestedCents) * 100 : 0;
  const annualizedPct = props.holdingYears ? roePct / props.holdingYears : 0;

  // IRR + equity multiple — the money-weighted, correctly-annualized headline.
  // IRR solves the actual dated owner cash flows with the current whole-property
  // equity as the terminal value; the multiple is total value returned + held
  // over capital put in. Both are scale-invariant, so they read the same whether
  // you view the whole property or one partner's share. Terminal tracks the live
  // cap-rate slider (income method). Terminal = "liquidate today": property
  // value + bank/escrow cash − debt, so undistributed cash still counts.
  const wholeEquityCents =
    valueCents + props.liquidAssetsCents - props.totalDebtCents;
  const irr = xirr([
    ...props.cashFlowSeries,
    { date: props.asOf, amountCents: wholeEquityCents },
  ]);
  const equityMultiple =
    props.cashContributedCents > 0
      ? (props.cashDistributedCents + wholeEquityCents) / props.cashContributedCents
      : null;

  const ways = [
    { label: "Cash flow", hint: "NOI − interest", cents: cashFlowCents },
    { label: "Principal paydown", hint: "mortgage paid down", cents: principalPaidCents },
    { label: "Appreciation", hint: `value − ${usd(props.costBasisCents)} cost basis`, cents: appreciationCents },
  ];
  // Bars decompose the total return, so scale each to the sum of magnitudes
  // (not the single largest line). This makes the three bars add to the whole,
  // and keeps one big +/− line from hijacking the axis. Each width = the
  // source's share of total return.
  const waysDenom = Math.max(1, ways.reduce((s, w) => s + Math.abs(w.cents), 0));

  return (
    <section className="space-y-8">
      {/* partner selector — view the whole property or your personal share */}
      {props.partners.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="mr-1 text-[11px] font-medium uppercase tracking-[0.11em] text-muted-foreground">
            View as
          </span>
          <PartnerPill active={partnerIdx === null} onClick={() => setPartnerIdx(null)} label="Whole property" />
          {props.partners.map((p, i) => {
            const pct = p.ownershipPct != null
              ? `${p.ownershipPct}%`
              : `${((p.contributedCents / (props.partners.reduce((s, pp) => s + pp.contributedCents, 0) || 1)) * 100).toFixed(0)}%`;
            return (
              <PartnerPill
                key={p.name}
                active={partnerIdx === i}
                onClick={() => setPartnerIdx(i)}
                label={p.name}
                pct={pct}
              />
            );
          })}
        </div>
      )}

      {/* hero band */}
      <div className="grid items-start gap-x-14 gap-y-8 lg:grid-cols-[1.1fr_1fr]">
        <div>
          <div className="text-[11px] font-medium uppercase tracking-[0.11em] text-muted-foreground">
            {selected
              ? `${selected.name} · ${(share * 100).toFixed(1)}% by contributed capital`
              : "Total return · since inception"}{" "}
            · {props.holdingYears.toFixed(1)} yrs
          </div>
          <div className="mt-2 font-serif text-5xl font-medium tracking-tight">
            <Money
              cents={totalReturnCents}
              sign
              paren={false}
              className={totalReturnCents >= 0 ? "text-evergreen" : "text-oxblood"}
            />
          </div>
          <p className="mt-3 text-sm text-muted-foreground">
            {irr !== null && (
              <>
                <span className="font-medium text-foreground">{(irr * 100).toFixed(1)}%</span> IRR
                since inception ·{" "}
              </>
            )}
            {equityMultiple !== null && (
              <>
                <span className="font-medium text-foreground">{equityMultiple.toFixed(1)}×</span>{" "}
                equity multiple
              </>
            )}
          </p>

          <div className="mt-5 flex gap-10">
            <Figure label={isMarket ? "Market value" : "Implied value"} value={usd(valueCents)} />
            <Figure label="Market equity" value={usd(marketEquityCents)} />
          </div>
        </div>

        {/* assumptions */}
        <div className="rounded-2xl border border-hair bg-card p-5">
          {isMarket ? (
            // Single-family / duplex / stake: value is a comp/AVM/stake figure,
            // not a cap rate. Show it + where every dollar came from.
            <div className="space-y-2.5">
              <div className="flex items-baseline justify-between text-sm">
                <span className="text-muted-foreground">Market value</span>
                <span className="font-mono font-medium tabular-nums">{usd(valueCents)}</span>
              </div>

              {/* multi-structure breakdown (e.g. duplex + house = total) */}
              {(props.marketBreakdown?.length ?? 0) > 1 && (
                <div className="space-y-1 border-t border-hair pt-2">
                  {props.marketBreakdown!.map((c) => (
                    <div key={c.label} className="flex items-baseline justify-between text-xs">
                      <span className="text-muted-foreground">{c.label}</span>
                      <span className="font-mono tabular-nums">{usd(c.chosenCents)}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* every source's estimate, side by side (the provenance) */}
              {props.marketBreakdown?.length === 1 && props.marketBreakdown[0].estimates.length > 0 && (
                <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-hair pt-2 text-xs">
                  {props.marketBreakdown[0].estimates.map((e) => (
                    <span key={e.source} className="text-faint">
                      <span className="capitalize text-muted-foreground">{e.source}</span>{" "}
                      <span className="font-mono tabular-nums">{usd(e.valueCents)}</span>
                    </span>
                  ))}
                </div>
              )}

              <p className="text-xs text-faint">
                {props.marketValueSource ?? "Comps"}
                {props.marketValueAsOf ? ` · as of ${props.marketValueAsOf}` : ""} — comps, not a cap rate.{" "}
                {props.valuationUrl && (
                  <a href={props.valuationUrl} target="_blank" rel="noreferrer" className="text-evergreen hover:underline">
                    listing ↗
                  </a>
                )}
              </p>
            </div>
          ) : (
            <>
              <Slider
                label="Cap rate"
                value={`${capRate.toFixed(2)}%`}
                min={3}
                max={9}
                step={0.05}
                v={capRate}
                onChange={setCapRate}
              />
              <p className="mt-1.5 text-xs text-faint">
                Implied value {usd(valueCents)} · {props.stabilizedYear} NOI {usd(props.stabilizedNoiCents)}
              </p>
            </>
          )}

          <div className="mt-4">
            <Slider
              label="Federal tax rate"
              value={`${fedRate}%`}
              min={0}
              max={50}
              step={1}
              v={fedRate}
              onChange={(n) => setFedRate(Math.round(n))}
            />
          </div>
          <div className="mt-3">
            <Slider
              label="State tax rate"
              value={`${stateRate.toFixed(1)}%`}
              min={0}
              max={15}
              step={0.1}
              v={stateRate}
              onChange={(n) => setStateRate(Math.round(n * 10) / 10)}
            />
            <p className="mt-1.5 text-xs text-faint">
              Combined marginal rate {taxRate.toFixed(1)}% ({fedRate}% fed + {stateRate.toFixed(1)}% state)
            </p>
          </div>
          <label className="mt-3.5 flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={lossesUsable}
              onChange={(e) => setLossesUsable(e.target.checked)}
              className="accent-evergreen"
            />
            Losses usable now (else deferred to sale → $0)
          </label>
        </div>
      </div>

      {/* the three ways (tax benefit is deferred tax / basis reduction, shown separately below) */}
      <div>
        <h2 className="font-serif text-lg font-medium tracking-tight">The three ways it pays you</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Every dollar of return since inception, by source — each bar is that source’s share of total
          return. (The tax benefit isn’t here — it’s deferred tax that lowers the capital you have at
          risk, not a return; see below.)
        </p>
        <div className="mt-4">
          {ways.map((w) => (
            <div
              key={w.label}
              className="grid grid-cols-[minmax(150px,1.1fr)_minmax(0,2fr)_minmax(110px,auto)] items-center gap-5 border-b border-hair py-2.5"
            >
              <div className="text-sm">
                {w.label}
                <span className="ml-2 text-xs text-faint">{w.hint}</span>
              </div>
              <div className="h-2 rounded bg-[#EEEAE1] dark:bg-hair">
                <div
                  className={`h-2 rounded ${w.cents < 0 ? "bg-oxblood" : "bg-evergreen"}`}
                  style={{ width: `${(Math.abs(w.cents) / waysDenom) * 100}%` }}
                />
              </div>
              <Money cents={w.cents} tone="auto" className="text-right" />
            </div>
          ))}
          <div className="mt-1.5 flex items-baseline justify-between border-t border-ink pt-3">
            <span className="font-semibold">Total return</span>
            <Money
              cents={totalReturnCents}
              tone="auto"
              className={`text-lg font-semibold ${totalReturnCents >= 0 ? "text-evergreen" : ""}`}
            />
          </div>
        </div>

        {/* Tax benefit — NOT a return line. Deferred tax → lowers capital at risk. */}
        {hasDepreciation && (
          <div className="mt-5 rounded-xl border border-hair bg-[#FAF8F3] p-4 dark:bg-secondary">
            <div className="flex items-baseline justify-between">
              <span className="text-sm font-medium">
                Tax deferred
                <span className="ml-2 text-xs font-normal text-faint">
                  depreciation {usd(depreciationCents)} × {taxRate.toFixed(1)}%
                </span>
              </span>
              <span className="text-sm font-medium tabular-nums text-muted-foreground">
                deferred · {usd(taxBenefitCents)}
              </span>
            </div>
            <p className="mt-1.5 text-xs leading-relaxed text-faint">
              Shelters {usd(shelteredOwnIncomeCents)} of this property’s own income (always
              tax-deferred to you)
              {excessLossCents > 0 && (
                <>
                  {" "}· {usd(excessLossCents)} excess loss shelters your other income{" "}
                  {lossesUsable ? "(usable now)" : "(suspended → carries to sale, not counted)"}
                </>
              )}
              .
            </p>
            <div className="mt-3 flex items-baseline justify-between border-t border-hair pt-3">
              <span className="text-sm">
                Net invested basis
                <span className="ml-2 text-xs text-faint">
                  {usd(contributedEquityCents)} contributed − {usd(taxBenefitCents)} tax deferred
                </span>
              </span>
              <span className="font-semibold tabular-nums">{usd(netInvestedCents)}</span>
            </div>
            {netInvestedCents > 0 && (
              <p className="mt-1.5 text-xs text-faint">
                Cumulative return on this basis is {roePct.toFixed(0)}% ({annualizedPct.toFixed(1)}% ÷
                yr) — shown for reference; the headline uses IRR, which weights cash flows by
                when they happened and annualizes correctly.
              </p>
            )}
            <p className="mt-2.5 text-xs leading-relaxed text-faint">
              Not profit — depreciation is a non-cash deduction that{" "}
              <span className="font-medium text-muted-foreground">shelters the property’s income</span>,
              so your cash flow reaches you tax-deferred. That’s cash you’ve kept rather than paid in
              tax, which lowers the capital you still have at risk — so ROE is measured against this net
              invested basis. It’s a <span className="font-medium text-muted-foreground">deferral</span>:
              recaptured only on a taxable sale (and a 1031 exchange or a step-up at death can erase
              that), so while you hold, it isn’t netted back out. Combined fed + state rate is additive
              (correct over the SALT cap); an Oregon PTE-E election would make state tax deductible
              federally, trimming the effective rate slightly.
            </p>
          </div>
        )}
        <div className="mt-4 space-y-2 text-xs leading-relaxed text-faint">
          <p>
            Appreciation nets against a cost basis of {usd(props.costBasisCents)}{" "}— all fixed
            assets (land, building, improvements &amp; FF&amp;E) at cost, gross of depreciation —
            so it isn’t overstated.
          </p>
          <p>
            Three “equity” numbers, all true and never conflated:{" "}
            <span className="font-medium text-muted-foreground">contributed capital {usd(contributedEquityCents)}</span>{" "}
            (what partners put in) ·{" "}
            <span className="font-medium text-muted-foreground">market equity {usd(marketEquityCents)}</span>{" "}
            (implied value + cash &amp; escrow − debt) · book equity on the balance sheet (after depreciation, for
            K-1s). Return is measured against{" "}
            <span className="font-medium text-muted-foreground">net invested basis</span> —
            contributed capital less the depreciation tax deferred.
          </p>
        </div>
      </div>
    </section>
  );
}

function PartnerPill({
  active,
  onClick,
  label,
  pct,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  pct?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
        active
          ? "border-evergreen bg-evergreen text-white"
          : "border-hair bg-card text-muted-foreground hover:border-evergreen/50"
      }`}
    >
      {label}
      {pct && <span className={`ml-1.5 ${active ? "opacity-80" : "text-faint"}`}>{pct}</span>}
    </button>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[11px] font-medium uppercase tracking-[0.11em] text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 font-serif text-[22px] font-medium tracking-tight">{value}</div>
    </div>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  v,
  onChange,
}: {
  label: string;
  value: string;
  min: number;
  max: number;
  step: number;
  v: number;
  onChange: (n: number) => void;
}) {
  const pct = ((v - min) / (max - min)) * 100;
  return (
    <div>
      <div className="flex items-baseline justify-between text-sm">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-mono font-medium tabular-nums">{value}</span>
      </div>
      <input
        type="range"
        className="rng mt-3 w-full"
        min={min}
        max={max}
        step={step}
        value={v}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        style={{
          background: `linear-gradient(90deg, var(--evergreen) 0 ${pct}%, var(--hair) ${pct}% 100%)`,
        }}
      />
    </div>
  );
}
