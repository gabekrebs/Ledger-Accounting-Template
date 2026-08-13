import { Fragment } from "react";
import Link from "next/link";
import { profitAndLoss, revenueByChannel, expenseSubtypeGroups, ledgerStats, entityHasLocations } from "@/lib/ledger/reports";
import { PlViewToggle } from "../pl-view-toggle";
import { getEntityActivities } from "@/lib/ledger/manage-accounts";
import { resolvePlPeriod, comparisonRange, rangeParams, type CompareMode } from "@/lib/ledger/pl-period";
import { Money } from "@/components/money";
import { PlDateControls } from "./date-controls";
import { ActivityFilter } from "./activity-filter";
import { variancePct } from "@/lib/ledger/format";

export const dynamic = "force-dynamic";

// ── Trailing comparison cells (prior amount + Δ%), only when comparison on ──
const pct = (cur: number, prior: number): React.ReactNode => {
  const s = variancePct(cur, prior);
  if (s === null) return <span className="text-faint">—</span>;
  return <span className="font-mono tabular-nums text-xs text-muted-foreground">{s}</span>;
};
const Cmp = ({ cmpOn, prior, cur, small }: { cmpOn: boolean; prior: number; cur: number; small?: boolean }) =>
  cmpOn ? (
    <>
      <td className={`text-right ${small ? "py-1" : "py-2.5"}`}>
        <Money cents={prior} className={small ? "text-xs text-muted-foreground" : "text-muted-foreground"} />
      </td>
      <td className={`text-right ${small ? "py-1" : "py-2.5"}`}>{pct(cur, prior)}</td>
    </>
  ) : null;

const Group = ({
  title,
  lines,
  total,
  cmpTotal,
  acctDrill,
  span,
  drill,
  cmpAcct,
  cmpOn,
}: {
  title: string;
  lines: { qboAccountId: string; name: string; amountCents: number }[];
  total: number;
  cmpTotal: number;
  acctDrill: boolean;
  span: number;
  drill: (target: Record<string, string>) => string;
  cmpAcct: Map<string, number>;
  cmpOn: boolean;
}) => (
  <>
    <tr>
      <td colSpan={span} className="pt-6 pb-1 text-[11px] font-medium uppercase tracking-[0.06em] text-faint">
        {title}
      </td>
    </tr>
    {lines.map((l) => (
      <tr key={l.qboAccountId} className="border-b border-hair/60">
        <td className="py-2.5 pl-4">
          {acctDrill ? (
            <Link href={drill({ acct: l.qboAccountId })} className="hover:text-evergreen hover:underline">
              {l.name}
            </Link>
          ) : (
            l.name
          )}
        </td>
        <td className="py-2.5 text-right"><Money cents={l.amountCents} /></td>
        <Cmp cmpOn={cmpOn} prior={cmpAcct.get(l.qboAccountId) ?? 0} cur={l.amountCents} />
      </tr>
    ))}
    <tr className="border-b border-hair">
      <td className="py-2.5 pl-4 font-medium">Total {title}</td>
      <td className="py-2.5 text-right font-medium"><Money cents={total} /></td>
      <Cmp cmpOn={cmpOn} prior={cmpTotal} cur={total} />
    </tr>
  </>
);

