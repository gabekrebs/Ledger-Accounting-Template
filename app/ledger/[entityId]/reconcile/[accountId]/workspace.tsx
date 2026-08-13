"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Money } from "@/components/money";
import { Button } from "@/components/ui/button";
import { useEntityReadOnly } from "../../capabilities";
import { cn } from "@/lib/utils";
import type { RecWorkspace } from "@/lib/ledger/reconcile";

/** Net→natural-sign (client twin of lib/ledger/reconcile.ts — keep in sync). */
function toNaturalSign(netCents: number, normalBalance: string): number {
  return normalBalance === "credit" ? -netCents : netCents;
}
import {
  setLinesClearedAction,
  finishReconciliationAction,
  cancelReconciliationAction,
} from "../actions";

/**
 * The open reconciliation's check-off workspace. Checkbox state is optimistic
 * (the server action stamps `reconciliation_id` per toggle) and the header does
 * the QuickBooks math live:
 *
 *   difference = statement balance − (beginning + Σ checked)   → must hit $0.00
 *
 * All figures display in the account's NATURAL sign (credit-card balances read
 * positive), matching how the statement itself reads.
 */
export function RecWorkspaceView({
  entityId,
  initial,
}: {
  entityId: string;
  initial: RecWorkspace;
}) {
  const router = useRouter();
  const readOnly = useEntityReadOnly();
  const { rec, account, lines, truncated } = initial;
  const [checked, setChecked] = useState<Set<string>>(
    () => new Set(lines.filter((l) => l.checked).map((l) => l.lineId))
  );
  const [busy, startTransition] = useTransition();
  const [confirmCancel, setConfirmCancel] = useState(false);

  const math = useMemo(() => {
    let net = rec.beginningBalanceCents;
    for (const l of lines) {
      if (checked.has(l.lineId)) net += l.debitCents - l.creditCents;
    }
    const cleared = toNaturalSign(net, account.normalBalance);
    return { cleared, diff: rec.statementBalanceCents - cleared };
  }, [checked, lines, rec, account.normalBalance]);

  function toggle(lineIds: string[], cleared: boolean) {
    if (readOnly) return; // viewers can watch, never change cleared state
    // Optimistic; reconciled state is re-read on refresh/finish.
    setChecked((prev) => {
      const next = new Set(prev);
      for (const id of lineIds) {
        if (cleared) next.add(id);
        else next.delete(id);
      }
      return next;
    });
    startTransition(async () => {
      const res = await setLinesClearedAction({
        entityId,
        reconciliationId: rec.id,
        lineIds,
        cleared,
      });
      if (!res.ok) {
        toast.error(res.error ?? "Could not save");
        router.refresh();
      }
    });
  }

  function finish() {
    startTransition(async () => {
      const res = await finishReconciliationAction({
        entityId,
        reconciliationId: rec.id,
      });
      if (res.ok) {
        toast.success(`Reconciled through ${rec.statementDate}`);
        router.refresh();
      } else {
        toast.error(res.error ?? "Could not finish");
        router.refresh();
      }
    });
  }

  function cancel() {
    startTransition(async () => {
      const res = await cancelReconciliationAction({
        entityId,
        reconciliationId: rec.id,
      });
      if (res.ok) {
        toast.success("Reconciliation cancelled");
        router.refresh();
      } else {
        toast.error(res.error ?? "Could not cancel");
      }
    });
  }

  const allIds = lines.map((l) => l.lineId);
  const allChecked = allIds.length > 0 && allIds.every((id) => checked.has(id));
  const balanced = math.diff === 0;

  return (
    <div className="space-y-4">
      {/* Statement math header */}
      <div className="flex flex-wrap items-end justify-between gap-3 rounded-xl border border-hair p-4">
        <div className="flex flex-wrap items-end gap-6">
          <Stat label={`Statement · ${rec.statementDate}`}>
            <Money cents={rec.statementBalanceCents} />
          </Stat>
          <Stat label="Beginning (reconciled)">
            <Money
              cents={toNaturalSign(rec.beginningBalanceCents, account.normalBalance)}
            />
          </Stat>
          <Stat label="Cleared">
            <Money cents={math.cleared} />
          </Stat>
          <Stat label="Difference">
            <span className={cn(balanced ? "text-evergreen" : "text-oxblood")}>
              <Money cents={math.diff} />
            </span>
          </Stat>
        </div>
        <div className="flex items-center gap-2">
          {readOnly ? null : confirmCancel ? (
            <Button variant="destructive" size="sm" disabled={busy} onClick={cancel}>
              Confirm cancel
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => setConfirmCancel(true)}
            >
              Cancel
            </Button>
          )}
          {!readOnly && (
            <Button size="sm" disabled={busy || !balanced} onClick={finish}>
              {balanced ? "Finish reconciliation" : "Difference must be $0.00"}
            </Button>
          )}
        </div>
      </div>

      {truncated && (
        <p className="text-xs text-oxblood">
          Showing the first {lines.length.toLocaleString()} candidate lines —
          finish this statement to release the rest into the next one.
        </p>
      )}

      {/* Check-off table */}
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-hair text-[11px] font-medium uppercase tracking-[0.06em] text-faint">
            <th className="w-8 py-2 text-left font-medium">
              <input
                type="checkbox"
                checked={allChecked}
                onChange={(e) =>
                  toggle(
                    e.target.checked
                      ? allIds.filter((id) => !checked.has(id))
                      : allIds.filter((id) => checked.has(id)),
                    e.target.checked
                  )
                }
                aria-label="Check all"
                className="size-3.5 accent-evergreen"
              />
            </th>
            <th className="py-2 text-left font-medium">Date</th>
            <th className="py-2 text-left font-medium">Name / Memo</th>
            <th className="py-2 text-right font-medium">
              {account.normalBalance === "credit" ? "Charge" : "Deposit"}
            </th>
            <th className="py-2 text-right font-medium">
              {account.normalBalance === "credit" ? "Payment" : "Withdrawal"}
            </th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => {
            const isChecked = checked.has(l.lineId);
            // Natural-sign columns: a bank's "deposit" is a debit; a card's
            // "charge" is a credit. Map by normal balance so both read like
            // their statements.
            const inc =
              account.normalBalance === "credit" ? l.creditCents : l.debitCents;
            const dec =
              account.normalBalance === "credit" ? l.debitCents : l.creditCents;
            return (
              <tr
                key={l.lineId}
                onClick={() => toggle([l.lineId], !isChecked)}
                className={cn(
                  "cursor-pointer border-b border-hair/60 transition-colors",
                  isChecked ? "bg-evergreen-soft/40" : "hover:bg-hair/20"
                )}
              >
                <td className="py-2">
                  <input
                    type="checkbox"
                    checked={isChecked}
                    onChange={() => toggle([l.lineId], !isChecked)}
                    onClick={(e) => e.stopPropagation()}
                    aria-label="Cleared"
                    className="size-3.5 accent-evergreen"
                  />
                </td>
                <td className="whitespace-nowrap py-2 font-mono tabular-nums text-muted-foreground">
                  {l.txnDate}
                </td>
                <td className="max-w-md truncate py-2 text-muted-foreground">
                  {l.name ? <span className="text-foreground">{l.name}</span> : null}
                  {l.name && l.memo ? " · " : null}
                  <span className="text-faint">{l.memo}</span>
                </td>
                <td className="py-2 text-right">
                  {inc ? <Money cents={inc} /> : ""}
                </td>
                <td className="py-2 text-right">
                  {dec ? <Money cents={dec} /> : ""}
                </td>
              </tr>
            );
          })}
          {lines.length === 0 && (
            <tr>
              <td colSpan={5} className="py-8 text-center text-muted-foreground">
                No unreconciled lines on or before {rec.statementDate}.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[11px] font-medium uppercase tracking-[0.06em] text-faint">
        {label}
      </div>
      <div className="mt-0.5 text-base font-medium tabular-nums">{children}</div>
    </div>
  );
}
