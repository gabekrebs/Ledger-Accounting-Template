"use client";

import { useMemo, useState, useTransition, useDeferredValue } from "react";
import Link from "next/link";
import { Money } from "@/components/money";
import { cn } from "@/lib/utils";
import {
  NewAccountButton,
  EditAccountButton,
  type ParentOption,
} from "./manage-account";
import { setAccountActivityAction } from "./actions";

/** Shape the page hands us — a slice of AccountBalance + management fields. */
export interface AccountRow {
  /** bk_accounts.id — null only if the balance row has no chart row (shouldn't happen). */
  id: string | null;
  qboAccountId: string;
  name: string;
  fullyQualifiedName: string | null;
  accountType: string;
  classification: string;
  active: boolean;
  activity: string;
  netCents: number;
}

/** Statement order — the way a balance sheet then a P&L reads. */
const ORDER = ["asset", "liability", "equity", "revenue", "expense"] as const;
const GROUP_LABEL: Record<string, string> = {
  asset: "Assets",
  liability: "Liabilities",
  equity: "Equity",
  revenue: "Revenue",
  expense: "Expenses",
};

type SortKey = "name" | "type" | "balance";
type SortDir = "asc" | "desc";

/** Depth + leaf/prefix from a "Parent:Child:Leaf" qualified name. */
function pathParts(a: AccountRow): { prefix: string[]; leaf: string } {
  const full = a.fullyQualifiedName ?? a.name;
  const segs = full.split(":").map((s) => s.trim());
  return { prefix: segs.slice(0, -1), leaf: segs[segs.length - 1] };
}

function ActivityCell({
  entityId,
  accountId,
  value,
  allActivities,
}: {
  entityId: string;
  accountId: string | null;
  value: string;
  allActivities: string[];
}) {
  const [editing, setEditing] = useState(false);
  const [current, setCurrent] = useState(value);
  const [showCustom, setShowCustom] = useState(false);
  const [custom, setCustom] = useState("");
  const [pending, startTransition] = useTransition();

  function save(activity: string) {
    if (!accountId || !activity.trim()) return;
    setCurrent(activity);
    setEditing(false);
    setShowCustom(false);
    setCustom("");
    startTransition(async () => {
      await setAccountActivityAction({ entityId, accountId, activity });
    });
  }

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className={cn(
          "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] transition-colors hover:border-evergreen/40",
          pending ? "opacity-50" : "",
          current === "Real Estate"
            ? "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800/40 dark:bg-emerald-900/20 dark:text-emerald-300"
            : "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-800/40 dark:bg-amber-900/20 dark:text-amber-300"
        )}
      >
        {current}
      </button>
    );
  }

  if (showCustom) {
    return (
      <form
        className="flex items-center gap-1"
        onSubmit={(e) => {
          e.preventDefault();
          if (custom.trim()) save(custom.trim());
        }}
      >
        <input
          autoFocus
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          onBlur={() => { if (!custom.trim()) { setShowCustom(false); setEditing(false); } }}
          placeholder="Activity name…"
          className="h-6 w-32 rounded border border-hair bg-transparent px-1.5 text-[11px] outline-none focus:border-evergreen"
        />
        <button type="submit" className="text-[11px] text-evergreen hover:underline">Save</button>
      </form>
    );
  }

  return (
    <select
      autoFocus
      defaultValue={current}
      onChange={(e) => {
        if (e.target.value === "__custom__") {
          setShowCustom(true);
        } else {
          save(e.target.value);
        }
      }}
      onBlur={() => setEditing(false)}
      className="h-6 rounded border border-hair bg-transparent px-1 text-[11px] outline-none focus:border-evergreen"
    >
      {allActivities.map((a) => (
        <option key={a} value={a}>{a}</option>
      ))}
      <option value="__custom__">+ New activity…</option>
    </select>
  );
}

