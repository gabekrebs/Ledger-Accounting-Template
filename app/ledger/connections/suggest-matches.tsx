"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { suggestMappings, applySuggestion } from "./actions";
import type { MappingSuggestion } from "@/lib/plaid/suggest";

/**
 * AI matching panel. Whenever there are UNASSIGNED Plaid accounts, this runs
 * automatically (once, on mount — i.e. right after you link a bank, since the
 * connect flow lands back here) and asks Opus 4.8 to propose which business +
 * ledger account each one belongs to. The user confirms each with one click.
 *
 * Why auto-run HERE and not in the connect/exchange route: the model call takes
 * a few seconds, so running it inside Plaid Link's success handler would stall
 * the modal. Running it on this page is non-blocking — the page paints instantly
 * and suggestions fill in a moment later. It only fires while unassigned
 * accounts exist (they vanish as you confirm), so it's naturally self-limiting.
 *
 * Confirm-first by design: it only PROPOSES; nothing is written until the user
 * clicks Confirm (same write path as the manual dropdown).
 */
export function SuggestMatches({ hasUnassigned }: { hasUnassigned: boolean }) {
  const [suggestions, setSuggestions] = useState<MappingSuggestion[] | null>(
    null
  );
  const [loading, startLoad] = useTransition();
  const [applyingId, setApplyingId] = useState<string | null>(null);
  const [, startApply] = useTransition();
  const didAuto = useRef(false);

  const run = useCallback(() => {
    startLoad(async () => {
      const res = await suggestMappings();
      if (res.error) toast.error(res.error);
      setSuggestions(res.suggestions);
      if (!res.error && res.suggestions.length === 0) {
        toast.info("No confident matches — assign the accounts manually below.");
      }
    });
  }, []);

  // Auto-run once on mount when there's anything to match.
  useEffect(() => {
    if (didAuto.current || !hasUnassigned) return;
    didAuto.current = true;
    run();
  }, [hasUnassigned, run]);

  if (!hasUnassigned) return null;

  function confirm(s: MappingSuggestion) {
    setApplyingId(s.plaidAccountRowId);
    startApply(async () => {
      try {
        await applySuggestion(s.plaidAccountRowId, s.entityId, s.accountId);
        setSuggestions((prev) =>
          (prev ?? []).filter((x) => x.plaidAccountRowId !== s.plaidAccountRowId)
        );
        toast.success(`Linked ${s.plaidLabel} → ${s.accountLabel}`);
      } catch {
        toast.error("Couldn't apply that match — try the dropdown below.");
      } finally {
        setApplyingId(null);
      }
    });
  }

  function dismiss(rowId: string) {
    setSuggestions((prev) => (prev ?? []).filter((x) => x.plaidAccountRowId !== rowId));
  }

  const hasResults = suggestions !== null && suggestions.length > 0;

  return (
    <div className="rounded-lg border border-hair bg-paper/60 p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="font-medium">
            Suggested matches
            {loading && (
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                analyzing…
              </span>
            )}
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Opus 4.8 reads each account&apos;s name, last-four, type, and recent
            transactions to propose the right business and ledger account. Confirm
            each one, or assign manually below.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={run}
          disabled={loading}
          className="shrink-0"
        >
          {loading ? "Analyzing…" : "Re-run"}
        </Button>
      </div>

      {hasResults && (
        <div className="mt-4 space-y-2">
          {suggestions!.map((s) => (
            <SuggestionRow
              key={s.plaidAccountRowId}
              s={s}
              applying={applyingId === s.plaidAccountRowId}
              onConfirm={() => confirm(s)}
              onDismiss={() => dismiss(s.plaidAccountRowId)}
            />
          ))}
        </div>
      )}

      {/* First run, nothing yet: a quiet placeholder so the panel isn't empty. */}
      {loading && suggestions === null && (
        <div className="mt-4 text-xs text-faint">
          Matching your accounts to the right businesses…
        </div>
      )}
    </div>
  );
}

function confidenceChip(conf: number): { label: string; cls: string } {
  const pct = Math.round(conf * 100);
  if (conf >= 0.85) return { label: `High · ${pct}%`, cls: "text-evergreen" };
  if (conf >= 0.6)
    return { label: `Medium · ${pct}%`, cls: "text-muted-foreground" };
  return { label: `Low · ${pct}%`, cls: "text-oxblood" };
}

function SuggestionRow({
  s,
  applying,
  onConfirm,
  onDismiss,
}: {
  s: MappingSuggestion;
  applying: boolean;
  onConfirm: () => void;
  onDismiss: () => void;
}) {
  const chip = confidenceChip(s.confidence);
  return (
    <div className="flex items-start justify-between gap-3 rounded border border-hair/60 bg-background px-3 py-2 text-sm">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-x-2">
          <span className="font-medium">{s.plaidLabel}</span>
          <span className="text-faint">→</span>
          <span>
            {s.entityName ?? "?"} · {s.accountLabel}
          </span>
          <span className={`text-xs ${chip.cls}`}>{chip.label}</span>
        </div>
        {s.reasoning && (
          <div className="mt-0.5 text-xs text-muted-foreground">{s.reasoning}</div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button size="sm" onClick={onConfirm} disabled={applying}>
          {applying ? "Linking…" : "Confirm"}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={onDismiss}
          disabled={applying}
        >
          Dismiss
        </Button>
      </div>
    </div>
  );
}
