"use client";

import { useState } from "react";

/**
 * CPA trial-balance download — year picker + XLSX/CSV links. Lives on the
 * Accounts tab (which is already the live trial-balance view); this is the
 * year-scoped, workpaper-formatted export the accountant starts from.
 * Plain <a> downloads — the route streams the file with content-disposition.
 */
export function TbExport({
  entityId,
  years,
}: {
  entityId: string;
  years: number[];
}) {
  // Default to the last COMPLETE year — the one the CPA is working on.
  const currentYear = new Date().getFullYear();
  const defaultYear = years.find((y) => y < currentYear) ?? years[0];
  const [year, setYear] = useState(defaultYear);
  if (!years.length) return null;

  const href = (format: "xlsx" | "csv") =>
    `/ledger/${entityId}/accounts/trial-balance?year=${year}&format=${format}`;

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-hair px-4 py-3">
      <div className="mr-1">
        <div className="text-sm font-medium">CPA trial balance</div>
        <div className="text-[11px] text-faint">
          Year-end workpaper — signed balances, prior-years profit, activity
          columns where the entity has more than one.
        </div>
      </div>
      <select
        value={year}
        onChange={(e) => setYear(Number(e.target.value))}
        className="ml-auto h-8 rounded-lg border border-hair bg-transparent px-2 text-sm outline-none focus-visible:border-evergreen"
        aria-label="Trial balance year"
      >
        {years.map((y) => (
          <option key={y} value={y}>
            {y}
          </option>
        ))}
      </select>
      <a
        href={href("xlsx")}
        className="inline-flex h-8 items-center rounded-lg bg-evergreen px-3 text-sm font-medium text-white hover:opacity-90"
      >
        Download XLSX
      </a>
      <a
        href={href("csv")}
        className="inline-flex h-8 items-center rounded-lg border border-hair px-3 text-sm text-muted-foreground hover:border-evergreen/40 hover:text-evergreen"
      >
        CSV
      </a>
    </div>
  );
}