export function AccountsTable({
  entityId,
  accounts,
  parents,
}: {
  entityId: string;
  accounts: AccountRow[];
  parents: ParentOption[];
}) {
  const [rawQuery, setRawQuery] = useState("");
  const query = useDeferredValue(rawQuery);
  const [cls, setCls] = useState<string>("all");
  const [hideZero, setHideZero] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  const allActivities = useMemo(() => {
    const set = new Set(accounts.map((a) => a.activity));
    if (!set.has("Real Estate")) set.add("Real Estate");
    return [...set].sort();
  }, [accounts]);

  // Per-classification counts for the filter chips — over the full set so the
  // chips read as a stable map of the chart, not a moving target as you type.
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: accounts.length };
    for (const a of accounts) c[a.classification] = (c[a.classification] ?? 0) + 1;
    return c;
  }, [accounts]);

  const present = useMemo(
    () => ORDER.filter((k) => counts[k]),
    [counts]
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return accounts.filter((a) => {
      if (cls !== "all" && a.classification !== cls) return false;
      if (hideZero && a.netCents === 0) return false;
      if (q) {
        const hay = `${a.fullyQualifiedName ?? a.name} ${a.accountType}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [accounts, query, cls, hideZero]);

  const sorter = useMemo(() => {
    const dir = sortDir === "asc" ? 1 : -1;
    return (a: AccountRow, b: AccountRow) => {
      let cmp = 0;
      if (sortKey === "balance") cmp = a.netCents - b.netCents;
      else if (sortKey === "type") cmp = a.accountType.localeCompare(b.accountType);
      else
        cmp = (a.fullyQualifiedName ?? a.name).localeCompare(
          b.fullyQualifiedName ?? b.name
        );
      // Stable tiebreak on name so equal keys don't jump around.
      if (cmp === 0)
        cmp = (a.fullyQualifiedName ?? a.name).localeCompare(
          b.fullyQualifiedName ?? b.name
        );
      return cmp * dir;
    };
  }, [sortKey, sortDir]);

  // Group the filtered rows by classification, in statement order, each sorted.
  const groups = useMemo(() => {
    const byCls = new Map<string, AccountRow[]>();
    for (const a of filtered) {
      const arr = byCls.get(a.classification) ?? [];
      arr.push(a);
      byCls.set(a.classification, arr);
    }
    return present
      .filter((k) => byCls.has(k))
      .map((k) => {
        const rows = byCls.get(k)!.slice().sort(sorter);
        const subtotal = rows.reduce((s, r) => s + r.netCents, 0);
        return { key: k, label: GROUP_LABEL[k] ?? k, rows, subtotal };
      });
  }, [filtered, present, sorter]);

  // Trial-balance integrity — over the FULL book, independent of the filter.
  // Σ(debit balances) must equal Σ(credit balances). Their net is the proof.
  const proof = useMemo(() => {
    let debits = 0;
    let credits = 0;
    for (const a of accounts) {
      if (a.netCents > 0) debits += a.netCents;
      else credits += -a.netCents;
    }
    return { debits, credits, diff: debits - credits };
  }, [accounts]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      // Balance defaults high→low (the useful direction); text defaults A→Z.
      setSortDir(key === "balance" ? "desc" : "asc");
    }
  }

  const shown = filtered.length;
  const hasInactive = filtered.some((a) => !a.active);

  return (
    <div className="space-y-5">
      <p className="text-sm text-muted-foreground">
        Trial balance — every account&apos;s net balance (debit positive). Click an
        account for its ledger.
      </p>

      {/* Toolbar: search · type chips · hide-zero */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="relative">
          <input
            value={rawQuery}
            onChange={(e) => setRawQuery(e.target.value)}
            placeholder="Search accounts…"
            className="h-8 w-60 rounded-lg border border-hair bg-transparent pl-8 pr-7 text-sm outline-none placeholder:text-faint focus-visible:border-evergreen focus-visible:ring-2 focus-visible:ring-evergreen/20"
          />
          <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-faint" />
          {rawQuery && (
            <button
              type="button"
              onClick={() => setRawQuery("")}
              aria-label="Clear search"
              className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-faint hover:text-evergreen"
            >
              <CloseIcon className="size-3.5" />
            </button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <Chip active={cls === "all"} onClick={() => setCls("all")}>
            All <span className="tabular-nums opacity-60">{counts.all}</span>
          </Chip>
          {present.map((k) => (
            <Chip key={k} active={cls === k} onClick={() => setCls(k)}>
              {GROUP_LABEL[k]}{" "}
              <span className="tabular-nums opacity-60">{counts[k]}</span>
            </Chip>
          ))}
        </div>

        <label className="ml-auto flex cursor-pointer select-none items-center gap-1.5 text-sm text-muted-foreground">
          <input
            type="checkbox"
            checked={hideZero}
            onChange={(e) => setHideZero(e.target.checked)}
            className="size-3.5 accent-evergreen"
          />
          Hide $0
        </label>
        <NewAccountButton entityId={entityId} parents={parents} />
      </div>

      {shown === 0 ? (
        <p className="py-12 text-center text-sm text-faint">
          No accounts match
          {query ? (
            <>
              {" "}
              &ldquo;<span className="text-muted-foreground">{query}</span>&rdquo;
            </>
          ) : null}
          .
        </p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-hair text-[11px] font-medium uppercase tracking-[0.06em] text-faint">
              <SortTh
                onClick={() => toggleSort("name")}
                active={sortKey === "name"}
                dir={sortDir}
                className="text-left"
              >
                Account
              </SortTh>
              <SortTh
                onClick={() => toggleSort("type")}
                active={sortKey === "type"}
                dir={sortDir}
                className="text-left"
              >
                Type
              </SortTh>
              <th className="py-2 text-left font-medium text-[11px] uppercase tracking-[0.06em] text-faint">
                Activity
              </th>
              <SortTh
                onClick={() => toggleSort("balance")}
                active={sortKey === "balance"}
                dir={sortDir}
                className="text-right"
              >
                Net balance
              </SortTh>
            </tr>
          </thead>
          {groups.map((g) => (
            <tbody key={g.key}>
              {/* Group header — only when not narrowed to a single type. */}
              {cls === "all" && (
                <tr className="border-b border-hair/60">
                  <td
                    colSpan={4}
                    className="pt-5 pb-1.5 font-serif text-[13px] font-medium tracking-tight text-muted-foreground"
                  >
                    {g.label}
                    <span className="ml-1.5 text-[11px] font-sans text-faint">
                      {g.rows.length}
                    </span>
                  </td>
                </tr>
              )}
              {g.rows.map((a) => {
                const { prefix, leaf } = pathParts(a);
                return (
                  <tr
                    key={a.qboAccountId}
                    className="group/row border-b border-hair/60"
                  >
                    <td className="py-2.5">
                      <span className="inline-flex items-center gap-1">
                        <Link
                          href={`/ledger/${entityId}/gl/${a.qboAccountId}`}
                          className="group inline-flex items-center gap-1.5 hover:text-evergreen"
                          style={{ paddingLeft: prefix.length * 14 }}
                        >
                          {prefix.length > 0 && (
                            <span className="text-faint">
                              {prefix.join(" › ")} ›{" "}
                            </span>
                          )}
                          <span className="group-hover:underline">{leaf}</span>
                          {!a.active && (
                            <span className="rounded bg-hair/60 px-1 py-px text-[10px] font-medium uppercase tracking-wide text-faint">
                              inactive
                            </span>
                          )}
                        </Link>
                        {a.id && (
                          <EditAccountButton
                            entityId={entityId}
                            account={{
                              id: a.id,
                              name: a.name,
                              accountType: a.accountType,
                              active: a.active,
                              netCents: a.netCents,
                            }}
                          />
                        )}
                      </span>
                    </td>
                    <td className="py-2.5 text-xs text-faint">{a.accountType}</td>
                    <td className="py-2.5">
                      <ActivityCell
                        entityId={entityId}
                        accountId={a.id}
                        value={a.activity}
                        allActivities={allActivities}
                      />
                    </td>
                    <td className="py-2.5 text-right">
                      <Money cents={a.netCents} tone="auto" />
                    </td>
                  </tr>
                );
              })}
              {/* Group subtotal */}
              <tr>
                <td
                  colSpan={3}
                  className="border-t border-hair pt-2 pb-1 text-[11px] font-medium uppercase tracking-[0.06em] text-faint"
                >
                  {g.label} subtotal
                </td>
                <td className="border-t border-hair pt-2 pb-1 text-right font-medium">
                  <Money cents={g.subtotal} tone="auto" />
                </td>
              </tr>
            </tbody>
          ))}
        </table>
      )}

      {/* Footer: count + trial-balance integrity over the whole book */}
      <div className="flex flex-wrap items-center justify-between gap-3 pt-1 text-xs text-faint">
        <span>
          {shown === accounts.length
            ? `${accounts.length} accounts`
            : `${shown} of ${accounts.length} accounts`}
          {hasInactive ? " · includes inactive accounts that still hold a balance" : ""}
        </span>
        <span className="flex items-center gap-3">
          <span>
            Debits <Money cents={proof.debits} className="text-muted-foreground" />
          </span>
          <span>
            Credits <Money cents={proof.credits} className="text-muted-foreground" />
          </span>
          {proof.diff === 0 ? (
            <span className="inline-flex items-center gap-1 text-evergreen">
              <CheckIcon className="size-3.5" /> In balance
            </span>
          ) : (
            <span className="text-oxblood">
              Off by <Money cents={Math.abs(proof.diff)} />
            </span>
          )}
        </span>
      </div>
    </div>
  );
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs transition-colors",
        active
          ? "border-evergreen bg-evergreen-soft text-evergreen"
          : "border-hair text-muted-foreground hover:border-evergreen/40 hover:text-evergreen"
      )}
    >
      {children}
    </button>
  );
}

function SortTh({
  children,
  onClick,
  active,
  dir,
  className,
}: {
  children: React.ReactNode;
  onClick: () => void;
  active: boolean;
  dir: SortDir;
  className?: string;
}) {
  return (
    <th className={cn("py-2 font-medium", className)}>
      <button
        type="button"
        onClick={onClick}
        className={cn(
          "inline-flex items-center gap-1 uppercase tracking-[0.06em] transition-colors hover:text-evergreen",
          className?.includes("text-right") && "flex-row-reverse",
          active ? "text-evergreen" : "text-faint"
        )}
      >
        {children}
        <span className={cn("text-[9px]", active ? "opacity-100" : "opacity-0")}>
          {dir === "asc" ? "▲" : "▼"}
        </span>
      </button>
    </th>
  );
}

function SearchIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.4" />
      <path d="m11 11 3 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function CloseIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="m3 8.5 3 3 7-7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
