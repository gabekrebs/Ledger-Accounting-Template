"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { createHold, acknowledgeHold } from "./holds-actions";

/**
 * Heads-up holds on /review — "this exact amount / vendor is coming; keep it
 * in the queue". Deliberately phone-sized: one small form, one list. A hold
 * leaves the list ONLY via the owner's explicit check-off, so an expected
 * transaction that never arrived is still staring at you 30 days later.
 */

export interface HoldView {
  id: string;
  entityLabel: string;
  amountCents: number | null;
  amountMaxCents: number | null;
  vendorText: string | null;
  note: string | null;
  expiresAt: string; // ISO
  matchCount: number;
  lastMatchedAt: string | null;
}

const inputCls =
  "h-9 rounded-lg border border-hair bg-transparent px-2 text-sm outline-none focus-visible:border-evergreen focus-visible:ring-2 focus-visible:ring-evergreen/20 disabled:opacity-50";

function parseCents(s: string): number | null {
  const t = s.replace(/[$,\s]/g, "");
  if (!/^\d*\.?\d{0,2}$/.test(t) || t === "") return null;
  const n = Math.round(parseFloat(t) * 100);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * "250" → exact; "100-300", "100 - 300", "$100 – $300.50" → inclusive range.
 * Splits on hyphen/en-dash/em-dash with any surrounding whitespace; each side
 * then parses like a normal dollar figure. Returns null when unparseable.
 */
function parseAmountOrRange(
  s: string
): { min: number; max: number | null } | null {
  const trimmed = s.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(/\s*[-–—]\s*/);
  if (parts.length === 1) {
    const v = parseCents(parts[0]);
    return v == null ? null : { min: v, max: null };
  }
  if (parts.length === 2) {
    const lo = parseCents(parts[0]);
    const hi = parseCents(parts[1]);
    if (lo == null || hi == null || hi <= lo) return null;
    return { min: lo, max: hi };
  }
  return null;
}

const usd = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
const fmtD = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });

