# Transfer recognizer — design direction (NEXT milestone, not yet built)

**Status:** DESIGN ONLY. Recorded 2026-06-29. Do **not** implement during the
rules-engine rollout — the rules engine is being finished and stabilized first.

## Principle

Transfers are **not** a categorization problem and must **not** be learned from
merchant names. A transfer is an account-to-account money movement identified by
its *structure* (amount + direction + timing + a confirmed account-pair history),
not by what the bank descriptor says. Names are **supporting evidence only, never
the primary signal.**

A **dedicated transfer recognizer runs BEFORE the rules engine** (as recognizers
already do in `lib/plaid/auto-post.ts`). If it claims a transaction, no learned
rule is created or consulted for it.

## Auto-classify-as-transfer conditions (ALL required)

1. **Same entity** — both legs belong to the same entity's own linked accounts.
2. **Exact matching amount** — equal, or within **one cent**.
3. **Opposite cash flow** — one debit, one credit.
4. **Within 3 days** of each other.
5. **Previously confirmed transfer history for that account pair** — this
   source→destination account pair has been confirmed as a transfer before.
6. **Exactly one matching candidate** in the window (≥2 → Pending Transfer
   Review, never auto-confirm).
7. **Not already matched** — neither leg is already booked/consumed.

If and only if all hold → auto-classify as a transfer, **without** creating or
relying on a learned categorization rule. Otherwise → Transfer Review queue.

## Delta vs. the CURRENT recognizer (`planInternalTransfer`, `transfer-match.ts`)

The existing recognizer already does: same-entity, **exact** amount (no ±1¢
tolerance), opposite direction, **±5 days**, exactly-one-candidate, and
not-already-matched (via the in-pass `resolvedTransferIds` set). To reach this
spec it needs:

- tighten the window **±5 → ±3 days**;
- add the **±1¢ tolerance** on amount;
- add the **"previously confirmed transfer history for that account pair"**
  requirement — which implies a small persisted record of confirmed transfer
  account-pairs (a new lightweight table or a reuse of the decision log), and a
  **Pending Transfer Review** queue for the multi-candidate / first-time-pair
  cases (today those silently defer to generic `pending_review`).

## Why this is safe to defer

The current rollout never auto-posts transfers via rules: the rule generator's
Gate 5 excludes transfer/CC/loan/owner-draw merchants, and the recognizer still
owns the structural cases. So finishing the rules engine first cannot cause a
transfer to be mis-learned — it can only leave an ambiguous transfer in review,
which is the desired "when in doubt, review" behavior.
