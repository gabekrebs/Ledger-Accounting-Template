import Link from "next/link";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { type DatePreset } from "@/lib/ledger/date-presets";
import { COMPARE_LABEL, type CompareMode } from "@/lib/ledger/pl-period";

/**
 * The shared period + comparison header for the P&L statement and its
 * drill-down. Pure links + a native GET form, so it works server-rendered with
 * no client JS. `carry` is merged into every href so the drill-down keeps its
 * target (cat / sub / acct / …) while the user changes the date range or the
 * comparison mode.
 */
const COMPARE_MODES: CompareMode[] = ["prior-period", "prior-year"];

function qs(base: string, params: Record<string, string | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") sp.set(k, v);
  const s = sp.toString();
  return s ? `${base}?${s}` : base;
}

export function PlDateControls({
  base,
  carry = {},
  years,
  presets,
  activePreset,
  activeYear,
  customRange,
  cmp,
  showCompare = true,
}: {
  base: string;
  carry?: Record<string, string>;
  years: number[];
  presets: DatePreset[];
  activePreset?: string;
  activeYear: string | null;
  customRange: { start: string; end: string } | null;
  cmp?: CompareMode;
  /** Hide the "Compare to" row for reports with no comparison mode (e.g. GL). */
  showCompare?: boolean;
}) {
  // The params that reproduce the currently-selected range (to preserve it when
  // toggling comparison), and whether comparison even applies (not all-time).
  const rangeParams: Record<string, string> = customRange
    ? { start: customRange.start, end: customRange.end }
    : activeYear && activeYear !== "all"
      ? { year: activeYear }
      : { year: "all" };
  const isAllTime = activeYear === "all";
  const keepCmp = isAllTime ? undefined : cmp;

  const presetHref = (p: DatePreset) =>
    p.key === "all"
      ? qs(base, { ...carry, year: "all" })
      : qs(base, { ...carry, start: p.start, end: p.end, cmp: keepCmp });
  const yearHref = (y: number) => qs(base, { ...carry, year: String(y), cmp: keepCmp });
  const cmpHref = (mode?: CompareMode) => qs(base, { ...carry, ...rangeParams, cmp: mode });

  return (
    <div className="space-y-4">
      {/* Preset ranges */}
      <div className="flex flex-wrap gap-1.5">
        {presets.map((p) => (
          <Chip key={p.key} href={presetHref(p)} active={activePreset === p.key}>
            {p.label}
          </Chip>
        ))}
      </div>

      {/* By year + custom range */}
      <div className="flex flex-wrap items-end justify-between gap-3 border-t border-hair pt-4">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-[11px] font-medium uppercase tracking-[0.06em] text-faint">By year</span>
          {years.map((y) => (
            <Chip key={y} href={yearHref(y)} active={activeYear === String(y)}>
              {y}
            </Chip>
          ))}
        </div>
        <form className="flex items-end gap-2" action={base}>
          {Object.entries({ ...carry, ...(keepCmp ? { cmp: keepCmp } : {}) }).map(([k, v]) => (
            <input key={k} type="hidden" name={k} value={v} />
          ))}
          <label className="text-xs text-muted-foreground">
            From
            <Input type="date" name="start" defaultValue={customRange?.start ?? ""} className="mt-1 w-40" />
          </label>
          <label className="text-xs text-muted-foreground">
            To
            <Input type="date" name="end" defaultValue={customRange?.end ?? ""} className="mt-1 w-40" />
          </label>
          <Button type="submit" variant="outline">Apply</Button>
        </form>
      </div>

      {/* Compare to (QuickBooks-style). Disabled for all-time. */}
      {showCompare && !isAllTime && (
        <div className="flex flex-wrap items-center gap-1.5 border-t border-hair pt-4">
          <span className="mr-1 text-[11px] font-medium uppercase tracking-[0.06em] text-faint">Compare to</span>
          <Chip href={cmpHref(undefined)} active={!cmp}>
            None
          </Chip>
          {COMPARE_MODES.map((m) => (
            <Chip key={m} href={cmpHref(m)} active={cmp === m}>
              {COMPARE_LABEL[m]}
            </Chip>
          ))}
        </div>
      )}
    </div>
  );
}

export function Chip({
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
