"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import type { ReconciliationSummary } from "@/lib/ledger/reconcile";
import {
  startReconciliationAction,
  undoLastReconciliationAction,
} from "../actions";
import { useEntityReadOnly } from "../../capabilities";

/** "1,234.56" / "-58.20" → integer cents; null when invalid. */
function parseCents(s: string): number | null {
  const t = s.replace(/[$,\s]/g, "");
  if (!/^-?\d*\.?\d{0,2}$/.test(t) || t === "" || t === "-") return null;
  const n = Math.round(parseFloat(t) * 100);
  return Number.isFinite(n) ? n : null;
}

export function StartReconciliation({
  entityId,
  accountId,
  normalBalance,
  lastStatement,
}: {
  entityId: string;
  accountId: string;
  normalBalance: string;
  lastStatement: ReconciliationSummary | null;
}) {
  const router = useRouter();
  const readOnly = useEntityReadOnly();
  const [statementDate, setStatementDate] = useState("");
  const [balance, setBalance] = useState("");
  const [busy, startTransition] = useTransition();

  const cents = parseCents(balance);
  const canStart = !busy && /^\d{4}-\d{2}-\d{2}$/.test(statementDate) && cents !== null;

  function start() {
    if (!canStart || cents === null) return;
    startTransition(async () => {
      const res = await startReconciliationAction({
        entityId,
        accountId,
        statementDate,
        statementBalanceCents: cents,
      });
      if (res.ok) {
        router.refresh();
      } else {
        toast.error(res.error ?? "Could not start");
      }
    });
  }

  if (readOnly) return null; // viewers can't run a statement tie
  return (
    <div className="max-w-md space-y-4 rounded-xl border border-hair p-5">
      <div>
        <h3 className="font-serif text-base font-medium tracking-tight">
          Start a reconciliation
        </h3>
        <p className="mt-0.5 text-xs text-muted-foreground">
          From the bank statement, not the ledger:{" "}
          {normalBalance === "credit"
            ? "enter the statement balance as the card shows it (amount owed is positive)."
            : "enter the statement's ending balance."}
          {lastStatement &&
            ` Last reconciled through ${lastStatement.statementDate}.`}
        </p>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <label className="block space-y-1">
          <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-faint">
            Statement end date
          </span>
          <input
            type="date"
            value={statementDate}
            onChange={(e) => setStatementDate(e.target.value)}
            disabled={busy}
            className={inputCls}
          />
        </label>
        <label className="block space-y-1">
          <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-faint">
            Ending balance
          </span>
          <input
            inputMode="decimal"
            value={balance}
            onChange={(e) => setBalance(e.target.value)}
            disabled={busy}
            placeholder="0.00"
            className={`${inputCls} text-right tabular-nums`}
          />
        </label>
      </div>
      <div className="flex justify-end">
        <Button size="sm" disabled={!canStart} onClick={start}>
          {busy ? "Starting…" : "Start reconciling"}
        </Button>
      </div>
    </div>
  );
}

export function UndoLastReconciliation({
  entityId,
  accountId,
}: {
  entityId: string;
  accountId: string;
}) {
  const router = useRouter();
  const readOnly = useEntityReadOnly();
  const [confirm, setConfirm] = useState(false);
  const [busy, startTransition] = useTransition();

  function undo() {
    startTransition(async () => {
      const res = await undoLastReconciliationAction({ entityId, accountId });
      if (res.ok) {
        toast.success("Reconciliation undone — its lines are released");
        router.refresh();
      } else {
        toast.error(res.error ?? "Could not undo");
      }
    });
  }

  if (readOnly) return null; // viewers can't undo reconciliations
  return confirm ? (
    <Button variant="destructive" size="sm" disabled={busy} onClick={undo}>
      Confirm undo
    </Button>
  ) : (
    <button
      type="button"
      onClick={() => setConfirm(true)}
      className="text-xs text-faint underline-offset-2 hover:text-oxblood hover:underline"
    >
      Undo
    </button>
  );
}

const inputCls =
  "h-8 w-full rounded-lg border border-hair bg-transparent px-2 text-sm outline-none focus-visible:border-evergreen focus-visible:ring-2 focus-visible:ring-evergreen/20 disabled:opacity-50";
