import { Fragment } from "react";
import Link from "next/link";
import { balanceSheet, ledgerStats, type BsNode, type BalanceSheet } from "@/lib/ledger/reports";
import { bsDatePresets } from "@/lib/ledger/date-presets";
import { bsComparisonDate, COMPARE_LABEL, type CompareMode } from "@/lib/ledger/pl-period";
import { Money } from "@/components/money";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export const dynamic = "force-dynamic";

type Row = {
  key: string;
  depth: number;
  label: string;
  amountCents: number | null;
  bold?: boolean;
  accountId?: string;
};

/** Flatten the account tree into renderable rows with subtotals. `baseDepth`
 *  indents the whole tree (accounts sit one level under a subsection header). */
function flatten(nodes: BsNode[], baseDepth = 0): Row[] {
  const out: Row[] = [];
  const walk = (n: BsNode) => {
    const d = n.depth + baseDepth;
    if (n.children.length) {
      out.push({ key: `h-${n.qboAccountId}`, depth: d, label: n.name, amountCents: null, bold: true });
      n.children.forEach(walk);
      if (n.ownCents !== 0) {
        out.push({ key: `o-${n.qboAccountId}`, depth: d + 1, label: n.name, amountCents: n.ownCents, accountId: n.qboAccountId });
      }
      out.push({ key: `t-${n.qboAccountId}`, depth: d, label: `Total ${n.name}`, amountCents: n.rolledCents, bold: true });
    } else if (n.ownCents !== 0) {
      // A balance sheet never lists $0 lines — skip empty leaves (inactive strays,
      // swept transitional accounts, not-yet-allocated per-property basis buckets).
      out.push({ key: `l-${n.qboAccountId}`, depth: d, label: n.name, amountCents: n.ownCents, accountId: n.qboAccountId });
    }
  };
  nodes.forEach(walk);
  return out;
}

const pctChange = (cur: number, prior: number): string => {
  if (!prior) return "—";
  const v = ((cur - prior) / Math.abs(prior)) * 100;
  return `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(1)}%`;
};

