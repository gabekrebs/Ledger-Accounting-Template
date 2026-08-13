import Link from "next/link";
import { profitAndLossByLocation, ledgerStats } from "@/lib/ledger/reports";
import { Money } from "@/components/money";
import { PlViewToggle } from "../pl-view-toggle";

export const dynamic = "force-dynamic";

const ADDR_LABEL = (loc: string) => `${loc} NE`;

type PlByLocation = Awaited<ReturnType<typeof profitAndLossByLocation>>;

const cellOf = (
  row: PlByLocation["rows"][number],
  key: string
): number =>
  key === "total"
    ? row.totalCents
    : key === "pooled"
      ? row.pooledCents
      : row.perLocation[key] || 0;

const SectionRows = ({
  title,
  rows,
  totals,
  cols,
  entityId,
}: {
  title: string;
  rows: PlByLocation["rows"];
  totals: Record<string, number>;
  cols: { key: string; label: string }[];
  entityId: string;
}) => (
  <>
    <tr>
      <td
        colSpan={cols.length + 1}
        className="pt-6 pb-1 text-[11px] font-medium uppercase tracking-[0.06em] text-faint"
      >
        {title}
      </td>
    </tr>
    {rows.map((r) => (
      <tr key={r.qboAccountId} className="border-b border-hair/60">
        <td className="py-2.5 pl-4">
          <Link
            href={`/ledger/${entityId}/gl/${r.qboAccountId}`}
            className="hover:text-evergreen hover:underline"
          >
            {r.name}
          </Link>
        </td>
        {cols.map((c) => (
          <td key={c.key} className="py-2.5 text-right tabular-nums">
            {cellOf(r, c.key) === 0 ? (
              <span className="text-faint">—</span>
            ) : (
              <Money cents={cellOf(r, c.key)} />
            )}
          </td>
        ))}
      </tr>
    ))}
    <tr className="border-b border-hair">
      <td className="py-2.5 pl-4 font-medium">Total {title.toLowerCase()}</td>
      {cols.map((c) => (
        <td key={c.key} className="py-2.5 text-right font-medium tabular-nums">
          <Money cents={totals[c.key] || 0} />
        </td>
      ))}
    </tr>
  </>
);

export default async function ByAddressPage({
  params,
  searchParams,
}: {
  params: Promise<{ entityId: string }>;
  searchParams: Promise<{ year?: string }>;
}) {
  const { entityId } = await params;
  const { year } = await searchParams;
  const stats = await ledgerStats(entityId);
  const firstYear = stats.firstDate ? +stats.firstDate.slice(0, 4) : 2022;
  const lastYear = stats.lastDate ? +stats.lastDate.slice(0, 4) : 2026;
  const years: number[] = [];
  for (let y = lastYear; y >= firstYear; y--) years.push(y);

  const activeYear = year ?? "all";
  const opts =
    activeYear !== "all"
      ? { start: `${activeYear}-01-01`, end: `${activeYear}-12-31` }
      : {};
  const pl = await profitAndLossByLocation(entityId, opts);
  const base = `/ledger/${entityId}/by-address`;

  // visible columns: addresses + (pooled if any) + total
  const cols: { key: string; label: string }[] = [
    ...pl.locations.map((l) => ({ key: l, label: ADDR_LABEL(l) })),
    ...(pl.hasPooled ? [{ key: "pooled", label: "Pooled (LLC)" }] : []),
    { key: "total", label: "Total" },
  ];
  const revRows = pl.rows.filter((r) => r.classification === "revenue");
  const expRows = pl.rows.filter((r) => r.classification === "expense");

  return (
    <div className="space-y-5">
      <PlViewToggle entityId={entityId} view="address" />
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-[11px] font-medium uppercase tracking-[0.06em] text-faint">
          Period
        </span>
        <Chip href={`${base}?year=all`} active={activeYear === "all"}>
          All-time
        </Chip>
        {years.map((y) => (
          <Chip key={y} href={`${base}?year=${y}`} active={activeYear === String(y)}>
            {y}
          </Chip>
        ))}
      </div>

      <div>
        <h2 className="font-serif text-lg font-medium tracking-tight">
          Per-address profit &amp; loss
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Directly-attributable income &amp; expense by unit. Shared costs the
          source data can&apos;t attribute to one unit (building-wide repairs,
          supplies) sit in <span className="font-medium">Pooled (LLC)</span>.
        </p>
      </div>

      {pl.rows.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          No per-address activity in this period.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b border-hair text-[11px] font-medium uppercase tracking-[0.06em] text-faint">
                <th className="py-2 text-left font-medium">Account</th>
                {cols.map((c) => (
                  <th key={c.key} className="py-2 text-right font-medium">
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <SectionRows title="Income" rows={revRows} totals={pl.revenueTotals} cols={cols} entityId={entityId} />
              <SectionRows title="Expenses" rows={expRows} totals={pl.expenseTotals} cols={cols} entityId={entityId} />
              <tr className="border-t border-ink font-semibold">
                <td className="pt-3">Net</td>
                {cols.map((c) => (
                  <td key={c.key} className="pt-3 text-right tabular-nums">
                    <Money cents={pl.netTotals[c.key] || 0} tone="auto" />
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Chip({
  href,
  active,
  children,
}: {
  href: string;
  active?: boolean;
  children: React.ReactNode;
}) {
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
