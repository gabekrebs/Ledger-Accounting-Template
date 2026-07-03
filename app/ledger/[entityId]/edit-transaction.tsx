"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Money } from "@/components/money";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { AccountCombobox } from "@/components/ui/account-combobox";
import {
  loadTransactionForEdit,
  saveTransactionEdit,
  revertTransactionEdit,
  type CategoryOption,
} from "./actions";
import { deleteManualEntryAction } from "./transactions/actions";
import type { EditableTransaction } from "@/lib/ledger/edit-transaction";

/**
 * The one transaction-edit affordance, dropped into every surface that lists a
 * transaction (Transactions table, P&L drill-down, GL). A pencil button that
 * opens a slide-over to recategorize the posting(s) and fix payee / memo / date.
 * The amount is locked, so the entry can never be unbalanced from here.
 *
 * The full transaction is fetched lazily on open (lean list payloads + always
 * fresh after a save). `edited` shows the provenance dot without a round-trip.
 */
export function EditTransactionButton({
  entityId,
  entryId,
  edited = false,
  className,
}: {
  entityId: string;
  entryId: string;
  edited?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Edit transaction"
        title={edited ? "Edited — click to view or change" : "Edit transaction"}
        className={cn(
          "inline-flex items-center gap-1 rounded p-1 text-faint transition-colors hover:text-evergreen",
          className
        )}
      >
        <PencilIcon className="size-3.5" />
        {edited && (
          <span className="size-1.5 rounded-full bg-evergreen" aria-hidden />
        )}
      </button>
      {open && (
        <EditPanel
          entityId={entityId}
          entryId={entryId}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

/** "Apr 22, 2026" without timezone drift. */
const MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");
function fmtDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-");
  const mi = Number(m) - 1;
  if (!y || mi < 0 || mi > 11) return iso;
  return `${MONTHS[mi]} ${Number(d)}, ${y}`;
}

function EditPanel({
  entityId,
  entryId,
  onClose,
}: {
  entityId: string;
  entryId: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const [txn, setTxn] = useState<EditableTransaction | null>(null);
  const [accounts, setAccounts] = useState<CategoryOption[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Editable state.
  const [name, setName] = useState("");
  const [memo, setMemo] = useState("");
  const [txnDate, setTxnDate] = useState("");
  const [lineAccounts, setLineAccounts] = useState<Record<string, string>>({});
  const [confirmRevert, setConfirmRevert] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, startTransition] = useTransition();

  // Lazy-load the full transaction + the entity's accounts on open.
  useEffect(() => {
    let alive = true;
    loadTransactionForEdit(entityId, entryId)
      .then(({ txn, accounts }) => {
        if (!alive) return;
        if (!txn) {
          setLoadError("Transaction not found.");
          return;
        }
        setTxn(txn);
        setAccounts(accounts);
        setName(txn.name ?? "");
        setMemo(txn.memo ?? "");
        setTxnDate(txn.txnDate.slice(0, 10));
        setLineAccounts(
          Object.fromEntries(txn.lines.map((l) => [l.id, l.accountId]))
        );
      })
      .catch((e) =>
        setLoadError(e instanceof Error ? e.message : "Could not load.")
      );
    return () => {
      alive = false;
    };
  }, [entityId, entryId]);

  // Escape closes; lock body scroll while open.
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

  const dirty =
    txn != null &&
    (name !== (txn.name ?? "") ||
      memo !== (txn.memo ?? "") ||
      txnDate !== txn.txnDate.slice(0, 10) ||
      txn.lines.some((l) => lineAccounts[l.id] !== l.accountId));

  function save() {
    if (!txn || !dirty) return;
    const lines = txn.lines
      .filter((l) => lineAccounts[l.id] !== l.accountId)
      .map((l) => ({ lineId: l.id, accountId: lineAccounts[l.id] }));
    startTransition(async () => {
      const res = await saveTransactionEdit({
        entityId,
        entryId,
        name: name.trim() === "" ? null : name.trim(),
        memo: memo.trim() === "" ? null : memo.trim(),
        txnDate,
        lines,
      });
      if (res.ok) {
        toast.success("Transaction updated");
        router.refresh();
        onClose();
      } else {
        toast.error(res.error ?? "Could not save");
      }
    });
  }

  function revert() {
    startTransition(async () => {
      const res = await revertTransactionEdit({ entityId, entryId });
      if (res.ok) {
        toast.success(res.reverted ? "Reverted to original" : "Already original");
        router.refresh();
        onClose();
      } else {
        toast.error(res.error ?? "Could not revert");
      }
    });
  }

  // Manual entries are ours alone, so they may be deleted; imported/Plaid
  // history never offers this (the server refuses regardless).
  function deleteEntry() {
    startTransition(async () => {
      const res = await deleteManualEntryAction({ entityId, entryId });
      if (res.ok) {
        toast.success("Entry deleted");
        router.refresh();
        onClose();
      } else {
        toast.error(res.error ?? "Could not delete");
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
              Edit transaction
            </h2>
            {txn && (
              <p className="mt-0.5 text-xs text-faint">
                {txn.qboTxnType ?? "Entry"} · {fmtDate(txn.txnDate)}
                {txn.docNum ? ` · #${txn.docNum}` : ""}
              </p>
            )}
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
        ) : !txn ? (
          <p className="p-5 text-sm text-faint">Loading…</p>
        ) : (
          <>
            <div className="flex-1 space-y-5 px-5 py-5">
              {/* Descriptive fields */}
              <Field label="Date">
                <input
                  type="date"
                  value={txnDate}
                  onChange={(e) => setTxnDate(e.target.value)}
                  disabled={busy}
                  className={inputCls}
                />
              </Field>
              <Field label="Payee">
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  disabled={busy}
                  placeholder="—"
                  className={inputCls}
                />
              </Field>
              <Field label="Memo">
                <input
                  value={memo}
                  onChange={(e) => setMemo(e.target.value)}
                  disabled={busy}
                  placeholder="—"
                  className={inputCls}
                />
              </Field>

              {/* Category picker(s) — one per posting line. */}
              <div className="space-y-2">
                <div className="text-[11px] font-medium uppercase tracking-[0.06em] text-faint">
                  {txn.lines.length > 2 ? "Categories" : "Category"}
                </div>
                <div className="space-y-2">
                  {txn.lines.map((l) => {
                    const amt = l.debitCents || l.creditCents;
                    const drcr = l.debitCents ? "Dr" : "Cr";
                    const changed = lineAccounts[l.id] !== l.accountId;
                    return (
                      <div key={l.id} className="space-y-1">
                        <div className="flex items-center gap-2">
                          {/* Credit lines are the income side of a deposit;
                              debit lines the spend side — lead the grouped
                              list with the matching classification. */}
                          <AccountCombobox
                            accounts={accounts}
                            inflow={!!l.creditCents}
                            value={lineAccounts[l.id] ?? l.accountId}
                            onChange={(id) =>
                              setLineAccounts((m) => ({ ...m, [l.id]: id }))
                            }
                            disabled={busy}
                            className="flex-1"
                          />
                          <span className="whitespace-nowrap text-xs text-faint tabular-nums">
                            {drcr} <Money cents={amt} className="text-xs" />
                          </span>
                        </div>
                        {changed && (
                          <p className="text-[11px] text-evergreen">
                            was {l.accountName}
                          </p>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Locked total */}
              <div className="flex items-center justify-between border-t border-hair pt-3 text-sm">
                <span className="text-faint">Total (locked)</span>
                <Money cents={txn.totalCents} />
              </div>

              {txn.editedAt && (
                <p className="text-[11px] text-faint">
                  Edited {fmtDate(txn.editedAt)}
                  {txn.editedBy ? ` by ${txn.editedBy}` : ""}.
                </p>
              )}
            </div>

            {/* Footer */}
            <div className="sticky bottom-0 flex items-center gap-2 border-t border-hair bg-background px-5 py-3">
              {txn.source === "manual" &&
                (confirmDelete ? (
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={busy}
                    onClick={deleteEntry}
                  >
                    Confirm delete
                  </Button>
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => setConfirmDelete(true)}
                  >
                    Delete entry
                  </Button>
                ))}
              {txn.editedAt &&
                (confirmRevert ? (
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={busy}
                    onClick={revert}
                  >
                    Confirm revert
                  </Button>
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => setConfirmRevert(true)}
                  >
                    Revert to original
                  </Button>
                ))}
              <div className="ml-auto flex items-center gap-2">
                <Button variant="ghost" size="sm" disabled={busy} onClick={onClose}>
                  Cancel
                </Button>
                <Button size="sm" disabled={busy || !dirty} onClick={save}>
                  {busy ? "Saving…" : "Save"}
                </Button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

const inputCls =
  "h-8 w-full rounded-lg border border-hair bg-transparent px-2 text-sm outline-none focus-visible:border-evergreen focus-visible:ring-2 focus-visible:ring-evergreen/20 disabled:opacity-50";

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-1">
      <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-faint">
        {label}
      </span>
      {children}
    </label>
  );
}

function PencilIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M11.5 2.5l2 2L6 12l-2.5.5L4 10l7.5-7.5z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CloseIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="m4 4 8 8M12 4l-8 8"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}
