"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  postTransaction,
  ignoreTransaction,
  applyRuleHere,
  applyRuleSimilar,
  applyRuleRetroReview,
} from "./actions";
import { EntryEditor } from "./entry-editor";
import { AccountCombobox } from "@/components/ui/account-combobox";
import { Money } from "@/components/money";
import { Button } from "@/components/ui/button";

export type ReviewTxn = {
  id: string;
  txnDate: string;
  name: string | null;
  merchantName: string | null;
  amountCents: number;
  category: string | null;
  pending: boolean;
  // Source bank account / card ("Checking ··1234") — which feed the line came from.
  accountLabel: string | null;
  // Set when this line is a near-match to a QBO/Wave-booked txn (exact matches
  // are hidden upstream). Blocks posting; Ignore is still allowed.
  alreadyBooked: { source: string; daysOff: number } | null;
};

export type PostableAccount = {
  id: string;
  label: string;
  classification: string | null;
};

export type RowSuggestion = {
  accountId: string;
  confidence: number;
  reasoning: string;
  source: "history" | "ai";
  /** true when `confidence` is the bucket's MEASURED precision (≥30 outcomes) */
  calibrated?: boolean;
  /** AI-cleaned vendor name — pre-fills the payee field when present */
  suggestedPayee?: string | null;
};

/** The live rule match for this row (computed by the page from current rules). */
export type MatchedRule = { id: string; name: string; autoApply: boolean };

