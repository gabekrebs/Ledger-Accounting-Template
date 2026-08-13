"use client";

import { useState } from "react";
import Link from "next/link";
import { Money } from "@/components/money";
import { cn } from "@/lib/utils";
import {
  minParityTotalCents,
  pinnedParityTotalCents,
  solveParity,
  type ParityOwner,
} from "@/lib/ledger/trueup";

/** "1,234.56" → 123456 (integer cents); null when blank/invalid. */
function parseCents(s: string): number | null {
  const t = s.replace(/[$,\s]/g, "");
  if (t === "") return 0;
  if (!/^\d*\.?\d{0,2}$/.test(t)) return null;
  const n = Math.round(parseFloat(t) * 100);
  return Number.isFinite(n) ? n : null;
}

const inputCls =
  "h-8 w-28 rounded-lg border border-hair bg-transparent px-2 text-right text-sm tabular-nums outline-none focus-visible:border-evergreen focus-visible:ring-2 focus-visible:ring-evergreen/20";

/**
 * One entity's distribution planner. Default view is the minimum true-up (the
 * binding partner takes $0). Typing an amount into ANY partner's Take cell
 * pins that partner; everyone else re-solves so the after-balances land
 * exactly pro-rata. All math lives in lib/ledger/trueup.ts — this component
 * only parses input and renders.
 */
export function Planner({
  entityId,
  entityName,
  owners,
}: {
  entityId: string;
  entityName: string;
  owners: ParityOwner[];
}) {
  const [pin, setPin] = useState<{ name: string; raw: string } | null>(null);

  const pinnedOwner = pin ? owners.find((o) => o.name === pin.name) : undefined;
  const pinnedCents = pin ? parseCents(pin.raw) : null;
  const pinActive = !!pinnedOwner && pinnedCents !== null;

  const totalCents = owners.reduce((s, o) => s + o.actualCents, 0);
  const postTotalCents = pinActive
    ? pinnedParityTotalCents(pinnedOwner, pinnedCents)
    : minParityTotalCents(owners);
  const rows = solveParity(owners, postTotalCents, pinActive ? pin!.name : undefined);
  const distributedCents = totalCents - postTotalCents;
  const anyContribution = rows.some((r) => r.takeCents < 0);

  return (
    <div className="rounded-xl border border-border overflow-hidden">
      <div className="flex items-baseline justify-between border-b border-border bg-muted/40 px-4 py-3">
        <div>
          <Link
            href={`/ledger/${entityId}`}
            className="text-sm font-medium hover:text-evergreen hover:underline"
          >
            {entityName}
          </Link>
          <span className="ml-3 text-xs text-muted-foreground">
            Total capital: <Money cents={totalCents} />
          </span>
        </div>
        {pin && (
          <button
            type="button"
            onClick={() => setPin(null)}
            className="text-xs text-muted-foreground underline-offset-2 hover:text-evergreen hover:underline"
          >
            Reset to minimum
          </button>
        )}
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-[11px] font-medium uppercase tracking-[0.06em] text-faint">
            <th className="py-2 pl-4 text-left">Partner</th>
            <th className="py-2 text-right">Ownership</th>
            <th className="py-2 text-right">Current</th>
            <th className="py-2 text-right">Take</th>
            <th className="py-2 pr-4 text-right">After</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const isPinned = pin?.name === r.name;
            const invalid = isPinned && pinnedCents === null;
            // Non-pinned cells display the solved take; typing in one re-pins.
            const display = isPinned
              ? pin!.raw
              : r.takeCents === 0
                ? ""
                : (r.takeCents / 100).toFixed(2);
            return (
              <tr key={r.name} className="border-b border-border/60 last:border-0">
                <td className="py-2.5 pl-4 font-medium">{r.name}</td>
                <td className="py-2.5 text-right font-mono text-xs tabular-nums text-muted-foreground">
                  {r.pct}%
                </td>
                <td className="py-2.5 text-right">
                  <Money cents={r.actualCents} />
                </td>
                <td className="py-2.5 text-right">
                  <input
                    inputMode="decimal"
                    value={display}
                    placeholder="0.00"
                    onChange={(e) => setPin({ name: r.name, raw: e.target.value })}
                    className={cn(
                      inputCls,
                      invalid && "border-oxblood focus-visible:border-oxblood focus-visible:ring-oxblood/20",
                      !isPinned && r.takeCents < 0 && "text-oxblood"
                    )}
                    aria-label={`Distribution for ${r.name}`}
                  />
                </td>
                <td className="py-2.5 pr-4 text-right text-muted-foreground">
                  <Money cents={r.afterCents} />
                </td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr className="border-t border-border bg-muted/20 text-xs">
            <td colSpan={3} className="py-2 pl-4 text-muted-foreground">
              {distributedCents === 0
                ? "Already at pro-rata parity."
                : pin
                  ? "Pinned scenario — other partners solved to keep everyone exactly pro-rata."
                  : "Minimum true-up — the binding partner takes $0."}
              {anyContribution && (
                <span className="ml-2 text-oxblood">
                  Negative take = that partner must contribute.
                </span>
              )}
            </td>
            <td className="py-2 text-right font-medium">
              <Money cents={distributedCents} />
            </td>
            <td className="py-2 pr-4 text-right text-muted-foreground">
              <Money cents={postTotalCents} />
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
