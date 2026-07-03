"use client";

import { useEffect, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import {
  diagnoseBalanceHealth,
  deleteOpeningEntry,
  deleteAllFlaggedOpeningEntries,
  type BalanceHealthResult,
  type OpeningEntryIssue,
} from "@/lib/ledger/balance-health";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmt(cents: number) {
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

function fmtDate(iso: string) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("en-US", {
      month: "short", day: "numeric", year: "numeric", timeZone: "UTC",
    });
  } catch {
    return iso;
  }
}

function pct(f: number) {
  return `${Math.round(f * 100)}%`;
}

// ---------------------------------------------------------------------------
// Issue row
// ---------------------------------------------------------------------------

function IssueRow({
  entityId,
  issue,
  onFixed,
  disabled,
}: {
  entityId: string;
  issue: OpeningEntryIssue;
  onFixed: () => void;
  disabled: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  function handleDelete() {
    setError(null);
    startTransition(async () => {
      const r = await deleteOpeningEntry(entityId, issue.entryId);
      if (r.ok) {
        onFixed();
      } else {
        setError(r.error ?? "Failed to delete entry.");
      }
    });
  }

  const isDelete = issue.recommendation === "delete";
  const allAccounts = [...issue.doubledAccounts, ...issue.otherAccounts];

  return (
    <div className={`rounded-lg border p-4 space-y-3 ${
      isDelete
        ? "border-amber-200 bg-amber-50/40 dark:border-amber-800/40 dark:bg-amber-900/10"
        : "border-yellow-200 bg-yellow-50/40 dark:border-yellow-800/40 dark:bg-yellow-900/10"
    }`}>
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-0.5">
          <p className="text-sm font-medium leading-snug">{issue.entryName}</p>
          <p className="text-xs text-muted-foreground">
            Posted {fmtDate(issue.txnDate)} · {issue.doubledAccounts.length} of {allAccounts.length} accounts doubled
            {" "}({pct(issue.confidenceFraction)} of dollars)
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {isDelete ? (
            <Button
              size="sm"
              variant="destructive"
              onClick={handleDelete}
              disabled={disabled || pending}
            >
              {pending ? "Deleting…" : "Delete entry"}
            </Button>
          ) : (
            <span className="rounded-full bg-yellow-100 px-2.5 py-0.5 text-xs font-medium text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300">
              Review
            </span>
          )}
        </div>
      </div>

      {/* Account detail table */}
      <button
        type="button"
        className="text-xs text-muted-foreground hover:text-foreground"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? "Hide" : "Show"} account breakdown
      </button>

      {expanded && (
        <div className="overflow-hidden rounded-md border border-border">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border bg-muted/40">
                <th className="py-1.5 pl-3 text-left font-medium text-muted-foreground">Account</th>
                <th className="py-1.5 text-right font-medium text-muted-foreground">Opening</th>
                <th className="py-1.5 text-right font-medium text-muted-foreground">Current</th>
                <th className="py-1.5 pr-3 text-right font-medium text-muted-foreground">Ratio</th>
              </tr>
            </thead>
            <tbody>
              {allAccounts.map((acct) => {
                const isDoubled = issue.doubledAccounts.includes(acct);
                return (
                  <tr
                    key={acct.accountName}
                    className={`border-b border-hair last:border-0 ${
                      isDoubled ? "text-amber-800 dark:text-amber-300" : "text-muted-foreground"
                    }`}
                  >
                    <td className="py-1.5 pl-3">
                      {acct.accountName}
                      {isDoubled && (
                        <span className="ml-1.5 rounded-sm bg-amber-100 px-1 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
                          doubled
                        </span>
                      )}
                    </td>
                    <td className="py-1.5 text-right tabular-nums">{fmt(acct.openingCents)}</td>
                    <td className="py-1.5 text-right tabular-nums">{fmt(acct.currentCents)}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums font-mono">
                      {acct.ratio.toFixed(2)}×
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main panel — loads diagnosis on mount, re-runs after each fix
// ---------------------------------------------------------------------------

export function BalanceHealthPanel({ entityId }: { entityId: string }) {
  const [result, setResult] = useState<BalanceHealthResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [fixAllPending, startFixAll] = useTransition();
  const [fixAllError, setFixAllError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  async function runDiagnosis() {
    setLoading(true);
    setSuccessMsg(null);
    const r = await diagnoseBalanceHealth(entityId);
    setResult(r);
    setLoading(false);
  }

  // Initial load: fetch-then-set only — `loading` already starts true, so no
  // synchronous setState is needed inside the effect (event handlers use
  // runDiagnosis, which also flips the spinner back on).
  useEffect(() => {
    let cancelled = false;
    diagnoseBalanceHealth(entityId).then((r) => {
      if (cancelled) return;
      setResult(r);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [entityId]);

  function handleFixed() {
    // Removed one issue — re-run the diagnosis
    runDiagnosis();
    setSuccessMsg("Opening entry deleted. Balances updated.");
  }

  function handleFixAll() {
    setFixAllError(null);
    startFixAll(async () => {
      const r = await deleteAllFlaggedOpeningEntries(entityId);
      if (r.ok) {
        setSuccessMsg(
          `Deleted ${r.deleted} opening entr${r.deleted === 1 ? "y" : "ies"}. Balances are now correct.`
        );
        runDiagnosis();
      } else {
        setFixAllError(r.error ?? "Fix all failed.");
      }
    });
  }

  // Don't render anything until we have a result
  if (loading) {
    return (
      <div className="rounded-xl border border-border p-4">
        <p className="text-sm text-muted-foreground animate-pulse">Running balance health check…</p>
      </div>
    );
  }
  if (!result) return null;

  const deleteCount = result.issues.filter((i) => i.recommendation === "delete").length;

  // Clean bill of health — render a subtle green checkmark, not nothing
  if (!result.hasIssues && result.issues.length === 0) {
    if (successMsg) {
      return (
        <div className="rounded-xl border border-green-200 bg-green-50/40 dark:border-green-800/40 dark:bg-green-900/10 p-4">
          <p className="text-sm font-medium text-green-800 dark:text-green-300">{successMsg}</p>
          <p className="mt-0.5 text-xs text-green-700/80 dark:text-green-400/80">Balance sheet looks clean — no double-counting detected.</p>
        </div>
      );
    }
    return null; // No issues at all on fresh load — don't clutter the page
  }

  return (
    <div className="space-y-4 rounded-xl border border-amber-200 bg-amber-50/20 dark:border-amber-800/40 dark:bg-amber-900/5 p-5">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-amber-600 dark:text-amber-400">
              {/* warning icon */}
              <svg className="h-4 w-4" viewBox="0 0 16 16" fill="currentColor">
                <path d="M8 1.333A6.667 6.667 0 1 0 8 14.667 6.667 6.667 0 0 0 8 1.333zm0 10a.667.667 0 1 1 0-1.333.667.667 0 0 1 0 1.333zM7.333 5.333h1.334v4H7.333v-4z"/>
              </svg>
            </span>
            <h3 className="text-sm font-semibold">Balance Health Check</h3>
          </div>
          <p className="mt-1 text-xs text-muted-foreground max-w-prose">{result.summary}</p>
        </div>

        {deleteCount > 1 && (
          <Button
            size="sm"
            variant="destructive"
            onClick={handleFixAll}
            disabled={fixAllPending}
            className="shrink-0"
          >
            {fixAllPending ? "Fixing…" : `Fix all (${deleteCount})`}
          </Button>
        )}
      </div>

      {successMsg && (
        <div className="rounded-lg border border-green-200 bg-green-50/50 dark:border-green-800/40 dark:bg-green-900/10 p-3">
          <p className="text-sm font-medium text-green-800 dark:text-green-300">{successMsg}</p>
        </div>
      )}

      {fixAllError && <p className="text-sm text-destructive">{fixAllError}</p>}

      {/* One row per problematic opening entry */}
      {result.issues.map((issue) => (
        <IssueRow
          key={issue.entryId}
          entityId={entityId}
          issue={issue}
          onFixed={handleFixed}
          disabled={fixAllPending}
        />
      ))}
    </div>
  );
}
