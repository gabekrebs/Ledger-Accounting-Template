import { Fragment } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { categoryDetail, ledgerStats, type DetailTarget, type BelowLineBucket } from "@/lib/ledger/reports";
import { resolvePlPeriod, comparisonRange, rangeParams, type CompareMode } from "@/lib/ledger/pl-period";
import { Money } from "@/components/money";
import { PlDateControls } from "../date-controls";
import { EditTransactionButton } from "../../edit-transaction";

export const dynamic = "force-dynamic";

const TARGET_KEYS = ["cat", "sub", "acct", "channel", "racct", "bucket"] as const;

const partyNoun = (kind: "customer" | "vendor", n: number) =>
  kind === "customer" ? (n === 1 ? "customer" : "customers") : n === 1 ? "vendor" : "vendors";

export default async function PlDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ entityId: string }>;
  searchParams: Promise<
    { year?: string; start?: string; end?: string; cmp?: string } & Partial<Record<(typeof TARGET_KEYS)[number], string>>
  >;
}) {
  const { entityId } = await params;
  const sp = await searchParams;

  // The drill target + the params we must carry through the date/compare links.
  const target: DetailTarget = {};
  const carry: Record<string, string> = {};
  for (const k of TARGET_KEYS) {
    const v = sp[k];
    if (v) {
      carry[k] = v;
      if (k === "bucket") target.bucket = v as BelowLineBucket;
      else target[k] = v;
    }
  }
  if (Object.keys(carry).length === 0) notFound();

  const stats = await ledgerStats(entityId);
  const firstYear = stats.firstDate ? +stats.firstDate.slice(0, 4) : 2022;
  const lastYear = stats.lastDate ? +stats.lastDate.slice(0, 4) : 2026;
  const years: number[] = [];
  for (let y = lastYear; y >= firstYear; y--) years.push(y);

  const period = resolvePlPeriod(sp, new Date());
  const { opts, periodLabel } = period;

  const cmp: CompareMode | undefined =
    sp.cmp === "prior-period" || sp.cmp === "prior-year" ? sp.cmp : undefined;
  const cmpRange = cmp ? comparisonRange(opts, cmp) : null;

  const [detail, cmpDetail] = await Promise.all([
    categoryDetail(entityId, target, opts),
    cmpRange ? categoryDetail(entityId, target, cmpRange) : Promise.resolve(null),
  ]);

  const base = `/ledger/${entityId}/pl`;
  const detailBase = `${base}/detail`;
  const backHref = (() => {
    const q = new URLSearchParams(rangeParams(period));
    if (cmp) q.set("cmp", cmp);
    return `${base}?${q.toString()}`;
  })();

  const pct = (cur: number, prior: number) => {
    if (!prior) return "—";
    const v = ((cur - prior) / Math.abs(prior)) * 100;
    return `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(1)}%`;
  };

  return (
    <div className="space-y-5">
      <div>
        <Link href={backHref} className="text-sm text-faint hover:text-muted-foreground">
          ← Profit &amp; Loss
        </Link>
        <h2 className="mt-1 font-serif text-xl font-medium tracking-tight">{detail.label}</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {periodLabel} · {detail.count} {detail.count === 1 ? "entry" : "entries"} · {detail.parties.length}{" "}
          {partyNoun(detail.partyKind, detail.parties.length)}
        </p>
      </div>

      <PlDateControls
        base={detailBase}
        carry={carry}
        years={years}
        presets={period.presets}
        activePreset={period.activePreset}
        activeYear={period.activeYear}
        customRange={period.customRange}
        cmp={cmp}
      />

      {/* Comparison summary strip (the figure here vs the prior period). */}
      <div className="flex flex-wrap items-end gap-8 border-y border-hair py-3">
        <div>
          <div className="text-[11px] font-medium uppercase tracking-[0.06em] text-faint">{periodLabel}</div>
          <div className="font-serif text-lg"><Money cents={detail.totalCents} /></div>
        </div>
        {cmpRange && cmpDetail && (
          <>
            <div>
              <div className="text-[11px] font-medium uppercase tracking-[0.06em] text-faint">
                {cmpRange.shortLabel}
                <span className="ml-1 normal-case text-faint">
                  ({cmpRange.start} → {cmpRange.end})
                </span>
              </div>
              <div className="font-serif text-lg text-muted-foreground"><Money cents={cmpDetail.totalCents} /></div>
            </div>
            <div>
              <div className="text-[11px] font-medium uppercase tracking-[0.06em] text-faint">Change</div>
              <div className="font-mono tabular-nums text-lg text-muted-foreground">
                {pct(detail.totalCents, cmpDetail.totalCents)}
              </div>
            </div>
          </>
        )}
      </div>

      {/* Entries, grouped by customer/vendor (A→Z). */}
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-hair text-[11px] font-medium uppercase tracking-[0.06em] text-faint">
            <th className="py-2 text-left font-medium">{detail.partyKind === "customer" ? "Customer" : "Vendor"} · date</th>
            <th className="py-2 text-left font-medium">Type</th>
            <th className="py-2 text-left font-medium">Account · memo</th>
            <th className="py-2 text-right font-medium">Amount</th>
          </tr>
        </thead>
        <tbody>
          {detail.parties.map((v) => (
            <Fragment key={v.party}>
              <tr className="border-b border-hair/60 bg-secondary/40">
                <td colSpan={3} className="py-2 pl-1 font-medium">{v.party}</td>
                <td className="py-2 text-right font-medium"><Money cents={v.subtotalCents} /></td>
              </tr>
              {v.lines.map((l, i) => (
                <tr key={`${l.entryId}-${i}`} className="border-b border-hair/40">
                  <td className="whitespace-nowrap py-2 pl-4 font-mono tabular-nums text-muted-foreground">{l.txnDate}</td>
                  <td className="whitespace-nowrap py-2 text-xs text-faint">
                    <Link
                      href={`/ledger/${entityId}/transactions?q=${encodeURIComponent(l.qboTxnId ?? "")}`}
                      className="hover:text-evergreen hover:underline"
                    >
                      {l.qboTxnType}
                    </Link>
                  </td>
                  <td className="max-w-md truncate py-2 text-muted-foreground">
                    <span className="text-foreground">{l.accountName}</span>
                    {l.memo ? <span className="text-faint"> · {l.memo}</span> : null}
                  </td>
                  <td className="py-2 text-right">
                    <span className="inline-flex items-center justify-end gap-1.5">
                      <Money cents={l.amountCents} />
                      <EditTransactionButton
                        entityId={entityId}
                        entryId={l.entryId}
                        edited={!!l.editedAt}
                      />
                    </span>
                  </td>
                </tr>
              ))}
            </Fragment>
          ))}
          <tr className="border-t border-ink font-semibold">
            <td colSpan={3} className="pt-3">Total</td>
            <td className="pt-3 text-right"><Money cents={detail.totalCents} /></td>
          </tr>
          {detail.count === 0 && (
            <tr>
              <td colSpan={4} className="py-8 text-center text-sm text-muted-foreground">
                No entries in this period.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
