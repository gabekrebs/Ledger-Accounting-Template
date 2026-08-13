"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Money } from "@/components/money";
import { usd } from "@/lib/ledger/format";
import {
  IN_SYNC_TOLERANCE_CENTS,
  type ReconStatusRow,
} from "@/lib/ledger/recon-status-shared";
import { saveManualRecon } from "./actions";
import { useEntityReadOnly } from "../capabilities";

/**
 * One account row of the Reconciliation table. A client component (not a plain
 * server <tr>) only because MANUAL rows carry the inline "check balance" form —
 * the checkpoint entry belongs on this page, not behind a navigation.
 */

/** "1,234.56" / "-58.20" → integer cents; null when invalid. */
function parseCents(s: string): number | null {
  const t = s.replace(/[$,\s]/g, "");
  if (!/^-?\d*\.?\d{0,2}$/.test(t) || t === "" || t === "-") return null;
  const n = Math.round(parseFloat(t) * 100);
  return Number.isFinite(n) ? n : null;
}

/** Today in the browser's timezone — checkpoints are "I just looked" dates. */
function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * The focal point: one pill that says whether the books can be trusted. Judges
 * the UNEXPLAINED residual, not the raw variance — a Plaid account whose whole
 * difference is staged in-flight transactions (bank-pending / awaiting the
 * daily sweep or review) IS reconciled; the book just runs 1–2 days behind the
 * bank by design. A residual that IS out of tolerance but young stays green
 * too ("settling" — the bank's real-time balance outrunning Plaid's
 * transaction extraction; the pipeline self-corrects). Amber is reserved for
 * a residual that has outlived the grace window: a genuine discrepancy.
 */
function StatusPill({ row }: { row: ReconStatusRow }) {
  if (row.varianceCents === null) {
    return (
      <span className="inline-flex items-center rounded-full border border-hair px-2 py-0.5 text-[11px] text-faint">
        {row.source === "plaid" ? "Balance unavailable" : "Not checked"}
      </span>
    );
  }
  const residual = row.residualCents ?? row.varianceCents;
  if (Math.abs(residual) < IN_SYNC_TOLERANCE_CENTS || row.settling) {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:border-emerald-800/40 dark:bg-emerald-900/20 dark:text-emerald-300"
        title={
          row.settling
            ? `${usd(Math.abs(residual))} still settling at the bank — flags only if it persists`
            : undefined
        }
      >
        ✓ In sync
        {row.settling ? (
          <span className="font-normal opacity-75">· settling</span>
        ) : (
          row.inflightCount > 0 && (
            <span className="font-normal opacity-75">
              · {row.inflightCount} in flight
            </span>
          )
        )}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:border-amber-800/40 dark:bg-amber-900/20 dark:text-amber-300">
      Off by {usd(Math.abs(residual))}
      {(row.offSinceDays ?? 0) > 0 && (
        <span className="ml-1 font-normal opacity-75">
          for {row.offSinceDays}d
        </span>
      )}
    </span>
  );
}

export function ReconRow({
  entityId,
  row,
}: {
  entityId: string;
  row: ReconStatusRow;
}) {
  const router = useRouter();
  const readOnly = useEntityReadOnly();
  const [open, setOpen] = useState(false);
  const [asOfDate, setAsOfDate] = useState(todayIso());
  const [balance, setBalance] = useState("");
  const [note, setNote] = useState("");
  const [busy, startTransition] = useTransition();

  const cents = parseCents(balance);
  const canSave = !busy && /^\d{4}-\d{2}-\d{2}$/.test(asOfDate) && cents !== null;

  function save() {
    if (!canSave || cents === null) return;
    startTransition(async () => {
      const res = await saveManualRecon(
        entityId,
        row.qboAccountId,
        asOfDate,
        cents,
        note || undefined
      );
      if (res.ok) {
        toast.success("Balance recorded");
        setOpen(false);
        setBalance("");
        setNote("");
        router.refresh();
      } else {
        toast.error(res.error ?? "Could not save");
      }
    });
  }

  return (
    <>
      <tr className="border-b border-border/60 last:border-0">
        <td className="py-2.5 pl-4">
          <div className="font-medium">{row.name}</div>
          <div className="text-[11px] text-faint">{row.accountType}</div>
        </td>
        <td className="py-2.5">
          {row.source === "plaid" ? (
            <span className="inline-flex items-center rounded-full border border-evergreen/40 bg-evergreen-soft px-2 py-0.5 text-[11px] text-evergreen">
              Plaid
            </span>
          ) : (
            <span className="inline-flex items-center rounded-full border border-hair px-2 py-0.5 text-[11px] text-muted-foreground">
              Manual
            </span>
          )}
        </td>
        <td className="py-2.5 text-right">
          <Money cents={row.bookCents} />
        </td>
        <td className="py-2.5 text-right">
          {row.actualCents === null ? (
            <span className="text-faint">—</span>
          ) : (
            <Money cents={row.actualCents} />
          )}
        </td>
        <td className="py-2.5 text-center">
          <StatusPill row={row} />
        </td>
        <td className="py-2.5 text-right font-mono text-xs tabular-nums text-muted-foreground">
          {row.source === "plaid" ? "Live" : (row.asOfDate ?? "Never")}
        </td>
        <td className="py-2.5 pl-4 pr-4 text-right">
          <span className="inline-flex items-center gap-3 whitespace-nowrap text-xs">
            {row.source === "manual" && !readOnly && (
              <button
                type="button"
                onClick={() => setOpen((o) => !o)}
                className="text-evergreen underline-offset-2 hover:underline"
              >
                {open ? "Close" : "Check balance"}
              </button>
            )}
            {row.hasFullReconcile && (
              <Link
                href={`/ledger/${entityId}/reconcile/${row.qboAccountId}`}
                className="text-faint underline-offset-2 hover:text-muted-foreground hover:underline"
              >
                Full reconcile →
              </Link>
            )}
          </span>
        </td>
      </tr>
      {open && (
        <tr className="border-b border-border/60 bg-muted/20 last:border-0">
          <td colSpan={7} className="px-4 py-3">
            <div className="flex flex-wrap items-end gap-3">
              <label className="block space-y-1">
                <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-faint">
                  As of
                </span>
                <input
                  type="date"
                  value={asOfDate}
                  onChange={(e) => setAsOfDate(e.target.value)}
                  disabled={busy}
                  className={inputCls}
                />
              </label>
              <label className="block space-y-1">
                <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-faint">
                  Actual balance
                </span>
                <input
                  inputMode="decimal"
                  value={balance}
                  onChange={(e) => setBalance(e.target.value)}
                  disabled={busy}
                  placeholder="0.00"
                  className={`${inputCls} w-32 text-right tabular-nums`}
                />
              </label>
              <label className="block flex-1 space-y-1">
                <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-faint">
                  Note (optional)
                </span>
                <input
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  disabled={busy}
                  placeholder="e.g. servicer portal statement"
                  className={inputCls}
                />
              </label>
              <Button size="sm" disabled={!canSave} onClick={save}>
                {busy ? "Saving…" : "Save"}
              </Button>
            </div>
            <p className="mt-1.5 text-[11px] text-faint">
              Enter the balance as the statement shows it — a balance owed is
              positive.
            </p>
          </td>
        </tr>
      )}
    </>
  );
}

const inputCls =
  "h-8 w-full rounded-lg border border-hair bg-transparent px-2 text-sm outline-none focus-visible:border-evergreen focus-visible:ring-2 focus-visible:ring-evergreen/20 disabled:opacity-50";
