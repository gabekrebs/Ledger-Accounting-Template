/**
 * Review-reason taxonomy — PURE (no db). One enum + one label map, so the inbox
 * always explains WHY a transaction is waiting (or why a rule stays Review-only)
 * in the owner's words. The engine's guiding philosophy is "when in doubt,
 * review": every deferral carries a specific, honest reason from this list.
 *
 * Currently EMITTED at runtime by the auto-poster's gates (auto-post.ts /
 * outlier.ts): `multiple_rules`, `unusual_amount`, `unusual_account`,
 * `first_occurrence`. At launch the common "a rule matched but hasn't earned
 * auto_apply" deferral is shown as the rule-named free-text string in
 * `markProposed` (more informative than a generic label).
 *
 * The remaining members are RESERVED for surfaces not yet wired: the offline
 * authoring reasons (mixed/changed/stale/person/insufficient — today the
 * generator simply skips those merchants rather than tagging a row) and the
 * future transfer recognizer (`transfer_recognizer_conflict`) and cadence check
 * (`unusual_frequency`). Kept as one enum so the inbox can adopt them without a
 * taxonomy fork; do not assume a member is emitted just because it's defined.
 */
export type ReviewReason =
  | "mixed_categories"
  | "category_changed"
  | "insufficient_recent_history"
  | "stale_merchant"
  | "person_name"
  | "transfer_recognizer_conflict"
  | "unusual_amount"
  | "unusual_account"
  | "unusual_frequency"
  | "multiple_rules"
  | "first_occurrence"
  | "rule_not_auto"
  | "low_confidence"
  | "pre_cutoff"
  | "ambiguous";

export const REVIEW_REASON_LABEL: Record<ReviewReason, string> = {
  mixed_categories: "Mixed historical categories — no single answer",
  category_changed: "Category changed recently — recent history differs from older",
  insufficient_recent_history: "Not enough recent history to trust",
  stale_merchant: "Stale merchant — no recent activity",
  person_name: "Person-name payee — verify each time",
  transfer_recognizer_conflict: "Looks like a transfer/payment — left to transfer matching",
  unusual_amount: "Unusual amount vs this merchant's history",
  unusual_account: "Unusual account vs this merchant's history",
  unusual_frequency: "Unusual timing vs this merchant's cadence",
  multiple_rules: "More than one rule matched — ambiguous",
  first_occurrence: "First time seeing this merchant",
  rule_not_auto: "Matches a rule that hasn't earned auto-apply yet",
  low_confidence: "Confidence below the auto bar",
  pre_cutoff:
    "Dated within the imported-books period — verify it isn't already booked (possibly inside a bundled entry)",
  ambiguous: "Ambiguous — needs a human",
};

/** Human-facing one-liner for a review reason. */
export function reviewReasonText(reason: ReviewReason): string {
  return REVIEW_REASON_LABEL[reason];
}