export default async function PlPage({
  params,
  searchParams,
}: {
  params: Promise<{ entityId: string }>;
  searchParams: Promise<{ year?: string; start?: string; end?: string; cmp?: string; activity?: string }>;
}) {
  const { entityId } = await params;
  const sp = await searchParams;
  const stats = await ledgerStats(entityId);
  const firstYear = stats.firstDate ? +stats.firstDate.slice(0, 4) : 2022;
  const lastYear = stats.lastDate ? +stats.lastDate.slice(0, 4) : 2026;
  const years: number[] = [];
  for (let y = lastYear; y >= firstYear; y--) years.push(y);

  const period = resolvePlPeriod(sp, new Date());
  const { opts, periodLabel } = period;
  const activityFilter = sp.activity || undefined;
  const activities = await getEntityActivities(entityId);

  // Comparison period (QuickBooks "compare to"). Disabled for all-time.
  const cmp: CompareMode | undefined =
    sp.cmp === "prior-period" || sp.cmp === "prior-year" ? sp.cmp : undefined;
  const cmpRange = cmp ? comparisonRange(opts, cmp) : null;
  const cmpOn = !!cmpRange;

  const plOpts = { ...opts, activity: activityFilter };
  const [pl, channels, subtypeGroups, hasLocations] = await Promise.all([
    profitAndLoss(entityId, plOpts),
    revenueByChannel(entityId, plOpts),
    expenseSubtypeGroups(entityId, plOpts),
    entityHasLocations(entityId),
  ]);
  const [cmpPl, cmpChannels, cmpSubtypeGroups] = cmpRange
    ? await Promise.all([
        profitAndLoss(entityId, { ...cmpRange, activity: activityFilter }),
        revenueByChannel(entityId, { ...cmpRange, activity: activityFilter }),
        expenseSubtypeGroups(entityId, cmpRange),
      ])
    : [null, null, null];

  // Prior-period lookups, keyed exactly like the primary rows so each line can
  // show its comparison figure.
  const cmpChan = new Map(cmpChannels?.channels.map((c) => [c.key, c.cents]));
  const cmpCat = new Map(cmpPl?.operatingExpenseGroups.map((g) => [g.category, g.totalCents]));
  const cmpAcct = new Map<string, number>();
  cmpPl?.revenue.forEach((l) => cmpAcct.set(l.qboAccountId, l.amountCents));
  cmpPl?.operatingExpenses.forEach((l) => cmpAcct.set(l.qboAccountId, l.amountCents));
  cmpPl?.belowLine.forEach((l) => cmpAcct.set(l.qboAccountId, l.amountCents));
  const cmpSub = new Map<string, number>();
  cmpSubtypeGroups?.forEach((subs, cat) => subs.forEach((s) => cmpSub.set(`${cat}::${s.label}`, s.cents)));

  const base = `/ledger/${entityId}/pl`;
  const detailBase = `${base}/detail`;
  const carryRange = rangeParams(period);
  const drill = (target: Record<string, string>): string => {
    const q = new URLSearchParams({ ...target, ...carryRange });
    if (cmp) q.set("cmp", cmp);
    return `${detailBase}?${q.toString()}`;
  };

  const span = cmpOn ? 4 : 2;
  const curColLabel = period.customRange
    ? `${period.customRange.start} → ${period.customRange.end}`
    : period.activeYear === "all"
      ? "All-time"
      : (period.activeYear ?? "Amount");

  return (
    <div className="space-y-5">
      {/* View switch first, before any period/filter controls — per-address
          is an alternate view of this same report (owner 2026-07-30). */}
      {hasLocations && <PlViewToggle entityId={entityId} view="company" />}
      <PlDateControls
        base={base}
        years={years}
        presets={period.presets}
        activePreset={period.activePreset}
        activeYear={period.activeYear}
        customRange={period.customRange}
        cmp={cmp}
      />

      {activities.length > 1 && (
        <ActivityFilter
          base={base}
          activities={activities}
          current={activityFilter}
          searchParams={sp}
        />
      )}

      <h2 className="font-serif text-lg font-medium tracking-tight">
        {periodLabel}
        {cmpRange && (
          <span className="ml-2 text-sm font-normal text-faint">
            vs {cmpRange.shortLabel} ({cmpRange.start} → {cmpRange.end})
          </span>
        )}
      </h2>

      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-hair text-[11px] font-medium uppercase tracking-[0.06em] text-faint">
            <th className="py-2 text-left font-medium">Account</th>
            <th className="py-2 text-right font-medium">{cmpOn ? curColLabel : "Amount"}</th>
            {cmpOn && <th className="py-2 text-right font-medium">{cmpRange!.shortLabel}</th>}
            {cmpOn && <th className="py-2 text-right font-medium">Δ</th>}
          </tr>
        </thead>
        <tbody>
          {channels.hasRealChannel ? (
            <>
              <tr>
                <td colSpan={span} className="pt-6 pb-1 text-[11px] font-medium uppercase tracking-[0.06em] text-faint">
                  Income by channel
                </td>
              </tr>
              {channels.channels.map((c) => {
                const isResidual = c.key.startsWith("acct:");
                const href = isResidual ? drill({ racct: c.label }) : drill({ channel: c.key });
                return (
                  <tr key={c.key} className="border-b border-hair/60">
                    <td className="py-2.5 pl-4">
                      <Link href={href} className="hover:text-evergreen hover:underline">
                        {c.label}
                      </Link>
                    </td>
                    <td className="py-2.5 text-right"><Money cents={c.cents} /></td>
                    <Cmp cmpOn={cmpOn} prior={cmpChan.get(c.key) ?? 0} cur={c.cents} />
                  </tr>
                );
              })}
              <tr className="border-b border-hair">
                <td className="py-2.5 pl-4 font-medium">Total income</td>
                <td className="py-2.5 text-right font-medium"><Money cents={pl.totalRevenueCents} /></td>
                <Cmp cmpOn={cmpOn} prior={cmpPl?.totalRevenueCents ?? 0} cur={pl.totalRevenueCents} />
              </tr>
            </>
          ) : (
            <Group
              title="Income"
              lines={pl.revenue}
              total={pl.totalRevenueCents}
              cmpTotal={cmpPl?.totalRevenueCents ?? 0}
              acctDrill
              span={span}
              drill={drill}
              cmpAcct={cmpAcct}
              cmpOn={cmpOn}
            />
          )}

          {/* Operating expenses grouped into standard categories */}
          <tr>
            <td colSpan={span} className="pt-6 pb-1 text-[11px] font-medium uppercase tracking-[0.06em] text-faint">
              Operating expenses
            </td>
          </tr>
          {pl.operatingExpenseGroups.map((g) => {
            // Prefer a semantic sub-type split (taxes, professional fees — single
            // lumped accounts whose detail lives in the payee/memo). Otherwise
            // fall back to the structural account-level breakdown.
            const subs = subtypeGroups.get(g.category);
            return (
              <Fragment key={g.category}>
                <tr className="border-b border-hair/60">
                  <td className="py-2.5 font-medium">
                    <Link href={drill({ cat: g.category })} className="hover:text-evergreen hover:underline">
                      {g.category}
                    </Link>
                  </td>
                  <td className="py-2.5 text-right font-medium"><Money cents={g.totalCents} /></td>
                  <Cmp cmpOn={cmpOn} prior={cmpCat.get(g.category) ?? 0} cur={g.totalCents} />
                </tr>
                {subs
                  ? subs.map((s) => (
                      <tr key={s.label}>
                        <td className="py-1 pl-8 text-xs text-muted-foreground">
                          <Link href={drill({ cat: g.category, sub: s.label })} className="hover:text-evergreen hover:underline">
                            {s.label}
                          </Link>
                        </td>
                        <td className="py-1 text-right text-xs text-muted-foreground"><Money cents={s.cents} className="text-xs" /></td>
                        <Cmp cmpOn={cmpOn} prior={cmpSub.get(`${g.category}::${s.label}`) ?? 0} cur={s.cents} small />
                      </tr>
                    ))
                  : g.lines.length > 1 &&
                    g.lines.map((l) => (
                      <tr key={l.qboAccountId}>
                        <td className="py-1 pl-8 text-xs text-muted-foreground">
                          <Link href={drill({ acct: l.qboAccountId })} className="hover:text-evergreen hover:underline">
                            {l.name}
                          </Link>
                        </td>
                        <td className="py-1 text-right text-xs text-muted-foreground"><Money cents={l.amountCents} className="text-xs" /></td>
                        <Cmp cmpOn={cmpOn} prior={cmpAcct.get(l.qboAccountId) ?? 0} cur={l.amountCents} small />
                      </tr>
                    ))}
              </Fragment>
            );
          })}
          <tr className="border-b border-ink">
            <td className="py-2.5 font-medium">Total operating expenses</td>
            <td className="py-2.5 text-right font-medium"><Money cents={pl.totalOperatingExpenseCents} /></td>
            <Cmp cmpOn={cmpOn} prior={cmpPl?.totalOperatingExpenseCents ?? 0} cur={pl.totalOperatingExpenseCents} />
          </tr>

          {/* The line: Net Operating Income */}
          <tr className="border-t border-ink">
            <td className="py-3 font-serif text-base font-medium">Net operating income</td>
            <td className="py-3 text-right font-medium"><Money cents={pl.noiCents} tone="auto" /></td>
            <Cmp cmpOn={cmpOn} prior={cmpPl?.noiCents ?? 0} cur={pl.noiCents} />
          </tr>

          {pl.belowLine.length > 0 && (
            <>
              <tr>
                <td colSpan={span} className="pt-6 pb-1 text-[11px] font-medium uppercase tracking-[0.06em] text-faint">
                  Below the line · non-operating, non-cash &amp; one-time
                </td>
              </tr>
              {pl.belowLine.map((l) => (
                <tr key={l.qboAccountId} className="border-b border-hair/60">
                  <td className="py-2.5 pl-4">
                    <Link href={drill({ acct: l.qboAccountId })} className="hover:text-evergreen hover:underline">
                      {l.name}
                    </Link>
                    <span className="ml-2 text-xs text-faint">· {l.bucket}</span>
                  </td>
                  <td className="py-2.5 text-right"><Money cents={l.amountCents} /></td>
                  <Cmp cmpOn={cmpOn} prior={cmpAcct.get(l.qboAccountId) ?? 0} cur={l.amountCents} />
                </tr>
              ))}
              <tr className="border-b border-hair">
                <td className="py-2.5 pl-4 font-medium">Total below the line</td>
                <td className="py-2.5 text-right font-medium"><Money cents={pl.totalBelowLineCents} /></td>
                <Cmp cmpOn={cmpOn} prior={cmpPl?.totalBelowLineCents ?? 0} cur={pl.totalBelowLineCents} />
              </tr>
            </>
          )}

          <tr className="border-t border-ink font-semibold">
            <td className="pt-3">Net income</td>
            <td className="pt-3 text-right"><Money cents={pl.netIncomeCents} tone="auto" /></td>
            {cmpOn && (
              <>
                <td className="pt-3 text-right"><Money cents={cmpPl?.netIncomeCents ?? 0} className="text-muted-foreground" /></td>
                <td className="pt-3 text-right">{pct(pl.netIncomeCents, cmpPl?.netIncomeCents ?? 0)}</td>
              </>
            )}
          </tr>
          {pl.revenue.length === 0 && pl.expenses.length === 0 && (
            <tr>
              <td colSpan={span} className="py-8 text-center text-sm text-muted-foreground">
                No activity in this period.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
