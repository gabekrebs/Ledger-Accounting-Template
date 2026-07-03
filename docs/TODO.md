# Roadmap — Ledger Accounting Template

A starting-point roadmap for someone building on this template. These are
*optional* directions, not committed work — pick what fits your use case. Each
item notes **why**, rough **complexity** (S/M/L), and **prod impact**.

North star: connecting a bank account should require **near-zero manual
categorization**, and the ledger should get **more autonomous over time** by
learning from corrections — while staying accurate and auditable.

---

## First: get your own instance running
Before any of the below, complete the setup in `README.md` — provision Supabase,
Plaid, and Vercel; set your environment variables; run the schema migrations
(`scripts/add-*.mjs`); and confirm `scripts/rls-audit.mjs` reports 0 exposed
tables. Then connect a sandbox Plaid account and watch a transaction flow through
Review → auto-post.

## High-value enhancements

### Learner auto-activation
- **Why:** `lib/rules/learner.ts` authors rules from booked history but leaves
  them `proposed`/disabled for manual approval. Auto-activating high-confidence
  learned rules (as `auto_apply`) lets the system write its own rules from your
  history + corrections. Demote-on-correction already protects it. (Whether to
  keep the human approval step is a posture choice — see ADR-011.)
- **Complexity:** M. **Prod impact:** yes.

### High-confidence AI auto-post for uncovered merchants
- **Why:** rules can't cover everything on day one. Auto-posting AI category
  suggestions above a high bar (e.g. ≥0.9) would categorize the long tail.
  Riskier than rules — gate high, keep it opt-in; corrections still demote.
- **Complexity:** M. **Prod impact:** yes; make it a toggle.

### Per-account import-floor watermark
- **Why:** removes residual duplicate risk when connecting an entity whose books
  end mid-period with amount/date variance (current dedup is exact-match only).
  Not needed for clean cutovers. Design reasoned through in ADR-015.
- **Complexity:** M. **Prod impact:** initial-import only; never historical books.

## Refinements

### Robust Gate-6 band keying
- **Why:** merchant amount-bands key on normalized name; bank descriptors and
  imported-history names can diverge, so amount-anomaly checks silently don't
  fire for some merchants. Align the normalization (or key on rule id).
- **Complexity:** M. **Prod impact:** low (safety refinement).

### Plaid webhook JWT verification
- **Why:** the webhook receiver is gated by a shared `PLAID_WEBHOOK_SECRET`
  (fail-closed). Plaid's official verification (`Plaid-Verification` JWT +
  `/webhook_verification_key/get`) authenticates the sender, not just the URL.
- **Complexity:** M. **Prod impact:** none when correct.

### Database-enforced journal balance
- **Why:** the app validates Σdebit = Σcredit in every writer; add the optional
  DB trigger (`docs/journal-balance-constraint.md`,
  `scripts/add-journal-balance-trigger.mjs`) for defense in depth.
- **Complexity:** S. **Prod impact:** schema trigger — run the pre-flight first.

## Nice to have

- **Rule-management UX** — bulk promote/demote, an "auto-posted by this rule"
  history view, a correction feed. UI only.
- **Transfer-recognizer redesign** — amount-first, confirmation-history matching
  (never name-based) per `docs/transfer-recognizer-design.md`, plus a
  pending-transfer review queue. Complexity: L.
- **Tax-prep exports** — Schedule E / K-1 groundwork (`tax_type` is already on
  entities).
- **Insight surfacing** — flag unusual expenses, surface NOI/occupancy trends,
  suggest missing categories.

---

### Suggested first steps for a new build
1. Stand up your instance (README) and connect a Plaid **sandbox** account.
2. Author a few global vendor rules and watch them auto-post.
3. Add your own income/expense canonical keys in
   `lib/ledger/canonical-accounts.ts` as your chart demands.
4. Then reach for the automation levers above. Keep each change: build + test +
   deploy + verify.
