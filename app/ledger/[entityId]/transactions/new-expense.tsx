"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { AccountCombobox } from "@/components/ui/account-combobox";
import type { CategoryOption } from "../actions";
import { loadManualEntryForm, createManualEntryAction } from "./actions";
import { CloseIcon, Field, inputCls, parseCents } from "./new-entry";
import { useEntityReadOnly } from "../capabilities";

/**
 * Owner-paid expense composer — the "New expense" affordance next to New
 * entry. The fast path for the most common manual entry: a partner paid a
 * vendor personally, booked as debit expense / credit that partner's
 * contribution account. Pay-from offers only the owner-contribution equity
 * accounts; anything else belongs in the full New entry composer.
 */
export function NewExpenseButton({ entityId }: { entityId: string }) {
  const readOnly = useEntityReadOnly();
  const [open, setOpen] = useState(false);
  if (readOnly) return null; // viewers can't compose journal entries
  return (
    <>
      <Button
        size="sm"
        className="bg-oxblood text-white hover:bg-oxblood/85"
        onClick={() => setOpen(true)}
      >
        New expense
      </Button>
      {open && <NewExpensePanel entityId={entityId} onClose={() => setOpen(false)} />}
    </>
  );
}

const CONTRIBUTION_RE = /investment \/ drawings|contribution \/ drawing/i;

/**
 * Named partner accounts alphabetically, the unnamed "Owner Investment /
 * Drawings" last — it's the default only on entities with no named accounts.
 */
function contributionAccounts(accounts: CategoryOption[]): CategoryOption[] {
  const rank = (label: string) => (label.includes(" - ") ? 0 : 1);
  return accounts
    .filter((a) => a.classification === "equity" && CONTRIBUTION_RE.test(a.label))
    .sort((a, b) => rank(a.label) - rank(b.label) || a.label.localeCompare(b.label));
}

function NewExpensePanel({
  entityId,
  onClose,
}: {
  entityId: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const [accounts, setAccounts] = useState<CategoryOption[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, startTransition] = useTransition();

  const [payFromId, setPayFromId] = useState("");
  const [vendor, setVendor] = useState("");
  const [expenseId, setExpenseId] = useState("");
  const [amount, setAmount] = useState("");
  const [txnDate, setTxnDate] = useState(() =>
    new Date().toISOString().slice(0, 10)
  );
  const [memo, setMemo] = useState("");

  const payFromOptions = useMemo(() => contributionAccounts(accounts), [accounts]);
  const expenseOptions = useMemo(
    () => accounts.filter((a) => a.classification === "expense"),
    [accounts]
  );

  useEffect(() => {
    let alive = true;
    loadManualEntryForm(entityId)
      .then((d) => {
        if (!alive) return;
        setAccounts(d.accounts);
        setPayFromId(contributionAccounts(d.accounts)[0]?.id ?? "");
      })
      .catch((e) =>
        setLoadError(e instanceof Error ? e.message : "Could not load accounts.")
      );
    return () => {
      alive = false;
    };
  }, [entityId]);

  // Escape closes; lock body scroll while open (edit-panel conventions).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !busy) onClose();
    }
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose, busy]);

  const cents = parseCents(amount);
  const canPost =
    !busy &&
    payFromId !== "" &&
    expenseId !== "" &&
    vendor.trim() !== "" &&
    cents !== null &&
    cents > 0 &&
    /^\d{4}-\d{2}-\d{2}$/.test(txnDate);

  function post() {
    if (!canPost) return;
    startTransition(async () => {
      const res = await createManualEntryAction({
        entityId,
        txnDate,
        name: vendor.trim(),
        memo: memo.trim() || null,
        lines: [
          { accountId: expenseId, debitCents: cents!, creditCents: 0 },
          { accountId: payFromId, debitCents: 0, creditCents: cents! },
        ],
      });
      if (res.ok) {
        toast.success("Expense posted");
        router.refresh();
        onClose();
      } else {
        toast.error(res.error ?? "Could not post the expense");
      }
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <button
        type="button"
        aria-label="Close"
        onClick={() => !busy && onClose()}
        className="absolute inset-0 bg-ink/20 backdrop-blur-[1px]"
      />
      <div className="relative flex h-full w-full max-w-md flex-col overflow-y-auto border-l border-hair bg-background shadow-xl">
        <div className="flex items-start justify-between gap-3 border-b border-hair px-5 py-4">
          <div>
            <h2 className="font-serif text-lg font-medium tracking-tight">
              New expense
            </h2>
            <p className="mt-0.5 text-xs text-faint">
              A partner paid this out of pocket — books the expense against
              their contribution account.
            </p>
          </div>
          <button
            type="button"
            onClick={() => !busy && onClose()}
            aria-label="Close"
            className="rounded p-1 text-faint hover:text-evergreen"
          >
            <CloseIcon className="size-4" />
          </button>
        </div>

        {loadError ? (
          <p className="p-5 text-sm text-oxblood">{loadError}</p>
        ) : (
          <>
            <div className="flex-1 space-y-5 px-5 py-5">
              <Field label="Paid from">
                <select
                  value={payFromId}
                  onChange={(e) => setPayFromId(e.target.value)}
                  disabled={busy || payFromOptions.length === 0}
                  className={inputCls}
                >
                  {payFromOptions.length === 0 && (
                    <option value="">
                      {accounts.length ? "No contribution accounts" : "Loading…"}
                    </option>
                  )}
                  {payFromOptions.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Vendor">
                <input
                  value={vendor}
                  onChange={(e) => setVendor(e.target.value)}
                  disabled={busy}
                  placeholder="Who was paid"
                  className={inputCls}
                />
              </Field>
              <Field label="Expense account">
                <AccountCombobox
                  accounts={expenseOptions}
                  inflow={false}
                  value={expenseId}
                  onChange={setExpenseId}
                  disabled={busy || expenseOptions.length === 0}
                  placeholder={accounts.length ? "Choose account…" : "Loading…"}
                />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Amount">
                  <input
                    inputMode="decimal"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    disabled={busy}
                    placeholder="0.00"
                    className={cn(inputCls, "text-right tabular-nums")}
                  />
                </Field>
                <Field label="Date">
                  <input
                    type="date"
                    value={txnDate}
                    onChange={(e) => setTxnDate(e.target.value)}
                    disabled={busy}
                    className={inputCls}
                  />
                </Field>
              </div>
              <Field label="Memo (optional)">
                <input
                  value={memo}
                  onChange={(e) => setMemo(e.target.value)}
                  disabled={busy}
                  placeholder="—"
                  className={inputCls}
                />
              </Field>
            </div>

            <div className="sticky bottom-0 flex items-center justify-end gap-2 border-t border-hair bg-background px-5 py-3">
              <Button variant="ghost" size="sm" disabled={busy} onClick={onClose}>
                Cancel
              </Button>
              <Button size="sm" disabled={!canPost} onClick={post}>
                {busy ? "Posting…" : "Post expense"}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
