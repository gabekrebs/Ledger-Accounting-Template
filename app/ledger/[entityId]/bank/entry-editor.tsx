"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { postEntryTransaction } from "./actions";
import { type PostableAccount } from "./review-row";
import { AccountCombobox } from "@/components/ui/account-combobox";
import { Money } from "@/components/money";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Side = "debit" | "credit";
type DraftLine = {
  accountId: string;
  amount: string; // dollars, as typed
  side: Side;
  memo: string;
};

const toCents = (s: string): number => {
  const n = Number(String(s).replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};

const blank = (side: Side = "debit"): DraftLine => ({
  accountId: "",
  amount: "",
  side,
  memo: "",
});

/**
 * Inline multi-line journal-entry editor for a single bank transaction — the
 * split path. The bank line is fixed (the deposit/withdrawal on its natural
 * side); the operator adds category lines, each an explicit debit OR credit, and
 * Post is enabled only when the whole entry balances to zero.
 */
export function EntryEditor({
  entityId,
  txnId,
  amountCents,
  label,
  payee,
  accounts,
  onClose,
}: {
  entityId: string;
  txnId: string;
  amountCents: number; // Plaid sign: negative = inflow/deposit
  label: string;
  /** Vendor/payee the entry is booked under (edited in the review row). */
  payee?: string;
  accounts: PostableAccount[];
  onClose: () => void;
}) {
  const inflow = amountCents < 0; // a deposit
  const bankAmount = Math.abs(amountCents);
  // The category side opposite the bank is the common case for a plain split, so
  // new lines default there (deposit → credit income; spend → debit expense).
  const defaultSide: Side = inflow ? "credit" : "debit";

  const [lines, setLines] = useState<DraftLine[]>([blank(defaultSide)]);
  const [busy, startPost] = useTransition();
  const router = useRouter();

  const catDr = lines.reduce(
    (s, l) => s + (l.side === "debit" ? toCents(l.amount) : 0),
    0
  );
  const catCr = lines.reduce(
    (s, l) => s + (l.side === "credit" ? toCents(l.amount) : 0),
    0
  );
  const bankDr = inflow ? bankAmount : 0;
  const bankCr = inflow ? 0 : bankAmount;
  const diff = bankDr + catDr - (bankCr + catCr); // 0 when balanced
  const filled = lines.filter((l) => l.accountId && toCents(l.amount) > 0);
  const canPost = diff === 0 && filled.length > 0 && !busy;

  function update(i: number, patch: Partial<DraftLine>) {
    setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  }
  function addLine() {
    setLines((ls) => [...ls, blank(defaultSide)]);
  }
  function removeLine(i: number) {
    setLines((ls) => (ls.length > 1 ? ls.filter((_, j) => j !== i) : ls));
  }

  function post() {
    if (!canPost) return;
    startPost(async () => {
      const res = await postEntryTransaction({
        entityId,
        txnId,
        payee: payee?.trim() || null,
        lines: filled.map((l) => ({
          accountId: l.accountId,
          debitCents: l.side === "debit" ? toCents(l.amount) : 0,
          creditCents: l.side === "credit" ? toCents(l.amount) : 0,
          memo: l.memo.trim() || null,
        })),
      });
      if (res.ok) {
        toast.success("Posted to ledger");
        router.refresh();
      } else {
        toast.error(res.error ?? "Could not post");
      }
    });
  }

  return (
    <tr className="border-b border-hair/60 bg-paper/40">
      <td colSpan={5} className="px-3 py-4">
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-faint">
              Split
            </span>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={onClose}
                disabled={busy}
              >
                Close
              </Button>
            </div>
          </div>

          {/* Bank line — fixed, the cash actually received/paid. */}
          <div className="flex items-center justify-between rounded border border-hair/70 px-3 py-2 text-sm">
            <span className="text-muted-foreground">
              {label} <span className="text-faint">(bank — {inflow ? "debit" : "credit"})</span>
            </span>
            <Money cents={bankAmount} />
          </div>

          {/* Category lines. */}
          <div className="space-y-2">
            {lines.map((l, i) => (
              <div key={i} className="flex items-center gap-2">
                <AccountCombobox
                  accounts={accounts}
                  /* Plaid sign: positive = outflow, negative = money in. */
                  inflow={amountCents < 0}
                  value={l.accountId}
                  onChange={(id) => update(i, { accountId: id })}
                  disabled={busy}
                  placeholder="— account —"
                  className="min-w-[12rem] flex-1"
                />
                <Input
                  value={l.memo}
                  onChange={(e) => update(i, { memo: e.target.value })}
                  placeholder="note"
                  disabled={busy}
                  className="hidden h-7 w-32 text-xs sm:block"
                />
                <select
                  value={l.side}
                  onChange={(e) => update(i, { side: e.target.value as Side })}
                  disabled={busy}
                  className="rounded border border-hair bg-transparent px-2 py-1 text-xs"
                >
                  <option value="debit">Debit</option>
                  <option value="credit">Credit</option>
                </select>
                <Input
                  value={l.amount}
                  onChange={(e) => update(i, { amount: e.target.value })}
                  placeholder="0.00"
                  inputMode="decimal"
                  disabled={busy}
                  className="h-7 w-28 text-right font-mono text-xs tabular-nums"
                />
                <button
                  type="button"
                  onClick={() => removeLine(i)}
                  disabled={busy || lines.length === 1}
                  className="px-1 text-faint hover:text-oxblood disabled:opacity-40"
                  aria-label="Remove line"
                  title="Remove line"
                >
                  ×
                </button>
              </div>
            ))}
          </div>

          <div className="flex items-center justify-between">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={addLine}
              disabled={busy}
            >
              + Add line
            </Button>
            <div className="flex items-center gap-4 text-sm">
              {diff === 0 ? (
                <span className="text-evergreen">Balanced ✓</span>
              ) : (
                <span className="text-oxblood">
                  Out of balance by <Money cents={Math.abs(diff)} tone="neg" />
                </span>
              )}
              <Button type="button" onClick={post} disabled={!canPost}>
                {busy ? "Posting…" : "Post entry"}
              </Button>
            </div>
          </div>
        </div>
      </td>
    </tr>
  );
}
