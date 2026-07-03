"use client";

import { useState, useTransition } from "react";
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
}) {
  // The user's explicit category pick ("" = none yet). The EFFECTIVE category
  // is derived: an explicit pick always wins; otherwise the suggestion — which
  // usually arrives async, after mount — fills in. (Deriving replaces the old
  // adopt-suggestion effect.)
  const [pickedCategory, setPickedCategory] = useState("");
  const category = pickedCategory || suggestion?.accountId || "";
  // The vendor/payee that gets booked — starts as the bank's descriptor,
  // editable so the books carry a clean, consistent name.
  const raw = txn.merchantName ?? txn.name ?? "";
  const [payee, setPayee] = useState(raw);
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
    <tr className="border-b border-hair/60 align-top">
      <td className="whitespace-nowrap py-3 font-mono tabular-nums text-muted-foreground">
        {txn.txnDate}
        {txn.pending && (
          <span className="ml-1 text-[10px] text-faint">(pending)</span>
        )}
      </td>
      <td className="max-w-[14rem] py-3 pr-2">
        {/* Editable vendor — what the journal entry is booked under. The raw
            bank descriptor stays visible underneath once it differs. */}
        <input
          value={payee}
          onChange={(e) => setPayee(e.target.value)}
          list={payeeListId}
          disabled={busy}
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
      <td className="py-3 text-xs text-faint">{txn.category ?? "—"}</td>
      {/* Plaid: positive = outflow. Negate so spend reads negative. */}
      <td className="py-3 text-right">
        <Money cents={-txn.amountCents} tone="auto" />
      </td>
      <td className="py-3 pl-3">
        {mappedReady ? (
          <div className="flex flex-col items-end gap-1">
            <div className="flex items-center justify-end gap-2">
              <AccountCombobox
                accounts={accounts}
                /* Plaid sign: positive = outflow, negative = money in. */
                inflow={txn.amountCents < 0}
                value={category}
                onChange={setPickedCategory}
                disabled={busy}
                placeholder="— category —"
                className="w-[13rem]"
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
                {suggestion.source === "history" ? "History" : "AI"} ·{" "}
                {Math.round(suggestion.confidence * 100)}% suggested
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
          <div className="text-right text-xs text-faint">
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