export function HoldsSection({
  entities,
  holds,
  nowIso,
}: {
  entities: { id: string; label: string }[];
  holds: HoldView[];
  /** Server-rendered clock — keeps render pure and hydration consistent. */
  nowIso: string;
}) {
  const [open, setOpen] = useState(false);
  const [entityId, setEntityId] = useState(entities[0]?.id ?? "");
  const [amount, setAmount] = useState("");
  const [vendor, setVendor] = useState("");
  const [note, setNote] = useState("");
  const [days, setDays] = useState(7);
  const [busy, start] = useTransition();

  const parsedAmount = parseAmountOrRange(amount);
  const canSave =
    !busy && !!entityId && ((amount.trim() === "" && vendor.trim() !== "") || parsedAmount !== null);

  function save() {
    start(async () => {
      const res = await createHold({
        entityId,
        amountCents: parsedAmount?.min ?? null,
        amountMaxCents: parsedAmount?.max ?? null,
        vendorText: vendor,
        note,
        days,
      });
      if (res.ok) {
        toast.success("Hold placed — matching transactions will wait in review");
        setAmount(""); setVendor(""); setNote(""); setOpen(false);
      } else toast.error(res.error ?? "Could not place hold");
    });
  }

  function ack(id: string) {
    start(async () => {
      const res = await acknowledgeHold(id);
      if (res.ok) toast.success("Hold closed");
      else toast.error(res.error ?? "Could not close hold");
    });
  }

  if (!open && holds.length === 0) {
    // Zero-footprint when unused: a single quiet affordance.
    return (
      <button
        onClick={() => setOpen(true)}
        className="mb-6 text-xs text-faint underline-offset-2 hover:text-muted-foreground hover:underline"
      >
        + Place a heads-up hold (keep an expected transaction in review)
      </button>
    );
  }

  const now = new Date(nowIso).getTime();
  return (
    <div className="mb-8 rounded-xl border border-hair bg-card p-5">
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <h2 className="font-serif text-lg font-medium">Heads-up holds</h2>
          <p className="mt-0.5 text-xs text-faint">
            A matching transaction skips all automation and waits here. Holds stay listed
            until you check them off — even after they stop intercepting.
          </p>
        </div>
        <button
          onClick={() => setOpen((v) => !v)}
          className="h-8 shrink-0 rounded-lg bg-evergreen px-3 text-sm font-medium text-white hover:bg-evergreen/90"
        >
          {open ? "Close" : "New hold"}
        </button>
      </div>

      {open && (
        <div className="mt-4 grid gap-3 rounded-xl border border-hair bg-[#FAF8F3] p-4 dark:bg-secondary sm:grid-cols-2">
          <label className="block space-y-1">
            <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-faint">Entity</span>
            <select className={`${inputCls} w-full`} value={entityId} onChange={(e) => setEntityId(e.target.value)} disabled={busy}>
              {entities.map((e) => (
                <option key={e.id} value={e.id}>{e.label}</option>
              ))}
            </select>
          </label>
          <label className="block space-y-1">
            <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-faint">Exact amount or range (optional)</span>
            <input placeholder="250 or 100-300" className={`${inputCls} w-full tabular-nums`} value={amount} onChange={(e) => setAmount(e.target.value)} disabled={busy} />
          </label>
          <label className="block space-y-1">
            <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-faint">Vendor contains (optional)</span>
            <input placeholder="e.g. Home Depot" className={`${inputCls} w-full`} value={vendor} onChange={(e) => setVendor(e.target.value)} disabled={busy} />
          </label>
          <label className="block space-y-1">
            <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-faint">Watch for (days)</span>
            <select className={`${inputCls} w-full`} value={days} onChange={(e) => setDays(Number(e.target.value))} disabled={busy}>
              {[7, 30].map((d) => (
                <option key={d} value={d}>{d} days</option>
              ))}
            </select>
          </label>
          <label className="block space-y-1 sm:col-span-2">
            <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-faint">Note (optional — shows here so future-you remembers why)</span>
            <input className={`${inputCls} w-full`} value={note} onChange={(e) => setNote(e.target.value)} disabled={busy} placeholder="e.g. contractor refund incoming" />
          </label>
          <div className="sm:col-span-2">
            <button onClick={save} disabled={!canSave} className="h-9 rounded-md bg-evergreen px-4 text-sm font-medium text-white hover:bg-evergreen/90 disabled:opacity-50">
              {busy ? "Placing…" : "Place hold"}
            </button>
          </div>
        </div>
      )}

      {holds.length > 0 && (
        <div className="mt-4 space-y-2">
          {holds.map((h) => {
            const expired = new Date(h.expiresAt).getTime() <= now;
            const matched = h.matchCount > 0;
            const pill = matched
              ? { cls: "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800/40 dark:bg-emerald-900/20 dark:text-emerald-300", label: `Matched ×${h.matchCount}` }
              : expired
                ? { cls: "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-800/40 dark:bg-amber-900/20 dark:text-amber-300", label: "Expired — never matched" }
                : { cls: "border-evergreen/40 bg-evergreen-soft text-evergreen", label: `Watching until ${fmtD(h.expiresAt)}` };
            return (
              <div key={h.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-hair px-3 py-2.5">
                <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${pill.cls}`}>
                  {pill.label}
                </span>
                <div className="min-w-0 flex-1 text-sm">
                  <span className="font-medium">{h.entityLabel}</span>
                  <span className="text-muted-foreground">
                    {" · "}
                    {[
                      h.amountCents != null
                        ? h.amountMaxCents != null
                          ? `${usd(h.amountCents)}–${usd(h.amountMaxCents)}`
                          : usd(h.amountCents)
                        : null,
                      h.vendorText ? `"${h.vendorText}"` : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                  {h.note && <div className="truncate text-xs text-faint">{h.note}</div>}
                </div>
                <button
                  onClick={() => ack(h.id)}
                  disabled={busy}
                  className="text-xs font-medium text-evergreen underline-offset-2 hover:underline disabled:opacity-50"
                >
                  {matched ? "Transaction found ✓" : expired ? "Resolved — I checked ✓" : "Cancel hold"}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
