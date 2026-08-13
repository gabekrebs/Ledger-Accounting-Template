"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Money } from "@/components/money";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { AccountCombobox } from "@/components/ui/account-combobox";
import type { CategoryOption } from "../actions";
import { loadManualEntryForm, createManualEntryAction } from "./actions";
import { useEntityReadOnly } from "../capabilities";

/**
 * Manual journal entry composer — the "New entry" affordance on the
 * Transactions tab. A slide-over (same shell as the edit panel) with a date /
 * payee / memo header and N posting lines (account + debit OR credit). The
 * running totals pin the double-entry invariant in the UI: Post is enabled
 * only when debits equal credits to the penny.
 */
export function NewEntryButton({ entityId }: { entityId: string }) {
  const readOnly = useEntityReadOnly();
  const [open, setOpen] = useState(false);
  if (readOnly) return null; // viewers can't compose journal entries
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        New entry
      </Button>
      {open && <NewEntryPanel entityId={entityId} onClose={() => setOpen(false)} />}
    </>
  );
}

interface LineDraft {
  key: number;
  accountId: string;
  debit: string; // dollars, as typed
  credit: string;
  memo: string;
  location: string;
}

/** "1,234.56" → 123456 (integer cents); null when blank/invalid. */
export function parseCents(s: string): number | null {
  const t = s.replace(/[$,\s]/g, "");
  if (t === "") return 0;
  if (!/^\d*\.?\d{0,2}$/.test(t)) return null;
  const n = Math.round(parseFloat(t) * 100);
  return Number.isFinite(n) ? n : null;
}

let lineKey = 0;
function blankLine(): LineDraft {
  return { key: ++lineKey, accountId: "", debit: "", credit: "", memo: "", location: "" };
}

