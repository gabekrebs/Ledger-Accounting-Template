"use client";

import { useMemo, useState, useTransition } from "react";
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
import {
  suggestCategoriesAction,
  ignoreAlreadyBooked,
  postSuggestedBulk,
} from "./actions";
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
 * Client island for the review inbox, organized as a TIERED fast-review
 * (ADR-021): high-confidence suggestions grouped at the top behind one
 * "Accept all" button, medium behind per-row checkboxes + "Post selected",
 * and everything else (weak/no suggestion, unmapped, already-booked) at the
 * bottom for individual attention. Persisted suggestions (the nightly Batch-API
 * job) pre-fill rows; a fresh AI run is an explicit owner-only button, never
 * fired on page load. Every posting path is a server action that re-validates
 * against the persisted suggestion server-side.
 */
export function ReviewList({
  entityId,
  rows,
  accounts,
  pendingLabel,
  initialSuggestions = [],
  knownPayees = [],
  readOnly = false,
  canRunAi = false,
}: {
  entityId: string;
  rows: ReviewListRow[];
  accounts: PostableAccount[];
  pendingLabel: string;
  initialSuggestions?: InitialSuggestion[];
  /** Vendor names already in the books — autocomplete for each row's payee field. */
  knownPayees?: string[];
  /** Read-only viewer: render the queue with no write controls at all. */
  readOnly?: boolean;
  /** Owner only: shows the "Suggest categories" (AI-spend) button. */
  canRunAi?: boolean;
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
            calibrated: s.calibrated,
            suggestedPayee: s.suggestedPayee,
          },
        ])
      )
  );
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, start] = useTransition();
  const [ignoring, startIgnore] = useTransition();
  const [bulkPosting, startBulk] = useTransition();
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

  function suggest() {
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
          // A live run returns RAW confidence; the calibrated display comes
          // back on the next server render from the persisted store.
          calibrated: false,
          suggestedPayee: s.suggestedPayee,
        });
      }
      setSuggestions(m);
      if (!res.error) {
        toast[res.suggestions.length ? "success" : "info"](
          res.suggestions.length
            ? `Pre-filled ${res.suggestions.length} suggestion${res.suggestions.length === 1 ? "" : "s"}`
            : "No confident suggestions — categorize manually"
        );
      }
    });
  }

  // ── Tiering ────────────────────────────────────────────────────────────────
  // High ≥90%, medium ≥60% (calibrated value when available), everything else —
  // plus anything not cleanly postable (unmapped, already-booked, or a legacy
  // bank-pending straggler) — needs individual attention. Bank-pending rows are
  // never stored by the sync; the !pending checks are a defensive leftover.
  const tiers = useMemo(() => {
    const high: ReviewListRow[] = [];
    const medium: ReviewListRow[] = [];
    const rest: ReviewListRow[] = [];
    for (const r of rows) {
      const s = suggestions.get(r.txn.id);
      const postable =
        r.mappedReady && !r.txn.pending && !r.txn.alreadyBooked && !!s;
      if (postable && s!.confidence >= 0.9) high.push(r);
      else if (postable && s!.confidence >= 0.6) medium.push(r);
      else rest.push(r);
    }
    return { high, medium, rest };
  }, [rows, suggestions]);

  function bulkPost(txnIds: string[], label: string) {
    if (!txnIds.length) return;
    startBulk(async () => {
      const res = await postSuggestedBulk(entityId, txnIds);
      if (res.posted) toast.success(`Posted ${res.posted} ${label}`);
      if (res.errors) toast.error(`${res.errors} failed — see the rows left behind`);
      if (!res.posted && !res.errors) toast.info("Nothing was postable");
      setSelected(new Set());
      router.refresh();
    });
  }

  const toggleSelect = (txnId: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(txnId)) next.delete(txnId);
      else next.add(txnId);
      return next;
    });

  // One shared <datalist> for every row's vendor field — known names, most-used
  // first, so a payee is one keystroke and spelled consistently.
  const payeeListId = `known-payees-${entityId}`;

  const header = (withCheckbox: boolean) => (
    <thead className="max-sm:hidden">
      <tr className="border-b border-hair text-[11px] font-medium uppercase tracking-[0.06em] text-faint">
        {withCheckbox && <th className="w-6 py-2" />}
        <th className="py-2 text-left font-medium">Date</th>
        <th className="py-2 pr-2 text-left font-medium">Account</th>
        <th className="py-2 text-left font-medium">Vendor / payee</th>
        <th className="py-2 text-left font-medium">Plaid category</th>
        <th className="py-2 text-right font-medium">Amount</th>
        <th className="py-2 text-right font-medium">Categorize</th>
      </tr>
    </thead>
  );

  const renderRow = (r: ReviewListRow, selectable = false) => (
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
      readOnly={readOnly}
      selectable={selectable && !readOnly}
      selected={selected.has(r.txn.id)}
      onToggleSelect={toggleSelect}
    />
  );

  const selectedInMedium = tiers.medium.filter((r) => selected.has(r.txn.id));

  return (
    <section className="space-y-3">
      <datalist id={payeeListId}>
        {knownPayees.map((p) => (
          <option key={p} value={p} />
        ))}
      </datalist>
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h3 className="text-[11px] font-medium uppercase tracking-[0.06em] text-faint">
          Transactions awaiting review
        </h3>
        <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-2">
          <span className="text-xs text-faint">{pendingLabel}</span>
          {!readOnly && flaggedBooked > 0 && (
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
          {!readOnly && <AutoCategorizeButton entityId={entityId} />}
          {/* AI spend — owner only; an explicit click, never fired on load. */}
          {!readOnly && canRunAi && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => suggest()}
              disabled={loading || rows.length === 0}
            >
              {loading ? "Suggesting…" : "Suggest categories"}
            </Button>
          )}
        </div>
      </div>

      {rows.length === 0 && (
        <div className="py-8 text-center text-sm text-muted-foreground">
          Nothing to review — new bank activity lands here automatically after
          each sync.
        </div>
      )}

      {tiers.high.length > 0 && (
        <div className="space-y-1">
          <div className="flex items-baseline justify-between gap-3 pt-1">
            <h4 className="text-[11px] font-medium uppercase tracking-[0.06em] text-evergreen">
              High confidence · {tiers.high.length}
            </h4>
            {!readOnly && (
              <Button
                type="button"
                size="sm"
                onClick={() =>
                  bulkPost(
                    tiers.high.map((r) => r.txn.id),
                    "high-confidence suggestions"
                  )
                }
                disabled={bulkPosting}
              >
                {bulkPosting ? "Posting…" : `Accept all ${tiers.high.length}`}
              </Button>
            )}
          </div>
          <table className="w-full text-sm max-sm:block">
            {header(false)}
            <tbody className="max-sm:block">{tiers.high.map((r) => renderRow(r))}</tbody>
          </table>
        </div>
      )}

      {tiers.medium.length > 0 && (
        <div className="space-y-1">
          <div className="flex items-baseline justify-between gap-3 pt-2">
            <h4 className="text-[11px] font-medium uppercase tracking-[0.06em] text-faint">
              Medium confidence · {tiers.medium.length}
            </h4>
            {!readOnly && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  bulkPost(
                    selectedInMedium.map((r) => r.txn.id),
                    "selected suggestions"
                  )
                }
                disabled={bulkPosting || selectedInMedium.length === 0}
              >
                {bulkPosting
                  ? "Posting…"
                  : `Post selected (${selectedInMedium.length})`}
              </Button>
            )}
          </div>
          <table className="w-full text-sm max-sm:block">
            {header(!readOnly)}
            <tbody className="max-sm:block">{tiers.medium.map((r) => renderRow(r, true))}</tbody>
          </table>
        </div>
      )}

      {tiers.rest.length > 0 && (
        <div className="space-y-1">
          {(tiers.high.length > 0 || tiers.medium.length > 0) && (
            <h4 className="pt-2 text-[11px] font-medium uppercase tracking-[0.06em] text-faint">
              Needs attention · {tiers.rest.length}
            </h4>
          )}
          <table className="w-full text-sm max-sm:block">
            {header(false)}
            <tbody className="max-sm:block">{tiers.rest.map((r) => renderRow(r))}</tbody>
          </table>
        </div>
      )}
    </section>
  );
}