export function ReviewRow({
  entityId,
  txn,
  accounts,
  mappedReady,
  suggestion,
  matchedRule,
  reviewReason,
  merchantKey,
  payeeListId,
  readOnly = false,
  selectable = false,
  selected = false,
  onToggleSelect,
}: {
  entityId: string;
  txn: ReviewTxn;
  accounts: PostableAccount[];
  mappedReady: boolean;
  suggestion?: RowSuggestion;
  /** The highest-precedence rule that currently matches this txn, if any. */
  matchedRule?: MatchedRule;
  /** Persisted "why this is waiting" note from the last auto-post sweep. */
  reviewReason?: string | null;
  /** Normalized merchant key — seeds "Create rule from this txn". */
  merchantKey?: string;
  /** id of the shared <datalist> of known vendor names (rendered once by the list). */
  payeeListId?: string;
  /** Read-only viewer: no categorize/post/ignore/split controls at all. */
  readOnly?: boolean;
  /** Medium-tier rows render a bulk-select checkbox. */
  selectable?: boolean;
  selected?: boolean;
  onToggleSelect?: (txnId: string) => void;
}) {
  // The user's explicit category pick ("" = none yet). The EFFECTIVE category
  // is derived: an explicit pick always wins; otherwise the suggestion — which
  // usually arrives async, after mount — fills in. (Deriving replaces the old
  // adopt-suggestion effect.)
  const [pickedCategory, setPickedCategory] = useState("");
  const category = pickedCategory || suggestion?.accountId || "";
  // The vendor/payee that gets booked. Starts as the AI-cleaned name when a
  // persisted suggestion carries one (owner decision: pre-fill; raw stays
  // visible underneath), else the bank's descriptor. A live suggestion that
  // arrives after mount only fills in if the owner hasn't typed.
  const raw = txn.merchantName ?? txn.name ?? "";
  const [payee, setPayee] = useState(suggestion?.suggestedPayee ?? raw);
  const payeeTouched = useRef(false);
  const suggestedPayee = suggestion?.suggestedPayee ?? null;
  useEffect(() => {
    if (suggestedPayee && !payeeTouched.current && payee === raw) {
      setPayee(suggestedPayee);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suggestedPayee]);
  const [splitting, setSplitting] = useState(false);
  const [busy, startTransition] = useTransition();
  const router = useRouter();

  function doPost() {
    if (txn.alreadyBooked) {
      toast.error(`Already in ${txn.alreadyBooked.source} — ignore it instead`);
      return;
    }
    if (!category) {
      toast.error("Pick a category first");
      return;
    }
    const fd = new FormData();
    fd.set("entityId", entityId);
    fd.set("txnId", txn.id);
    fd.set("categoryAccountId", category);
    fd.set("payee", payee);
    startTransition(async () => {
      const res = await postTransaction(fd);
      if (res?.ok) {
        toast.success("Posted to ledger");
        // Surface what the engine learned from this decision (confirmation /
        // correction, and any graduation to / demotion from auto-apply).
        if (res.learning) toast.message(res.learning, { duration: 8000 });
        router.refresh();
      } else {
        toast.error(res?.error ?? "Could not post");
      }
    });
  }

  function doIgnore() {
    const fd = new FormData();
    fd.set("entityId", entityId);
    fd.set("txnId", txn.id);
    startTransition(async () => {
      await ignoreTransaction(fd);
      toast.success("Removed from inbox");
      router.refresh();
    });
  }

  function applyHere() {
    if (!matchedRule) return;
    startTransition(async () => {
      const res = await applyRuleHere(entityId, matchedRule.id, txn.id);
      if (res.ok) {
        toast.success(`Applied “${matchedRule.name}”`);
        router.refresh();
      } else toast.error(res.error ?? "Could not apply rule");
    });
  }

  function applySimilar() {
    if (!matchedRule) return;
    startTransition(async () => {
      const res = await applyRuleSimilar(entityId, matchedRule.id);
      if (res.ok) {
        toast.success(`Applied to ${res.applied ?? 0} similar${res.errors ? `, ${res.errors} errored` : ""}`);
        router.refresh();
      } else toast.error(res.error ?? "Could not apply to similar");
    });
  }

  function applyRetro() {
    if (!matchedRule) return;
    startTransition(async () => {
      const res = await applyRuleRetroReview(entityId, matchedRule.id);
      if (res.ok) {
        toast.success(
          `Recategorized ${res.updated ?? 0}` +
            (res.refused ? `, ${res.refused} refused (reconciled)` : "")
        );
        router.refresh();
      } else toast.error(res.error ?? "Could not apply retroactively");
    });
  }

  // "Create rule from this txn" — open the builder prefilled with this merchant
  // and the currently-chosen category.
  const createRuleHref =
    `/ledger/${entityId}/rules?` +
    new URLSearchParams({
      merchant: merchantKey ?? txn.merchantName ?? txn.name ?? "",
      ...(category ? { category } : {}),
    }).toString();

  return (
    <>
    {/* Desktop: a table row. Small screens: the same cells re-flowed into a
        card — date · account · amount on the first line, then the vendor
        field, Plaid category, and controls each full-width (flex order). One
        DOM for both, so the layouts can't drift. */}
    <tr className={`border-b border-hair/60 align-top max-sm:flex max-sm:flex-wrap max-sm:items-center max-sm:gap-x-2 max-sm:gap-y-1.5 max-sm:py-3 ${txn.pending ? "opacity-60" : ""}`}>
      {selectable && (
        <td className="py-3 pr-1 max-sm:py-0">
          <input
            type="checkbox"
            checked={selected}
            onChange={() => onToggleSelect?.(txn.id)}
            disabled={busy}
            className="mt-1 h-3.5 w-3.5 accent-[var(--evergreen)] max-sm:mt-0"
            aria-label="Select for bulk post"
          />
        </td>
      )}
      <td className="whitespace-nowrap py-3 font-mono tabular-nums text-muted-foreground max-sm:py-0">
        {txn.txnDate}
        {txn.pending && (
          <span className="ml-1 text-[10px] text-faint">(pending)</span>
        )}
      </td>
      {/* Source account — kept narrow (truncate + title) so the row still fits. */}
      <td className="max-w-[9rem] py-3 pr-2 max-sm:min-w-0 max-sm:flex-1 max-sm:py-0">
        <div
          className="truncate text-xs text-muted-foreground"
          title={txn.accountLabel ?? undefined}
        >
          {txn.accountLabel ?? "—"}
        </div>
      </td>
      <td className="max-w-[14rem] py-3 pr-2 max-sm:order-1 max-sm:w-full max-sm:max-w-none max-sm:py-0 max-sm:pr-0">
        {/* Editable vendor — what the journal entry is booked under. The raw
            bank descriptor stays visible underneath once it differs. */}
        <input
          value={payee}
          onChange={(e) => {
            payeeTouched.current = true;
            setPayee(e.target.value);
          }}
          list={payeeListId}
          disabled={busy || readOnly}
          placeholder="Vendor / payee"
          title="Vendor booked on the entry — edit to a clean name or pick a known vendor"
          className="w-full rounded border border-hair/70 bg-transparent px-1.5 py-0.5 text-sm focus:border-hair"
        />
        {payee.trim() !== raw && raw && (
          <div className="mt-0.5 truncate text-[10px] text-faint" title={raw}>
            bank: {raw}
          </div>
        )}
        {txn.alreadyBooked && (
          <div className="text-[10px] text-oxblood">
            already in {txn.alreadyBooked.source} (±{txn.alreadyBooked.daysOff}d)
            — ignore it
          </div>
        )}
      </td>
      {/* A bare "—" earns no line on the card layout. */}
      <td className={`py-3 text-xs text-faint max-sm:order-2 max-sm:w-full max-sm:py-0 ${txn.category ? "" : "max-sm:hidden"}`}>{txn.category ?? "—"}</td>
      {/* Plaid: positive = outflow. Negate so spend reads negative. */}
      <td className="py-3 text-right max-sm:ml-auto max-sm:py-0">
        <Money cents={-txn.amountCents} tone="auto" />
      </td>
      <td className="py-3 pl-3 max-sm:order-3 max-sm:w-full max-sm:py-0 max-sm:pl-0 max-sm:pt-1">
        {readOnly ? (
          // Read-only viewer: status only — no categorize/post/ignore/split.
          <div className="flex flex-col items-end gap-1 text-right max-sm:items-start max-sm:text-left">
            <span className="rounded-full border border-hair px-2 py-0.5 text-[10px] text-faint">
              Awaiting review
            </span>
            {suggestion && (
              <span className="text-[10px] text-faint" title={suggestion.reasoning}>
                Suggested ·{" "}
                {accounts.find((a) => a.id === suggestion.accountId)?.label ??
                  "category"}
              </span>
            )}
          </div>
        ) : txn.pending ? (
          // Legacy guard: bank-pending rows are never stored by the sync any
          // more, so this branch only renders for a pre-policy straggler. Not
          // postable either way — the settled txn arrives as its own row.
          <div className="flex justify-end">
            <span className="rounded-full border border-hair px-2 py-0.5 text-[10px] text-faint">
              Pending at the bank — not in the books
            </span>
          </div>
        ) : mappedReady ? (
          <div className="flex flex-col items-end gap-1 max-sm:items-start">
            <div className="flex items-center justify-end gap-2 max-sm:w-full max-sm:flex-wrap">
              <AccountCombobox
                accounts={accounts}
                /* Plaid sign: positive = outflow, negative = money in. */
                inflow={txn.amountCents < 0}
                value={category}
                onChange={setPickedCategory}
                disabled={busy}
                placeholder="— category —"
                className="w-[13rem] max-sm:w-full"
              />
              <Button
                size="sm"
                onClick={doPost}
                disabled={busy || !!txn.alreadyBooked}
              >
                Post
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={doIgnore}
                disabled={busy}
              >
                Ignore
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setSplitting((s) => !s)}
                disabled={busy}
                title="Post as a multi-line entry (gross up an owner payout, split across categories)"
              >
                {splitting ? "Cancel split" : "Split"}
              </Button>
            </div>
            {suggestion && (
              <span
                className="text-[10px] text-faint"
                title={suggestion.reasoning}
              >
                {suggestion.source === "history"
                  ? // History % IS a measurement (share of prior bookings).
                    `History · ${Math.round(suggestion.confidence * 100)}%`
                  : suggestion.calibrated
                    ? // Bucket has ≥30 outcomes — this is observed precision.
                      `AI · ${Math.round(suggestion.confidence * 100)}% measured`
                    : // Model's self-reported number, not yet validated.
                      `AI · ${Math.round(suggestion.confidence * 100)}% (unproven)`}
              </span>
            )}
            {matchedRule && (
              <div className="flex items-center gap-2 text-[10px]">
                <span className="text-faint" title={reviewReason ?? undefined}>
                  Rule: {matchedRule.name}
                  {matchedRule.autoApply ? " (auto)" : ""}
                </span>
                <button onClick={applyHere} disabled={busy} className="text-evergreen hover:underline">
                  Apply
                </button>
                <button onClick={applySimilar} disabled={busy} className="text-evergreen hover:underline">
                  + similar
                </button>
                <button onClick={applyRetro} disabled={busy} className="text-evergreen hover:underline">
                  retro
                </button>
              </div>
            )}
            {!matchedRule && reviewReason && (
              <span className="text-[10px] text-faint" title={reviewReason}>
                {reviewReason}
              </span>
            )}
            <Link href={createRuleHref} className="text-[10px] text-faint hover:text-evergreen hover:underline">
              + Create rule from this txn
            </Link>
          </div>
        ) : (
          <div className="text-right text-xs text-faint max-sm:text-left">
            map this bank account above to post
          </div>
        )}
      </td>
    </tr>
    {mappedReady && splitting && (
      <EntryEditor
        entityId={entityId}
        txnId={txn.id}
        amountCents={txn.amountCents}
        label={payee.trim() || raw || "—"}
        payee={payee}
        accounts={accounts}
        onClose={() => setSplitting(false)}
      />
    )}
    </>
  );
}