export default async function BsPage({
  params,
  searchParams,
}: {
  params: Promise<{ entityId: string }>;
  searchParams: Promise<{ asOf?: string; cmp?: string }>;
}) {
  const { entityId } = await params;
  const { asOf, cmp: cmpParam } = await searchParams;
  const stats = await ledgerStats(entityId);
  const date = asOf ?? stats.lastDate ?? "2026-12-31";

  const firstYear = stats.firstDate ? +stats.firstDate.slice(0, 4) : 2022;
  const lastYear = stats.lastDate ? +stats.lastDate.slice(0, 4) : 2026;
  const years: number[] = [];
  for (let y = lastYear; y >= firstYear; y--) years.push(y);
  const presets = bsDatePresets(new Date(), stats.lastDate ?? undefined);

  const cmp: CompareMode | undefined =
    cmpParam === "prior-period" || cmpParam === "prior-year" ? cmpParam : undefined;
  const cmpDate = cmp ? bsComparisonDate(date, cmp) : null;

  const [bs, cmpBs] = await Promise.all([
    balanceSheet(entityId, date),
    cmpDate ? balanceSheet(entityId, cmpDate.date) : Promise.resolve<BalanceSheet | null>(null),
  ]);
  const cmpOn = !!cmpBs;
  const span = cmpOn ? 4 : 2;

  // Comparison balances keyed by the SAME row keys flatten() emits, so each line
  // can show its prior figure. The trees share a chart of accounts, so keys align.
  // (A line that is exactly $0 as-of the primary date is pruned from the primary
  // tree and so won't render even if it had a prior balance — the prior section
  // TOTALS below still come from the full comparison statement and stay correct.)
  const cmpMap = new Map<string, number>();
  if (cmpBs) {
    const add = (rows: Row[]) => rows.forEach((r) => r.amountCents !== null && cmpMap.set(r.key, r.amountCents));
    cmpBs.assetSubsections.forEach((sub) => add(flatten(sub.nodes, 1)));
    add(flatten(cmpBs.liabilities));
    add(flatten(cmpBs.equity));
  }
  const cmpSubTotal = (label: string) =>
    cmpBs?.assetSubsections.find((s) => s.label === label)?.totalCents ?? 0;

  const base = `/ledger/${entityId}/bs`;
  const qs = (p: Record<string, string | undefined>) => {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(p)) if (v) sp.set(k, v);
    const s = sp.toString();
    return s ? `${base}?${s}` : base;
  };

  return (
    <div className="space-y-5">
      {/* As-of presets */}
      <div className="flex flex-wrap gap-1.5">
        {presets.map((p) => (
          <Chip key={p.key} href={qs({ asOf: p.end, cmp })} active={p.end === date}>
            {p.label}
          </Chip>
        ))}
      </div>

      {/* Year-ends + custom as-of + balanced badge */}
      <div className="flex flex-wrap items-end justify-between gap-3 border-t border-hair pt-4">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-[11px] font-medium uppercase tracking-[0.06em] text-faint">Year-end</span>
          {years.map((y) => (
            <Chip key={y} href={qs({ asOf: `${y}-12-31`, cmp })} active={date === `${y}-12-31`}>
              {y}
            </Chip>
          ))}
        </div>
        <div className="flex items-end gap-3">
          <form className="flex items-end gap-2" action={base}>
            {cmp && <input type="hidden" name="cmp" value={cmp} />}
            <label className="text-sm text-muted-foreground">
              As of
              <Input type="date" name="asOf" defaultValue={date} className="mt-1 w-44" />
            </label>
            <Button type="submit" variant="outline">Apply</Button>
          </form>
          {bs.balanced ? (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-evergreen-soft px-2.5 py-1 text-xs font-medium text-evergreen">
              ● Balanced
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-oxblood/10 px-2.5 py-1 text-xs font-medium text-oxblood">
              ● Out of balance
            </span>
          )}
        </div>
      </div>

      {/* Compare to (as-of snapshots) */}
      <div className="flex flex-wrap items-center gap-1.5 border-t border-hair pt-4">
        <span className="mr-1 text-[11px] font-medium uppercase tracking-[0.06em] text-faint">Compare to</span>
        <Chip href={qs({ asOf: date })} active={!cmp}>None</Chip>
        {(["prior-period", "prior-year"] as CompareMode[]).map((m) => (
          <Chip key={m} href={qs({ asOf: date, cmp: m })} active={cmp === m}>
            {COMPARE_LABEL[m]}
          </Chip>
        ))}
      </div>

      <h2 className="font-serif text-lg font-medium tracking-tight">
        As of {date}
        {cmpDate && (
          <span className="ml-2 text-sm font-normal text-faint">
            vs {cmpDate.shortLabel} ({cmpDate.date})
          </span>
        )}
      </h2>

      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-hair text-[11px] font-medium uppercase tracking-[0.06em] text-faint">
            <th className="py-2 text-left font-medium">Account</th>
            <th className="py-2 text-right font-medium">{cmpOn ? date : "Balance"}</th>
            {cmpOn && <th className="py-2 text-right font-medium">{cmpDate!.shortLabel}</th>}
            {cmpOn && <th className="py-2 text-right font-medium">Δ</th>}
          </tr>
        </thead>
        <tbody>
          <SectionRow label="Assets" span={span} />
          {bs.assetSubsections.map((sub) => (
            <Fragment key={sub.label}>
              <SubsectionRow label={sub.label} span={span} />
              <Rows entityId={entityId} rows={flatten(sub.nodes, 1)} cmpOn={cmpOn} cmpMap={cmpMap} />
              <TotalRow label={`Total ${sub.label.toLowerCase()}`} cents={sub.totalCents} cmp={cmpSubTotal(sub.label)} cmpOn={cmpOn} />
            </Fragment>
          ))}
          <TotalRow label="Total Assets" cents={bs.totalAssetsCents} cmp={cmpBs?.totalAssetsCents ?? 0} cmpOn={cmpOn} strong />

          <SectionRow label="Liabilities" span={span} spaced />
          <Rows entityId={entityId} rows={flatten(bs.liabilities)} cmpOn={cmpOn} cmpMap={cmpMap} />
          <TotalRow label="Total Liabilities" cents={bs.totalLiabilitiesCents} cmp={cmpBs?.totalLiabilitiesCents ?? 0} cmpOn={cmpOn} />

          <SectionRow label="Equity" span={span} spaced />
          <Rows entityId={entityId} rows={flatten(bs.equity)} cmpOn={cmpOn} cmpMap={cmpMap} />
          <tr className="border-b border-hair/50">
            <td className="py-2 pl-[18px] italic text-muted-foreground">Net income (unclosed)</td>
            <td className="py-2 text-right text-muted-foreground"><Money cents={bs.netIncomeToDateCents} tone="auto" /></td>
            {cmpOn && (
              <>
                <td className="py-2 text-right text-muted-foreground"><Money cents={cmpBs?.netIncomeToDateCents ?? 0} tone="auto" /></td>
                <td className="py-2 text-right text-xs text-muted-foreground font-mono tabular-nums">{pctChange(bs.netIncomeToDateCents, cmpBs?.netIncomeToDateCents ?? 0)}</td>
              </>
            )}
          </tr>
          <TotalRow label="Total Equity" cents={bs.totalEquityCents} cmp={cmpBs?.totalEquityCents ?? 0} cmpOn={cmpOn} />

          <tr className="border-t border-ink font-semibold">
            <td className="pt-3">Total Liabilities + Equity</td>
            <td className="pt-3 text-right"><Money cents={bs.totalLiabilitiesCents + bs.totalEquityCents} tone="auto" /></td>
            {cmpOn && (
              <>
                <td className="pt-3 text-right"><Money cents={(cmpBs?.totalLiabilitiesCents ?? 0) + (cmpBs?.totalEquityCents ?? 0)} tone="auto" /></td>
                <td className="pt-3 text-right text-xs text-muted-foreground font-mono tabular-nums">
                  {pctChange(bs.totalLiabilitiesCents + bs.totalEquityCents, (cmpBs?.totalLiabilitiesCents ?? 0) + (cmpBs?.totalEquityCents ?? 0))}
                </td>
              </>
            )}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function Rows({
  entityId,
  rows,
  cmpOn,
  cmpMap,
}: {
  entityId: string;
  rows: Row[];
  cmpOn: boolean;
  cmpMap: Map<string, number>;
}) {
  return (
    <>
      {rows.map((r) => {
        const prior = cmpMap.get(r.key) ?? 0;
        return (
          <tr key={r.key} className="border-b border-hair/50">
            <td className={`py-2 ${r.bold ? "font-medium" : ""}`} style={{ paddingLeft: r.depth * 18 }}>
              {r.accountId ? (
                <Link href={`/ledger/${entityId}/gl/${r.accountId}`} className="hover:text-evergreen hover:underline">
                  {r.label}
                </Link>
              ) : (
                r.label
              )}
            </td>
            <td className={`py-2 text-right ${r.bold ? "font-medium" : ""}`}>
              {r.amountCents === null ? "" : <Money cents={r.amountCents} tone="auto" />}
            </td>
            {cmpOn && (
              <>
                <td className={`py-2 text-right ${r.bold ? "font-medium" : ""} text-muted-foreground`}>
                  {r.amountCents === null ? "" : <Money cents={prior} tone="auto" />}
                </td>
                <td className="py-2 text-right text-xs text-muted-foreground font-mono tabular-nums">
                  {r.amountCents === null ? "" : pctChange(r.amountCents, prior)}
                </td>
              </>
            )}
          </tr>
        );
      })}
    </>
  );
}

function SectionRow({ label, span, spaced }: { label: string; span: number; spaced?: boolean }) {
  return (
    <tr>
      <td colSpan={span} className={`${spaced ? "pt-6" : "pt-3"} pb-1 text-[11px] font-medium uppercase tracking-[0.06em] text-faint`}>
        {label}
      </td>
    </tr>
  );
}

function SubsectionRow({ label, span }: { label: string; span: number }) {
  return (
    <tr>
      <td colSpan={span} className="pt-3 pb-1 text-xs font-medium text-muted-foreground">
        {label}
      </td>
    </tr>
  );
}

function TotalRow({
  label,
  cents,
  cmp,
  cmpOn,
  strong,
}: {
  label: string;
  cents: number;
  cmp: number;
  cmpOn: boolean;
  strong?: boolean;
}) {
  return (
    <tr className={`border-t ${strong ? "border-ink" : "border-hair"}`}>
      <td className={`py-2 ${strong ? "font-semibold" : "font-medium"}`}>{label}</td>
      <td className={`py-2 text-right ${strong ? "font-semibold" : "font-medium"}`}>
        <Money cents={cents} tone="auto" />
      </td>
      {cmpOn && (
        <>
          <td className={`py-2 text-right text-muted-foreground ${strong ? "font-semibold" : "font-medium"}`}>
            <Money cents={cmp} tone="auto" />
          </td>
          <td className="py-2 text-right text-xs text-muted-foreground font-mono tabular-nums">{pctChange(cents, cmp)}</td>
        </>
      )}
    </tr>
  );
}

function Chip({ href, active, children }: { href: string; active?: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className={`rounded-full px-3 py-1 text-sm transition-colors ${
        active
          ? "bg-evergreen text-white"
          : "bg-secondary text-muted-foreground hover:bg-evergreen-soft hover:text-evergreen"
      }`}
    >
      {children}
    </Link>
  );
}
