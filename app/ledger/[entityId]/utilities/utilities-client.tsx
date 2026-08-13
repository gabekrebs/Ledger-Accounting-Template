"use client";

import { useState } from "react";
import { Money } from "@/components/money";
import {
  calendarYearRows,
  rollingRows,
  utilityAverage,
  utilityMonthLabel,
  type UtilityGroupReport,
} from "@/lib/ledger/utilities-shared";

/**
 * The Utilities tab body. All figures are payment-month buckets from Plaid;
 * averages use completed months only (the running month shows, annotated,
 * but never dilutes an average). Optional categories — garbage today — hide
 * behind one toggle, and every displayed total/average recomputes from the
 * same per-category cents so the columns always reconcile.
 */
export function UtilitiesClient({ groups }: { groups: UtilityGroupReport[] }) {
  const [includeOptional, setIncludeOptional] = useState(true);

  const optionalNames = [
    ...new Set(
      groups.flatMap((g) => g.categories.filter((c) => c.optional).map((c) => c.name))
    ),
  ];
  // laMonth = the in-progress month the report ends on (same for all groups).
  const laMonth = groups[0].months[groups[0].months.length - 1].month;
  const laYear = laMonth.slice(0, 4);

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-serif text-lg font-medium tracking-tight">
            Owner-covered utilities
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Straight from the bank feed, bucketed by payment month — quarterly
            bills (water) land lumpy and average out over time. Averages use
            completed months only.
          </p>
        </div>
        {optionalNames.length > 0 && (
          <label className="flex cursor-pointer select-none items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={includeOptional}
              onChange={(e) => setIncludeOptional(e.target.checked)}
              className="h-4 w-4 accent-[var(--evergreen,#1f4d3a)]"
            />
            Include {optionalNames.join(" & ").toLowerCase()}
          </label>
        )}
      </div>

      {groups.map((g) => (
        <GroupSection
          key={g.id}
          group={g}
          includeOptional={includeOptional}
          laMonth={laMonth}
          laYear={laYear}
        />
      ))}
    </div>
  );
}

function GroupSection({
  group,
  includeOptional,
  laMonth,
  laYear,
}: {
  group: UtilityGroupReport;
  includeOptional: boolean;
  laMonth: string;
  laYear: string;
}) {
  const cats = group.categories.filter((c) => includeOptional || !c.optional);
  const calRows = calendarYearRows(group.months, laMonth);
  const rolRows = rollingRows(group.months);
  const cal = utilityAverage(calRows, group.categories, includeOptional);
  const rol = utilityAverage(rolRows, group.categories, includeOptional);
  // Until the tracker crosses a year boundary the two windows are the same
  // months — say so instead of printing an identical-looking second row.
  const windowsIdentical =
    calRows.length === rolRows.length &&
    calRows.every((r, i) => r.month === rolRows[i].month);

  const rowTotal = (r: (typeof group.months)[number]) =>
    cats.reduce((s, c) => s + (r.cells[c.name] ?? 0), 0);

  return (
    <section>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-serif text-lg">{group.name}</h3>
        <span className="text-xs text-faint">
          tracked since {utilityMonthLabel(group.trackingStart)}
        </span>
      </div>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full min-w-[520px] text-sm">
          <thead>
            <tr className="border-b border-hair text-[11px] font-medium uppercase tracking-[0.06em] text-faint">
              <th className="py-2 text-left font-medium">Month</th>
              {cats.map((c) => (
                <th key={c.name} className="py-2 text-right font-medium">
                  {c.name}
                </th>
              ))}
              <th className="py-2 text-right font-medium">Total</th>
            </tr>
          </thead>
          <tbody>
            {group.months.map((r) => (
              <tr
                key={r.month}
                className={`border-b border-hair/60 ${r.inProgress ? "text-muted-foreground" : ""}`}
              >
                <td className="py-2">
                  {utilityMonthLabel(r.month)}
                  {r.inProgress && (
                    <span className="ml-1.5 text-[11px] text-faint">in progress</span>
                  )}
                </td>
                {cats.map((c) => (
                  <td key={c.name} className="py-2 text-right tabular-nums">
                    {(r.cells[c.name] ?? 0) === 0 ? (
                      <span className="text-faint">—</span>
                    ) : (
                      <Money cents={r.cells[c.name]} />
                    )}
                  </td>
                ))}
                <td className="py-2 text-right font-medium tabular-nums">
                  <Money cents={rowTotal(r)} />
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <AvgRow
              label={`Avg / mo · ${laYear} (${cal.monthCount} mo)`}
              cats={cats}
              avg={cal}
            />
            {!windowsIdentical && (
              <AvgRow
                label={`Avg / mo · rolling 12 (${rol.monthCount} mo)`}
                cats={cats}
                avg={rol}
              />
            )}
          </tfoot>
        </table>
      </div>
      {windowsIdentical && (
        <p className="mt-1.5 text-xs text-faint">
          Rolling-365 average is the same window until a full year of data exists.
        </p>
      )}
    </section>
  );
}

function AvgRow({
  label,
  cats,
  avg,
}: {
  label: string;
  cats: { name: string }[];
  avg: { perCategory: Record<string, number>; totalCents: number };
}) {
  return (
    <tr className="border-t border-ink font-medium">
      <td className="pt-3 pb-1">{label}</td>
      {cats.map((c) => (
        <td key={c.name} className="pt-3 pb-1 text-right tabular-nums">
          <Money cents={avg.perCategory[c.name] ?? 0} />
        </td>
      ))}
      <td className="pt-3 pb-1 text-right tabular-nums">
        <Money cents={avg.totalCents} />
      </td>
    </tr>
  );
}
