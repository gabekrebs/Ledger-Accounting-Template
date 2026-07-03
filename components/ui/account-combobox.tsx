"use client";

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { cn } from "@/lib/utils";

export type ComboAccount = {
  id: string;
  label: string;
  classification: string | null;
};

// Grouped by classification, leading with the side that matches the money's
// direction (deposit → Income first, spend → Expenses first) — a flat
// alphabetical dump buries the handful of income accounts among ~90 entries.
const GROUP_LABEL: Record<string, string> = {
  revenue: "Income",
  expense: "Expenses",
  asset: "Assets",
  liability: "Liabilities",
  equity: "Equity",
};
const INFLOW_ORDER = ["revenue", "asset", "equity", "liability", "expense"];
const OUTFLOW_ORDER = ["expense", "asset", "liability", "equity", "revenue"];

type Group = { key: string; label: string; accounts: ComboAccount[] };

function groupAccounts(accounts: ComboAccount[], inflow: boolean): Group[] {
  const order = inflow ? INFLOW_ORDER : OUTFLOW_ORDER;
  const groups = order
    .map((key) => ({
      key,
      label: GROUP_LABEL[key],
      accounts: accounts.filter((a) => a.classification === key),
    }))
    .filter((g) => g.accounts.length > 0);
  const other = accounts.filter((a) => !order.includes(a.classification ?? ""));
  if (other.length > 0) groups.push({ key: "other", label: "Other", accounts: other });
  return groups;
}

/**
 * Searchable account picker — replaces the native <select> over the whole
 * chart of accounts. Click (or focus + Enter) opens a panel with a filter
 * box; type a few letters of the account name, arrow/Enter to pick.
 * Matching is per-word ("rep main" finds "Repairs & Maintenance").
 */
export function AccountCombobox({
  accounts,
  inflow,
  value,
  onChange,
  disabled,
  placeholder = "Choose category…",
  className,
}: {
  accounts: ComboAccount[];
  inflow: boolean;
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  // Anchor the panel to whichever edge keeps it on-screen.
  const [alignRight, setAlignRight] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const selected = useMemo(
    () => accounts.find((a) => a.id === value) ?? null,
    [accounts, value]
  );

  const groups = useMemo(() => {
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
    const pool = tokens.length
      ? accounts.filter((a) => {
          const hay = a.label.toLowerCase();
          return tokens.every((t) => hay.includes(t));
        })
      : accounts;
    return groupAccounts(pool, inflow);
  }, [accounts, inflow, query]);
  const flat = useMemo(() => groups.flatMap((g) => g.accounts), [groups]);
  // Keep the keyboard cursor in range as the filter narrows — derived during
  // render (clamping `active` in an effect just caused a cascading re-render).
  const activeIdx = Math.min(active, Math.max(0, flat.length - 1));

  // Opening resets the filter state — done in the event, not an effect.
  function openPanel() {
    setQuery("");
    setActive(0);
    setOpen(true);
  }

  // Focus the filter box each time the panel opens (DOM side effect only).
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => searchRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [open]);

  // Close on any press outside the component.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  // Flip the panel to right-anchored when it would spill past the viewport.
  useLayoutEffect(() => {
    if (!open || !rootRef.current) return;
    const r = rootRef.current.getBoundingClientRect();
    setAlignRight(r.left + PANEL_W > window.innerWidth - 8);
  }, [open]);

  // Keep the active row visible while arrowing through the list.
  useEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelector(`[data-idx="${activeIdx}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIdx, open]);

  function pick(id: string) {
    onChange(id);
    setOpen(false);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive(Math.min(activeIdx + 1, flat.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive(Math.max(activeIdx - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const hit = flat[activeIdx];
      if (hit) pick(hit.id);
    } else if (e.key === "Escape" || e.key === "Tab") {
      setOpen(false);
    }
  }

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openPanel())}
        onKeyDown={(e) => {
          if (!open && (e.key === "ArrowDown" || e.key === "Enter")) {
            e.preventDefault();
            openPanel();
          }
        }}
        className={cn(
          "flex w-full items-center justify-between gap-1 rounded border border-hair bg-transparent px-2 py-1 text-left text-xs",
          "disabled:opacity-50",
          !selected && "text-faint"
        )}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="truncate">{selected ? selected.label : placeholder}</span>
        <svg
          className="size-3 shrink-0 text-faint"
          viewBox="0 0 12 12"
          fill="none"
          aria-hidden
        >
          <path
            d="M3 4.5 6 7.5 9 4.5"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      {open && (
        <div
          className={cn(
            "absolute z-50 mt-1 w-72 rounded-md border border-hair bg-popover shadow-lg",
            alignRight ? "right-0" : "left-0"
          )}
        >
          <div className="border-b border-hair p-1.5">
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
              onKeyDown={onKeyDown}
              placeholder="Type to filter accounts…"
              className="w-full rounded border border-hair bg-transparent px-2 py-1 text-xs outline-none"
            />
          </div>
          <div ref={listRef} role="listbox" className="max-h-64 overflow-auto p-1">
            {flat.length === 0 && (
              <div className="px-2 py-3 text-center text-xs text-faint">
                No account matches &ldquo;{query}&rdquo;
              </div>
            )}
            {groups.map((g) => (
              <div key={g.key}>
                <div className="px-2 pb-0.5 pt-1.5 text-[10px] font-medium uppercase tracking-[0.06em] text-faint">
                  {g.label}
                </div>
                {g.accounts.map((a) => {
                  const idx = flat.indexOf(a);
                  const isActive = idx === activeIdx;
                  const isSelected = a.id === value;
                  return (
                    <button
                      key={a.id}
                      type="button"
                      data-idx={idx}
                      role="option"
                      aria-selected={isSelected}
                      onMouseEnter={() => setActive(idx)}
                      onClick={() => pick(a.id)}
                      className={cn(
                        "flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left text-xs",
                        isActive && "bg-paper",
                        isSelected && "font-medium"
                      )}
                    >
                      <span className="truncate">{a.label}</span>
                      {isSelected && <span className="text-evergreen">✓</span>}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// w-72 in px — used to decide which edge the panel anchors to.
const PANEL_W = 288;
