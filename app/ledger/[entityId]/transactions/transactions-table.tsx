"use client";

import {
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import Link from "next/link";
import { Money } from "@/components/money";
import { cn } from "@/lib/utils";
import type { TxnSearchRow } from "@/lib/ledger/reports";
import { EditTransactionButton } from "../edit-transaction";
import { fmtDate } from "@/lib/ledger/format";

type SortKey = "date" | "type" | "name" | "amount";
type SortDir = "asc" | "desc";

const PAGE_SIZE = 50;

/** Human labels for QuickBooks transaction types. */
const TYPE_LABEL: Record<string, string> = {
  Purchase: "Purchase",
  Deposit: "Deposit",
  CreditCardPayment: "Card Payment",
  CreditCardCharge: "Card Charge",
  JournalEntry: "Journal Entry",
  Transfer: "Transfer",
  Reclass: "Reclass",
  Invoice: "Invoice",
  Payment: "Payment",
  Bill: "Bill",
  BillPayment: "Bill Payment",
  SalesReceipt: "Sales Receipt",
  Check: "Check",
  Expense: "Expense",
  RefundReceipt: "Refund",
  VendorCredit: "Vendor Credit",
};
function prettyType(t: string): string {
  if (TYPE_LABEL[t]) return TYPE_LABEL[t];
  // Fallback: split CamelCase into words ("TaxReturn" → "Tax Return").
  return t.replace(/([a-z])([A-Z])/g, "$1 $2");
}

/**
 * Display type derived from the posting shape. Used whenever the stored type
 * carries no meaning: Wave imports (all "WaveTxn" — part of the import
 * idempotency key, so it can't be rewritten) and bank-feed / partner-mirror
 * entries (no type at all). QBO-imported entries never come here — their
 * stored type is more specific than any shape guess.
 */
function typeFromShape(r: TxnSearchRow): string {
  // Wave year-end bookkeeping JEs are named "To adj… / To group… / To reclassify…".
  if (r.name && /^to (adj|group|reclass|remove|record|zero)/i.test(r.name.trim()))
    return "Journal Entry";
  // Wave models bank↔bank moves as paired entries through a clearing account.
  if (r.lines.some((l) => /transfer clearing/i.test(l.accountName))) return "Transfer";
  const bank = r.lines.filter((l) => l.accountType === "Bank");
  if (bank.length === 0) {
    // Card-feed entities have no bank line — the card itself is the cash
    // side. Liability up = spend on the card; down = a statement credit.
    const ccNet = r.lines
      .filter((l) => l.accountType === "Credit Card")
      .reduce((s, l) => s + l.creditCents - l.debitCents, 0);
    if (ccNet > 0) return "Card Charge";
    if (ccNet < 0) return "Card Credit";
    // No cash moved, but it's mortgage bookkeeping (the monthly
    // principal/interest split corrections, statement ties, balloon
    // reclasses) — the ledger is full of these and "Journal Entry" hides them.
    if (r.lines.some((l) => MORTGAGE.test(l.accountName))) return "Mortgage";
    return "Journal Entry";
  }
  if (
    bank.length >= 2 &&
    bank.some((l) => l.debitCents > 0) &&
    bank.some((l) => l.creditCents > 0)
  )
    return "Transfer";
  const bankNet = bank.reduce((s, l) => s + l.debitCents - l.creditCents, 0);
  const others = r.lines.filter((l) => l.accountType !== "Bank");
  if (bankNet < 0) {
    const loan = others.filter(
      (l) => l.accountType === "Long Term Liability" && l.debitCents > 0
    );
    if (loan.length > 0)
      return loan.some((l) => MORTGAGE.test(l.accountName))
        ? "Mortgage"
        : "Loan Payment";
    if (others.some((l) => l.accountType === "Credit Card" && l.debitCents > 0))
      return "Card Payment";
    if (others.some((l) => l.accountType === "Equity" && l.debitCents > 0))
      return "Owner Draw";
    return "Expense";
  }
  if (others.some((l) => l.accountType === "Equity" && l.creditCents > 0))
    return "Owner Contribution";
  // Money in that reverses an expense (and books no income) is a refund,
  // not revenue — vendor credits, duplicate reversals, permit refunds.
  if (
    others.some((l) => EXPENSE_TYPE.test(l.accountType) && l.creditCents > 0) &&
    !others.some((l) => INCOME_TYPE.test(l.accountType) && l.creditCents > 0)
  )
    return "Refund";
  return "Deposit";
}

const MORTGAGE = /mortgage/i;
/** QBO account types that mean expense / income on a posting line. */
const EXPENSE_TYPE = /^(Expense|Other Expense|Cost of Goods Sold)$/;
const INCOME_TYPE = /^(Income|Other Income)$/;

/** A stored type worth showing — anything real except Wave's synthetic marker. */
function storedType(r: TxnSearchRow): string | null {
  return r.qboTxnType && r.qboTxnType !== "WaveTxn" ? r.qboTxnType : null;
}

function rowType(r: TxnSearchRow): string {
  const t = storedType(r);
  if (t === "ManualEntry") {
    // In-product manual JEs: say what the entry does when the shape knows
    // (mortgage splits, owner draws…); keep the provenance label only when
    // the shape has nothing better than the vague fallback.
    const shaped = typeFromShape(r);
    return shaped === "Journal Entry" ? "Manual Entry" : shaped;
  }
  return t ? prettyType(t) : typeFromShape(r);
}

/**
 * A transaction's amounts as plain decimal strings ("671.94") — the entry total
 * plus each line's non-zero side — so the search box can find an entry by its
 * dollar amount (matched by prefix, so "671", "671.94" and "$2,400.00" all work).
 */
function amountStrings(r: TxnSearchRow): string[] {
  const out = [(r.totalCents / 100).toFixed(2)];
  for (const l of r.lines) {
    if (l.debitCents > 0) out.push((l.debitCents / 100).toFixed(2));
    if (l.creditCents > 0) out.push((l.creditCents / 100).toFixed(2));
  }
  return out;
}

/**
 * Cash direction read straight off the posting: which way did money move
 * through the bank (or, for card feeds, the card)? Label-independent, so a
 * mortgage *payment* shows red while a no-cash mortgage split stays neutral.
 */
function shapeDirection(r: TxnSearchRow): "in" | "out" | null {
  const bankNet = r.lines
    .filter((l) => l.accountType === "Bank")
    .reduce((s, l) => s + l.debitCents - l.creditCents, 0);
  if (bankNet !== 0) return bankNet > 0 ? "in" : "out";
  const ccNet = r.lines
    .filter((l) => l.accountType === "Credit Card")
    .reduce((s, l) => s + l.creditCents - l.debitCents, 0);
  if (ccNet !== 0) return ccNet > 0 ? "out" : "in";
  return null;
}
function rowDirection(r: TxnSearchRow): "in" | "out" | null {
  const t = storedType(r);
  return t && t !== "ManualEntry" ? direction(t) : shapeDirection(r);
}

/** Cash direction inferred from the QBO type — only where it's unambiguous. */
function direction(t: string): "in" | "out" | null {
  switch (t) {
    case "Deposit":
    case "SalesReceipt":
    case "Payment":
    case "RefundReceipt":
      return "in";
    case "Purchase":
    case "CreditCardPayment":
    case "CreditCardCharge":
    case "Check":
    case "Expense":
    case "Bill":
    case "BillPayment":
    case "VendorCredit":
      return "out";
    default:
      return null; // JournalEntry, Transfer, Reclass, Invoice, unknown
  }
}


/** Shift an ISO date by N days (UTC, so no DST drift). */
function shiftDays(iso: string, days: number): string {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  const t = Date.UTC(y, m - 1, d) + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

interface Period {
  key: string;
  label: string;
  start: string | null; // inclusive; null = open
  end: string | null; // inclusive; null = open
}

function buildPeriods(todayISO: string, years: number[]): Period[] {
  const today = todayISO.slice(0, 10);
  const yr = today.slice(0, 4);
  const out: Period[] = [
    { key: "all", label: "All time", start: null, end: null },
    { key: "30d", label: "Last 30 days", start: shiftDays(today, -30), end: today },
    { key: "90d", label: "Last 90 days", start: shiftDays(today, -90), end: today },
    { key: "ytd", label: "Year to date", start: `${yr}-01-01`, end: today },
    { key: "12m", label: "Last 12 months", start: shiftDays(today, -365), end: today },
  ];
  for (const y of years) {
    out.push({ key: `y${y}`, label: String(y), start: `${y}-01-01`, end: `${y}-12-31` });
  }
  return out;
}

export function TransactionsTable({
  entityId,
  rows,
  totalCount,
}: {
  entityId: string;
  rows: TxnSearchRow[];
  /** True entry count for the entity (rows may be capped below this). */
  totalCount: number;
}) {
  const [rawQuery, setRawQuery] = useState("");
  const query = useDeferredValue(rawQuery);
  const [type, setType] = useState<string>("all");
  const [periodKey, setPeriodKey] = useState("all");
  const [sortKey, setSortKey] = useState<SortKey>("date");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [page, setPage] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);

  // "/" focuses search; Escape clears it. Skip when already typing in a field.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = document.activeElement;
      const typing =
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        el instanceof HTMLSelectElement;
      if (e.key === "/" && !typing) {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (e.key === "Escape" && el === searchRef.current) {
        setRawQuery("");
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Type chips — counts over the full loaded set, ordered by frequency.
  const typeChips = useMemo(() => {
    const c = new Map<string, number>();
    for (const r of rows) {
      const label = rowType(r);
      c.set(label, (c.get(label) ?? 0) + 1);
    }
    return [...c.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([label, n]) => ({ label, n }));
  }, [rows]);

  const periods = useMemo(() => {
    const years = [...new Set(rows.map((r) => Number(r.txnDate.slice(0, 4))))]
      .filter((y) => y > 0)
      .sort((a, b) => b - a);
    // todayISO baked at module eval would break SSR determinism; the latest txn
    // date is a stable, meaningful "today" anchor for relative periods here.
    const anchor =
      rows.reduce((mx, r) => (r.txnDate > mx ? r.txnDate : mx), "") ||
      `${years[0] ?? 2020}-12-31`;
    return buildPeriods(anchor, years);
  }, [rows]);
  const period = periods.find((p) => p.key === periodKey) ?? periods[0];

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (type !== "all" && rowType(r) !== type) return false;
      const d = r.txnDate.slice(0, 10);
      if (period.start && d < period.start) return false;
      if (period.end && d > period.end) return false;
      if (q) {
        const hay = `${r.name ?? ""} ${r.memo ?? ""} ${r.docNum ?? ""} ${rowType(
          r
        )} ${r.lines.map((l) => l.accountName).join(" ")}`.toLowerCase();
        if (!hay.includes(q)) {
          // Also try a dollar-amount match: strip $ , and spaces; if the query is
          // numeric, match the entry total or any line amount by decimal prefix.
          const amt = q.replace(/[$,\s]/g, "");
          const numeric = amt.length > 0 && /^\d*\.?\d*$/.test(amt) && /\d/.test(amt);
          if (!numeric || !amountStrings(r).some((s) => s.startsWith(amt))) {
            return false;
          }
        }
      }
      return true;
    });
  }, [rows, query, type, period]);

  const sorted = useMemo(() => {
    const dir = sortDir === "asc" ? 1 : -1;
    const arr = filtered.slice();
    arr.sort((a, b) => {
      let cmp = 0;
      if (sortKey === "amount") cmp = a.totalCents - b.totalCents;
      else if (sortKey === "type")
        cmp = rowType(a).localeCompare(rowType(b));
      else if (sortKey === "name")
        cmp = (a.name ?? "").localeCompare(b.name ?? "");
      else cmp = a.txnDate.localeCompare(b.txnDate); // date
      // Stable tiebreak: newest first, then id.
      if (cmp === 0) cmp = a.txnDate.localeCompare(b.txnDate) || a.id.localeCompare(b.id);
      return cmp * dir;
    });
    return arr;
  }, [filtered, sortKey, sortDir]);

  // Money in / out over the filtered set — honest cash-direction totals.
  const totals = useMemo(() => {
    let cashIn = 0;
    let cashOut = 0;
    for (const r of filtered) {
      const dir = rowDirection(r);
      if (dir === "in") cashIn += r.totalCents;
      else if (dir === "out") cashOut += r.totalCents;
    }
    return { cashIn, cashOut };
  }, [filtered]);

  // Snap back to page 1 whenever a filter changes shape — done in the filter
  // event handlers (below), not an effect; `clampedPage` keeps the page in
  // range when the result set shrinks for any other reason.
  function changeQuery(v: string) {
    setRawQuery(v);
    setPage(0);
  }
  function changeType(t: string) {
    setType(t);
    setPage(0);
  }
  function changePeriod(k: string) {
    setPeriodKey(k);
    setPage(0);
  }

  const pageCount = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const clampedPage = Math.min(page, pageCount - 1);
  const pageRows = sorted.slice(
    clampedPage * PAGE_SIZE,
    clampedPage * PAGE_SIZE + PAGE_SIZE
  );
  const firstIdx = sorted.length === 0 ? 0 : clampedPage * PAGE_SIZE + 1;
  const lastIdx = clampedPage * PAGE_SIZE + pageRows.length;

  const filtersActive = query.trim() !== "" || type !== "all" || periodKey !== "all";
  const capped = rows.length < totalCount;

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      // Amount & date default high/new → low/old; text defaults A→Z.
      setSortDir(key === "amount" || key === "date" ? "desc" : "asc");
    }
  }

  function resetAll() {
    setRawQuery("");
    setType("all");
    setPeriodKey("all");
    setPage(0);
  }

  return (
    <div className="space-y-4">
      {/* Toolbar: search · period · type chips */}
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <div className="relative">
            <input
              ref={searchRef}
              value={rawQuery}
              onChange={(e) => changeQuery(e.target.value)}
              placeholder="Search name, memo, amount, account…"
              className="h-8 w-72 rounded-lg border border-hair bg-transparent pl-8 pr-7 text-sm outline-none placeholder:text-faint focus-visible:border-evergreen focus-visible:ring-2 focus-visible:ring-evergreen/20"
            />
            <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-faint" />
            {rawQuery ? (
              <button
                type="button"
                onClick={() => changeQuery("")}
                aria-label="Clear search"
                className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-faint hover:text-evergreen"
              >
                <CloseIcon className="size-3.5" />
              </button>
            ) : (
              <kbd className="pointer-events-none absolute right-2 top-1/2 hidden -translate-y-1/2 rounded border border-hair px-1 text-[10px] text-faint sm:block">
                /
              </kbd>
            )}
          </div>

          <select
            value={periodKey}
            onChange={(e) => changePeriod(e.target.value)}
            className="h-8 rounded-lg border border-hair bg-transparent px-2 text-sm text-muted-foreground outline-none focus-visible:border-evergreen focus-visible:ring-2 focus-visible:ring-evergreen/20"
          >
            {periods.map((p) => (
              <option key={p.key} value={p.key}>
                {p.label}
              </option>
            ))}
          </select>

          {filtersActive && (
            <button
              type="button"
              onClick={resetAll}
              className="ml-auto text-xs text-faint hover:text-evergreen"
            >
              Clear filters
            </button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <Chip active={type === "all"} onClick={() => changeType("all")}>
            All <span className="tabular-nums opacity-60">{rows.length}</span>
          </Chip>
          {typeChips.map((t) => (
            <Chip key={t.label} active={type === t.label} onClick={() => changeType(t.label)}>
              {t.label} <span className="tabular-nums opacity-60">{t.n}</span>
            </Chip>
          ))}
        </div>
      </div>

      {sorted.length === 0 ? (
        <p className="py-12 text-center text-sm text-faint">
          No transactions match the current filters.
        </p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-hair text-[11px] font-medium uppercase tracking-[0.06em] text-faint">
              <SortTh onClick={() => toggleSort("date")} active={sortKey === "date"} dir={sortDir} className="text-left">
                Date
              </SortTh>
              <SortTh onClick={() => toggleSort("type")} active={sortKey === "type"} dir={sortDir} className="text-left">
                Type
              </SortTh>
              <SortTh onClick={() => toggleSort("name")} active={sortKey === "name"} dir={sortDir} className="text-left">
                Name
              </SortTh>
              <th className="py-2 text-left font-medium">Posting</th>
              <SortTh onClick={() => toggleSort("amount")} active={sortKey === "amount"} dir={sortDir} className="text-right">
                Amount
              </SortTh>
              <th className="w-8 py-2" aria-label="Edit" />
            </tr>
          </thead>
          <tbody>
            {pageRows.map((t) => {
              const dir = rowDirection(t);
              return (
                <tr key={t.id} className="border-b border-hair/60 align-top">
                  <td className="whitespace-nowrap py-3 pr-3 text-muted-foreground">
                    {fmtDate(t.txnDate)}
                  </td>
                  <td className="whitespace-nowrap py-3 pr-3 text-xs text-faint">
                    {rowType(t)}
                  </td>
                  <td className="max-w-xs py-3 pr-3">
                    <div className="truncate">{t.name || "—"}</div>
                    {t.memo && <div className="truncate text-xs text-faint">{t.memo}</div>}
                    {t.docNum && (
                      <div className="text-[11px] text-faint">#{t.docNum}</div>
                    )}
                  </td>
                  <td className="py-3 pr-3 text-xs">
                    {t.lines.map((l, i) => (
                      <div key={i} className="flex justify-between gap-3">
                        <Link
                          href={`/ledger/${entityId}/gl/${l.qboAccountId}`}
                          className="text-muted-foreground hover:text-evergreen hover:underline"
                        >
                          {l.accountName}
                        </Link>
                        <span className="text-faint">
                          {l.debitCents ? (
                            <>Dr <Money cents={l.debitCents} className="text-xs" /></>
                          ) : (
                            <>Cr <Money cents={l.creditCents} className="text-xs" /></>
                          )}
                        </span>
                      </div>
                    ))}
                  </td>
                  <td className="py-3 text-right">
                    {dir === "in" ? (
                      <Money cents={t.totalCents} tone="pos" sign />
                    ) : dir === "out" ? (
                      <Money cents={-t.totalCents} tone="neg" />
                    ) : (
                      <Money cents={t.totalCents} />
                    )}
                  </td>
                  <td className="py-3 pl-1 text-right">
                    <EditTransactionButton
                      entityId={entityId}
                      entryId={t.id}
                      edited={!!t.editedAt}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {/* Footer: range · pagination · money in/out · cap notice */}
      <div className="space-y-2 pt-1">
        <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-faint">
          <span>
            {sorted.length === 0
              ? "No transactions"
              : `${firstIdx}–${lastIdx} of ${sorted.length}`}
            {filtersActive ? ` (filtered from ${rows.length})` : ""}
          </span>
          <span className="flex items-center gap-3">
            <span>
              In <Money cents={totals.cashIn} tone="pos" />
            </span>
            <span>
              Out <Money cents={totals.cashOut} tone="neg" />
            </span>
          </span>
        </div>

        {pageCount > 1 && (
          <div className="flex items-center justify-center gap-2 text-sm">
            <PageBtn disabled={clampedPage === 0} onClick={() => setPage(clampedPage - 1)}>
              ← Prev
            </PageBtn>
            <span className="px-1 text-xs text-faint">
              Page {clampedPage + 1} of {pageCount}
            </span>
            <PageBtn
              disabled={clampedPage >= pageCount - 1}
              onClick={() => setPage(clampedPage + 1)}
            >
              Next →
            </PageBtn>
          </div>
        )}

        {capped && (
          <p className="text-center text-[11px] text-faint">
            Showing the {rows.length.toLocaleString()} most recent of{" "}
            {totalCount.toLocaleString()} transactions.
          </p>
        )}
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

function PageBtn({
  disabled,
  onClick,
  children,
}: {
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "rounded-lg border border-hair px-2.5 py-1 text-xs transition-colors",
        disabled
          ? "cursor-not-allowed text-faint opacity-50"
          : "text-muted-foreground hover:border-evergreen/40 hover:text-evergreen"
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
