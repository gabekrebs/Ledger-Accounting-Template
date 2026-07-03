"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  ReviewRow,
  type ReviewTxn,
  type PostableAccount,
  type RowSuggestion,
  type MatchedRule,
} from "./review-row";
import { AutoCategorizeButton } from "./auto-categorize-button";
import { suggestCategoriesAction, ignoreAlreadyBooked } from "./actions";
import { Button } from "@/components/ui/button";

export type ReviewListRow = {
  txn: ReviewTxn;
  mappedReady: boolean;
  matchedRule?: MatchedRule;
  reviewReason?: string | null;
  merchantKey?: string;
};
export type InitialSuggestion = { txnId: string } & RowSuggestion;

/**
 * Client island for the review inbox. Owns the on-demand category SUGGESTIONS
 * (Phase 2): the "Suggest categories" button calls the action (free history
 * pre-pass + Haiku for the rest) and pre-fills each row's dropdown. The
 * "Auto-categorize" button (Phase 1) auto-posts unanimous history matches.
 * Both write through server actions that revalidate the page.
 */
export function ReviewList({
  entityId,
  rows,
  accounts,
  pendingLabel,
  hiddenBooked,
  initialSuggestions = [],
  knownPayees = [],
}: {
  entityId: string;
  rows: ReviewListRow[];
  accounts: PostableAccount[];
  pendingLabel: string;
  hiddenBooked: number;
  initialSuggestions?: InitialSuggestion[];
  /** Vendor names already in the books — autocomplete for each row's payee field. */
  knownPayees?: string[];
}) {
  // Seed from persisted suggestions (the "Suggest categories" button or the
  // batch job wrote these); the button re-runs and replaces them live.
  const [suggestions, setSuggestions] = useState<Map<string, RowSuggestion>>(
    () =>
      new Map(
        initialSuggestions.map((s) => [
          s.txnId,
          {
            accountId: s.accountId,
            confidence: s.confidence,
            reasoning: s.reasoning,
            source: s.source,
          },
        ])
      )
  );
  const [loading, start] = useTransition();
  const [ignoring, startIgnore] = useTransition();
  const router = useRouter();

  // Rows flagged "already in QuickBooks/Wave" (near-matches, Post disabled) —
  // resolvable in one click instead of one Ignore per row.
  const flaggedBooked = rows.filter((r) => r.txn.alreadyBooked).length;

  function ignoreBooked() {
    startIgnore(async () => {
      const { ignored } = await ignoreAlreadyBooked(entityId);
      if (ignored) {
        toast.success(
          `Ignored ${ignored} transaction${ignored === 1 ? "" : "s"} already in the books`
        );
      } else {
        toast.info("Nothing flagged as already booked");
      }
      router.refresh();
    });
  }

  // Auto-run suggestions once on load: the moment the inbox opens, pre-fill every
  // row history or Haiku can categorize, so the common case needs zero clicks.
  // Idempotent + cheap: suggestions persist, so a row keeps its fill across loads;
  // we only fire when something is still un-suggested, and only once per mount.
  const autoRan = useRef(false);
  useEffect(() => {
    if (autoRan.current || loading) return;
    const anyUnsuggested = rows.some((r) => !suggestions.has(r.txn.id));
    if (rows.length === 0 || !anyUnsuggested) return;
    autoRan.current = true;
    suggest(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function suggest(silent = false) {
    start(async () => {
      const res = await suggestCategoriesAction(entityId);
      if (res.error) toast.error(res.error);
      const m = new Map<string, RowSuggestion>();
      for (const s of res.suggestions) {
        m.set(s.txnId, {
          accountId: s.accountId,
          confidence: s.confidence,
          reasoning: s.reasoning,
          source: s.source,
        });
      }
      setSuggestions(m);
      if (!res.error && !silent) {
        toast[res.suggestions.length ? "success" : "info"](
          res.suggestions.length
            ? `Pre-filled ${res.suggestions.length} suggestion${res.suggestions.length === 1 ? "" : "s"}`
            : "No confident suggestions — categorize manually"
        );
      }
    });
  }

  // One shared <datalist> for every row's vendor field — known names, most-used
  // first, so a payee is one keystroke and spelled consistently.
  const payeeListId = `known-payees-${entityId}`;

  return (
    <section className="space-y-3">
      <datalist id={payeeListId}>
        {knownPayees.map((p) => (
          <option key={p} value={p} />
        ))}
      </datalist>
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-[11px] font-medium uppercase tracking-[0.06em] text-faint">
          Transactions awaiting review
        </h3>
        <div className="flex items-center gap-3">
          <span className="text-xs text-faint">
            {hiddenBooked > 0 && (
              <span className="mr-2">
                {hiddenBooked} already in QuickBooks/Wave (hidden)
              </span>
            )}
            {pendingLabel}
          </span>
          {flaggedBooked > 0 && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={ignoreBooked}
              disabled={ignoring}
            >
              {ignoring
                ? "Ignoring…"
                : `Ignore ${flaggedBooked} already-booked`}
            </Button>
          )}
          <AutoCategorizeButton entityId={entityId} />
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => suggest()}
            disabled={loading || rows.length === 0}
          >
            {loading ? "Suggesting…" : "Suggest categories"}
          </Button>
        </div>
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-hair text-[11px] font-medium uppercase tracking-[0.06em] text-faint">
            <th className="py-2 text-left font-medium">Date</th>
            <th className="py-2 text-left font-medium">Vendor / payee</th>
            <th className="py-2 text-left font-medium">Plaid category</th>
            <th className="py-2 text-right font-medium">Amount</th>
            <th className="py-2 text-right font-medium">Categorize</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <ReviewRow
              key={r.txn.id}
              entityId={entityId}
              txn={r.txn}
              accounts={accounts}
              mappedReady={r.mappedReady}
              suggestion={suggestions.get(r.txn.id)}
              matchedRule={r.matchedRule}
              reviewReason={r.reviewReason}
              merchantKey={r.merchantKey}
              payeeListId={payeeListId}
            />
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={5} className="py-8 text-center text-muted-foreground">
                Nothing to review. Click <span className="font-medium">Sync now</span>{" "}
                to pull the latest, or you&apos;ve categorized everything.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      <p className="text-xs text-faint">
        Posting writes a balanced journal entry — the bank account you mapped on
        one side, the category you pick on the other — into the ledger. The
        vendor field is editable: clean up the bank&apos;s descriptor or pick a
        known vendor, and that name is what the books carry. Use{" "}
        <span className="font-medium">Split</span> to post a multi-line entry
        instead: gross up an owner payout (gross income less management, cleaning,
        and expenses) or split one bank line across several categories.
      </p>
    </section>
  );
}
