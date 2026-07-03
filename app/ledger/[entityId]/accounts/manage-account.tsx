"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  createAccountAction,
  updateAccountAction,
  setAccountActiveAction,
} from "./actions";

/**
 * Chart-of-accounts management UI — "New account" (toolbar) and a per-row edit
 * panel (rename / retype / deactivate). QBO-mirrored accounts on a synced
 * entity are read-only here (the nightly sync owns them); the server enforces
 * it and the row simply doesn't offer the pencil.
 */

/** QBO AccountTypes by classification — mirrors TYPE_MAP in lib/ledger/accounts.ts. */
const TYPE_GROUPS: { label: string; types: string[] }[] = [
  { label: "Assets", types: ["Bank", "Accounts Receivable", "Other Current Asset", "Fixed Asset", "Other Asset"] },
  { label: "Liabilities", types: ["Credit Card", "Accounts Payable", "Other Current Liability", "Long Term Liability"] },
  { label: "Equity", types: ["Equity"] },
  { label: "Revenue", types: ["Income", "Other Income"] },
  { label: "Expenses", types: ["Cost of Goods Sold", "Expense", "Other Expense"] },
];

const CLASS_OF_TYPE: Record<string, string> = {
  Bank: "asset",
  "Accounts Receivable": "asset",
  "Other Current Asset": "asset",
  "Fixed Asset": "asset",
  "Other Asset": "asset",
  "Credit Card": "liability",
  "Accounts Payable": "liability",
  "Other Current Liability": "liability",
  "Long Term Liability": "liability",
  Equity: "equity",
  Income: "revenue",
  "Other Income": "revenue",
  "Cost of Goods Sold": "expense",
  Expense: "expense",
  "Other Expense": "expense",
};

export interface ParentOption {
  id: string;
  label: string;
  classification: string;
}

export function NewAccountButton({
  entityId,
  parents,
}: {
  entityId: string;
  parents: ParentOption[];
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        New account
      </Button>
      {open && (
        <AccountPanel
          entityId={entityId}
          parents={parents}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

export interface EditableAccount {
  id: string;
  name: string;
  accountType: string;
  active: boolean;
  netCents: number;
}

export function EditAccountButton({
  entityId,
  account,
}: {
  entityId: string;
  account: EditableAccount;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Edit account"
        title="Edit account"
        className="rounded p-1 text-faint opacity-0 transition-colors hover:text-evergreen group-hover/row:opacity-100"
      >
        <PencilIcon className="size-3.5" />
      </button>
      {open && (
        <AccountPanel
          entityId={entityId}
          existing={account}
          parents={[]}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function AccountPanel({
  entityId,
  parents,
  existing,
  onClose,
}: {
  entityId: string;
  parents: ParentOption[];
  existing?: EditableAccount;
  onClose: () => void;
}) {
  const router = useRouter();
  const [name, setName] = useState(existing?.name ?? "");
  const [accountType, setAccountType] = useState(existing?.accountType ?? "Expense");
  const [parentId, setParentId] = useState("");
  const [confirmDeactivate, setConfirmDeactivate] = useState(false);
  const [busy, startTransition] = useTransition();

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

  const cls = CLASS_OF_TYPE[accountType];
  const eligibleParents = parents.filter((p) => p.classification === cls);
  const dirty = existing
    ? name.trim() !== existing.name || accountType !== existing.accountType
    : name.trim() !== "";

  function save() {
    startTransition(async () => {
      const res = existing
        ? await updateAccountAction({
            entityId,
            accountId: existing.id,
            name: name.trim(),
            accountType,
          })
        : await createAccountAction({
            entityId,
            name: name.trim(),
            accountType,
            parentId: parentId || null,
          });
      if (res.ok) {
        toast.success(existing ? "Account updated" : "Account created");
        router.refresh();
        onClose();
      } else {
        toast.error(res.error ?? "Could not save");
      }
    });
  }

  function setActive(active: boolean) {
    if (!existing) return;
    startTransition(async () => {
      const res = await setAccountActiveAction({
        entityId,
        accountId: existing.id,
        active,
      });
      if (res.ok) {
        toast.success(active ? "Account reactivated" : "Account deactivated");
        router.refresh();
        onClose();
      } else {
        toast.error(res.error ?? "Could not change status");
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
              {existing ? "Edit account" : "New account"}
            </h2>
            <p className="mt-0.5 text-xs text-faint">
              {existing
                ? "Renames re-file its history everywhere it appears."
                : "Adds an account to this entity's chart."}
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

        <div className="flex-1 space-y-5 px-5 py-5">
          <Field label="Name">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={busy}
              placeholder="e.g. Landscaping"
              className={inputCls}
            />
          </Field>
          <Field label="Type">
            <select
              value={accountType}
              onChange={(e) => {
                setAccountType(e.target.value);
                setParentId("");
              }}
              disabled={busy}
              className={inputCls}
            >
              {TYPE_GROUPS.map((g) => (
                <optgroup key={g.label} label={g.label}>
                  {g.types.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </Field>
          {!existing && eligibleParents.length > 0 && (
            <Field label="Parent (optional)">
              <select
                value={parentId}
                onChange={(e) => setParentId(e.target.value)}
                disabled={busy}
                className={cn(inputCls, !parentId && "text-faint")}
              >
                <option value="">None — top-level account</option>
                {eligibleParents.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {existing && !existing.active && (
            <p className="text-xs text-faint">
              This account is inactive — it&apos;s hidden from pickers and $0
              reports but its history is intact.
            </p>
          )}
        </div>

        <div className="sticky bottom-0 flex items-center gap-2 border-t border-hair bg-background px-5 py-3">
          {existing &&
            (existing.active ? (
              confirmDeactivate ? (
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={busy}
                  onClick={() => setActive(false)}
                >
                  Confirm deactivate
                </Button>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy || existing.netCents !== 0}
                  title={
                    existing.netCents !== 0
                      ? "Only $0-balance accounts can be deactivated"
                      : undefined
                  }
                  onClick={() => setConfirmDeactivate(true)}
                >
                  Deactivate
                </Button>
              )
            ) : (
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => setActive(true)}
              >
                Reactivate
              </Button>
            ))}
          <div className="ml-auto flex items-center gap-2">
            <Button variant="ghost" size="sm" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button size="sm" disabled={busy || !dirty || !name.trim()} onClick={save}>
              {busy ? "Saving…" : existing ? "Save" : "Create"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

const inputCls =
  "h-8 w-full rounded-lg border border-hair bg-transparent px-2 text-sm outline-none focus-visible:border-evergreen focus-visible:ring-2 focus-visible:ring-evergreen/20 disabled:opacity-50";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
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