function NewEntryPanel({
  entityId,
  onClose,
}: {
  entityId: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const [accounts, setAccounts] = useState<CategoryOption[]>([]);
  const [locations, setLocations] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, startTransition] = useTransition();

  const [txnDate, setTxnDate] = useState(() =>
    new Date().toISOString().slice(0, 10)
  );
  const [name, setName] = useState("");
  const [memo, setMemo] = useState("");
  const [docNum, setDocNum] = useState("");
  const [lines, setLines] = useState<LineDraft[]>(() => [blankLine(), blankLine()]);

  useEffect(() => {
    let alive = true;
    loadManualEntryForm(entityId)
      .then((d) => {
        if (!alive) return;
        setAccounts(d.accounts);
        setLocations(d.locations);
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

  function patch(key: number, p: Partial<LineDraft>) {
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...p } : l)));
  }

  const math = useMemo(() => {
    let dr = 0;
    let cr = 0;
    let invalid = false;
    let nonEmpty = 0;
    for (const l of lines) {
      const d = parseCents(l.debit);
      const c = parseCents(l.credit);
      if (d === null || c === null) {
        invalid = true;
        continue;
      }
      if (d === 0 && c === 0) continue;
      nonEmpty++;
      if (!l.accountId) invalid = true;
      dr += d;
      cr += c;
    }
    return { dr, cr, diff: dr - cr, invalid, nonEmpty };
  }, [lines]);

  const canPost =
    !busy &&
    !math.invalid &&
    math.nonEmpty >= 2 &&
    math.dr === math.cr &&
    math.dr > 0 &&
    /^\d{4}-\d{2}-\d{2}$/.test(txnDate);

  function post() {
    if (!canPost) return;
    startTransition(async () => {
      const res = await createManualEntryAction({
        entityId,
        txnDate,
        name: name.trim() || null,
        memo: memo.trim() || null,
        docNum: docNum.trim() || null,
        lines: lines
          .map((l) => ({
            accountId: l.accountId,
            debitCents: parseCents(l.debit) ?? 0,
            creditCents: parseCents(l.credit) ?? 0,
            lineMemo: l.memo.trim() || null,
            location: l.location.trim() || null,
          }))
          .filter((l) => l.debitCents !== 0 || l.creditCents !== 0),
      });
      if (res.ok) {
        toast.success("Entry posted");
        router.refresh();
        onClose();
      } else {
        toast.error(res.error ?? "Could not post the entry");
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
      <div className="relative flex h-full w-full max-w-xl flex-col overflow-y-auto border-l border-hair bg-background shadow-xl">
        <div className="flex items-start justify-between gap-3 border-b border-hair px-5 py-4">
          <div>
            <h2 className="font-serif text-lg font-medium tracking-tight">
              New journal entry
            </h2>
            <p className="mt-0.5 text-xs text-faint">
              Posts a balanced entry directly to the books — for adjustments,
              accruals, and anything no bank feed will ever send.
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
              <div className="grid grid-cols-2 gap-3">
                <Field label="Date">
                  <input
                    type="date"
                    value={txnDate}
                    onChange={(e) => setTxnDate(e.target.value)}
                    disabled={busy}
                    className={inputCls}
                  />
                </Field>
                <Field label="Ref # (optional)">
                  <input
                    value={docNum}
                    onChange={(e) => setDocNum(e.target.value)}
                    disabled={busy}
                    placeholder="—"
                    className={inputCls}
                  />
                </Field>
              </div>
              <Field label="Payee / counterparty (optional)">
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
                  placeholder="Why this entry exists — the next reader will thank you"
                  className={inputCls}
                />
              </Field>

              {/* Posting lines */}
              <div className="space-y-3">
                <div className="grid grid-cols-[1fr_6rem_6rem_1.5rem] items-center gap-2 text-[11px] font-medium uppercase tracking-[0.06em] text-faint">
                  <span>Account</span>
                  <span className="text-right">Debit</span>
                  <span className="text-right">Credit</span>
                  <span />
                </div>
                {lines.map((l) => (
                  <div key={l.key} className="space-y-1.5">
                    <div className="grid grid-cols-[1fr_6rem_6rem_1.5rem] items-center gap-2">
                      <AccountCombobox
                        accounts={accounts}
                        inflow={false}
                        value={l.accountId}
                        onChange={(id) => patch(l.key, { accountId: id })}
                        disabled={busy || accounts.length === 0}
                        placeholder={accounts.length ? "Choose account…" : "Loading…"}
                      />
                      <input
                        inputMode="decimal"
                        value={l.debit}
                        onChange={(e) =>
                          patch(l.key, { debit: e.target.value, credit: "" })
                        }
                        disabled={busy}
                        placeholder="0.00"
                        className={cn(inputCls, "text-right tabular-nums")}
                      />
                      <input
                        inputMode="decimal"
                        value={l.credit}
                        onChange={(e) =>
                          patch(l.key, { credit: e.target.value, debit: "" })
                        }
                        disabled={busy}
                        placeholder="0.00"
                        className={cn(inputCls, "text-right tabular-nums")}
                      />
                      <button
                        type="button"
                        onClick={() =>
                          setLines((ls) =>
                            ls.length > 2 ? ls.filter((x) => x.key !== l.key) : ls
                          )
                        }
                        disabled={busy || lines.length <= 2}
                        aria-label="Remove line"
                        className="rounded p-1 text-faint hover:text-oxblood disabled:opacity-30"
                      >
                        <CloseIcon className="size-3.5" />
                      </button>
                    </div>
                    <div
                      className={cn(
                        "grid items-center gap-2",
                        locations.length > 0
                          ? "grid-cols-[1fr_8rem_1.5rem]"
                          : "grid-cols-[1fr_1.5rem]"
                      )}
                    >
                      <input
                        value={l.memo}
                        onChange={(e) => patch(l.key, { memo: e.target.value })}
                        disabled={busy}
                        placeholder="Line memo (optional)"
                        className={cn(inputCls, "h-7 text-xs")}
                      />
                      {locations.length > 0 && (
                        <input
                          value={l.location}
                          onChange={(e) => patch(l.key, { location: e.target.value })}
                          disabled={busy}
                          placeholder="Location"
                          list={`locations-${entityId}`}
                          className={cn(inputCls, "h-7 text-xs")}
                        />
                      )}
                      <span />
                    </div>
                  </div>
                ))}
                {locations.length > 0 && (
                  <datalist id={`locations-${entityId}`}>
                    {locations.map((loc) => (
                      <option key={loc} value={loc} />
                    ))}
                  </datalist>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => setLines((ls) => [...ls, blankLine()])}
                >
                  + Add line
                </Button>
              </div>
            </div>

            {/* Footer: live balance + post */}
            <div className="sticky bottom-0 border-t border-hair bg-background px-5 py-3">
              <div className="mb-2 flex items-center justify-between text-xs">
                <span className="text-faint">
                  Debits <Money cents={math.dr} className="text-muted-foreground" />
                  {" · "}
                  Credits <Money cents={math.cr} className="text-muted-foreground" />
                </span>
                {math.dr === math.cr && math.dr > 0 ? (
                  <span className="text-evergreen">Balanced</span>
                ) : (
                  <span className={math.dr + math.cr > 0 ? "text-oxblood" : "text-faint"}>
                    Off by <Money cents={Math.abs(math.diff)} className="text-xs" />
                  </span>
                )}
              </div>
              <div className="flex items-center justify-end gap-2">
                <Button variant="ghost" size="sm" disabled={busy} onClick={onClose}>
                  Cancel
                </Button>
                <Button size="sm" disabled={!canPost} onClick={post}>
                  {busy ? "Posting…" : "Post entry"}
                </Button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export const inputCls =
  "h-8 w-full rounded-lg border border-hair bg-transparent px-2 text-sm outline-none focus-visible:border-evergreen focus-visible:ring-2 focus-visible:ring-evergreen/20 disabled:opacity-50";

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-faint">
        {label}
      </span>
      {children}
    </label>
  );
}

export function CloseIcon({ className }: { className?: string }) {
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
