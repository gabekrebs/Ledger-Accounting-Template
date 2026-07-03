# Architecture Decision Record — Ledger Accounting Template

Why the system is built the way it is. Each entry: **Context · Decision ·
Alternatives · Tradeoffs · Consequences · Status.** Newest decisions supersede
older ones where noted. When you make a material decision, add an ADR.

---

## ADR-001 — Plaid is the going-forward source of truth
- **Context:** Existing books may be seeded by importing prior history (e.g. a
  Wave CSV). Continuing to categorize in the old software would mean two systems
  of record.
- **Decision:** Once an entity is connected to Plaid, **Plaid's bank feed is the
  source of truth for new transactions**, which post directly into this ledger.
  Imported CSV data remains only as historical lineage.
- **Alternatives:** Keep the old software as system of record and sync; dual-entry.
- **Tradeoffs:** Full control + one ledger, vs. losing the old tool's ecosystem.
- **Consequences:** `source='qbo_import'/'wave_import'` survives on imported
  entries as data lineage for duplicate detection.
- **Status:** Current.

## ADR-002 — Transactions import into Review first (staging inbox)
- **Context:** Auto-posting bank transactions straight into an immutable ledger is
  irreversible-adjacent; wrong posts corrupt real books.
- **Decision:** Synced transactions land in a **staging inbox**
  (`bk_plaid_transactions`, `pending_review`); nothing posts to the journal on sync.
  Posting is a separate, guarded step (recognizer, trusted rule, or human).
- **Alternatives:** Post everything immediately and fix later.
- **Tradeoffs:** Safety + auditability vs. a review queue.
- **Consequences:** Established the pipeline the rules engine plugs into. The
  *default posture* on top of this later shifted from review-first to automation-
  first (ADR-011) — but the staging inbox itself remains.
- **Status:** Current (posture evolved, see ADR-011).

## ADR-003 — Deterministic rules engine is the spine; AI assists
- **Context:** "The LLM understands; deterministic code does the money." AI
  category guesses are useful but must never silently move money.
- **Decision:** A **deterministic, user-authored, prioritized rules engine**
  decides categorization and can post unattended (`auto_apply`). AI (Haiku) only
  *suggests*; every unattended post traces to a recognizer or a rule.
- **Alternatives:** LLM-in-the-loop posting; pure heuristics.
- **Tradeoffs:** Predictable + auditable vs. less "magic".
- **Consequences:** Rules, recognizers, and an append-only decision log
  (`bk_categorization_events`).
- **Status:** Current.

## ADR-004 — Global rules separate from entity rules
- **Context:** Vendor→category knowledge is portfolio-wide (Airbnb→income,
  Comcast→utilities), but some entities need exceptions and every entity's chart
  differs.
- **Decision:** **Global rules** target **canonical category keys** (resolved
  per-entity); **entity rules** target concrete accounts and **override** global.
  Precedence: entity → global → rank → specificity → created_at.
- **Alternatives:** Only per-entity rules (massive duplication); only global (no
  exceptions).
- **Tradeoffs:** Write-once portability vs. a two-tier mental model.
- **Consequences:** Requires the canonical layer (ADR-005) to make global targets
  resolvable everywhere.
- **Status:** Current.

## ADR-005 — Canonical account layer
- **Context:** Each entity's imported chart names things differently ("Management"
  vs "Management Expense", "Rental Income" vs "Rental Income - Airbnb"). A feature
  written once must work on any entity without editing its books.
- **Decision:** A **canonical taxonomy** (`lib/ledger/canonical-accounts.ts`) maps
  a `CanonicalKey` to *that entity's* best-matching real account by name heuristics
  (RESOLVE), and can create app-native accounts for core keys (ENSURE).
- **Alternatives:** Force a standard chart on every entity; hardcode account ids.
- **Tradeoffs:** A resolution layer to maintain vs. true multi-entity portability.
- **Consequences:** Enabled global canonical rules; later needed a fallback (ADR-010).
- **Status:** Current.

## ADR-006 — Vercel hosting, production deploys from `main`
- **Context:** Next.js app needing SSR, cron, and easy Git deploys. Early work
  happened on an integration branch.
- **Decision:** Host on **Vercel**; **production branch = `main`**. Push to `main`
  deploys production; feature branches are used only on request.
- **Alternatives:** Self-host; deploy from a long-lived integration branch.
- **Tradeoffs:** Zero-ops + preview deploys, vs. Vercel Hobby limits (1 cron
  run/day) and Vercel-specific gotchas (env not from `.env.local`; commit-author
  email must be valid).
- **Consequences:** Cron cadence is daily; the Plaid webhook covers real-time sync.
- **Status:** Current.

## ADR-007 — Row Level Security lockdown + hand-run idempotent migrations
- **Context:** An audit found 20 of 23 public tables with RLS **off** while the
  internet-facing `anon`/`authenticated` PostgREST roles held full grants — all
  bookkeeping/Plaid/user data was world-readable/writable. Root cause: `drizzle-kit`
  creates tables without RLS and Supabase default privileges auto-grant those roles.
- **Decision:** **Every public table has RLS enabled + anon/authenticated
  revoked** (deny-all to the public API; the app's `postgres`/service role bypasses
  RLS). Schema changes ship as **idempotent direct-ALTER scripts** that include
  `ENABLE RLS` + `REVOKE` in the same migration; **not** `drizzle-kit push`. New
  tables stay out of `drizzle.config.ts` `tablesFilter`. Run `scripts/rls-audit.mjs`
  after any change.
- **Alternatives:** Author RLS policies for the public roles (unnecessary — the app
  never uses them); trust drizzle-kit.
- **Tradeoffs:** Manual migration discipline vs. a closed attack surface.
- **Consequences:** `docs/security-rls-lockdown.md`; the schema-change protocol in
  ARCHITECTURE.md § 12.
- **Status:** Current.

## ADR-009 — "Ledger Accounting Template" user-facing; "ledger-accounting-template" internal
- **Context:** The product needed a clean end-user name; the repo/infra were named
  `ledger-accounting-template`.
- **Decision:** **User-facing product = "Ledger Accounting Template"** (page/tab title,
  header, login, Plaid Link `client_name`). **Internal identifiers stay
  `ledger-accounting-template`** (GitHub repo, `package.json`, Plaid `client_user_id`,
  `User-Agent`) — renaming them is churn with no user benefit.
- **Alternatives:** Rename everything; keep the old name in the UI.
- **Tradeoffs:** A tidy product face vs. a name mismatch between UI and repo (documented).
- **Consequences:** When touching branding, change only user-visible strings.
- **Status:** Current.

## ADR-010 — Canonical accounts fall back to a generic parent
- **Context:** A global rule targeting `income.airbnb` errored for an entity whose
  chart has only a generic "Rental Income" (no channel-specific account), because
  resolution is read-only and found no match — every Airbnb auto-post failed.
- **Decision:** A `CanonicalDef` may declare a **`fallback` parent key**; after
  direct resolution, an unmatched key inherits its parent's account (chain-followed,
  cycle-guarded, never overriding a direct match). Rental channels → `income.other`
  (generic Rental Income); `garbage` → `utilities`. Categories with **no safe
  generic parent** (insurance, management…) have no fallback — they stay unmatched →
  human review rather than mis-post to a catch-all.
- **Alternatives:** Create per-entity rule copies; ensure-create channel accounts
  (fragments the chart); a bare "Rental Income" match on the specific key.
- **Tradeoffs:** Global rules become portable across any chart, vs. a small
  resolution-order subtlety.
- **Consequences:** Global rules "just work" on new entities. Airbnb income posts
  to the entity's existing Rental Income account.
- **Status:** Current.

## ADR-011 — Automation-first (evolved from review-first)
- **Context:** The system was originally built "when in doubt, review": rules
  shipped `auto_apply=false` and had to earn it via 3 clean confirmations, and Gate
  6 deferred first-time merchants, unfamiliar accounts, and >3× amounts. In
  practice this left many transactions in Review. The posture was reframed toward
  **maximum automation** — if a rule matches with reasonable confidence, run it;
  corrections train it.
- **Decision:** Pivot to **automation-first.** New categorize/split/ignore rules
  **default to `auto_apply=true`**; all trusted rules promoted. **Gate 6 relaxed** —
  first-time merchant and unfamiliar account no longer defer; amount tolerance
  widened 3×→8× (only a truly extreme amount pauses). The **multiple-rule deferral
  is removed** (post the precedence winner). Cron trigger **50→1**. The safety valve
  is **demote-on-correction** — a corrected `auto_apply` rule falls below the
  confidence bar and stops.
- **Alternatives:** Keep review-first; per-rule manual opt-in only.
- **Tradeoffs:** Dramatically less manual work + a self-improving ledger, at the
  cost of occasional wrong auto-posts (accepted; all reversible). Correctness guards
  (dedup, immutable journal, RLS, recognizer precedence) are **kept** — those aren't
  "conservative," they prevent wrong books.
- **Consequences:** Supersedes the review-first default of ADR-002 (the staging
  inbox stays; the posture flips). Motivates the learner auto-activation + webhook
  auto-post roadmap (TODO H1/H2).
- **Status:** Current. (Supersedes the review-first *default*, ADR-002.)

## ADR-012 — One login = one Plaid Item; duplicate-Item hard block; Update Mode
- **Context:** A bank login (e.g. Chase) can hold many accounts across many
  entities. Re-linking with a different account selection creates a second Item —
  and some banks invalidate the prior one, breaking the connection.
- **Decision:** **One login = one Item.** `exchange` **hard-blocks** creating a
  second active Item for an institution that already has one (returns 409, removes
  the stray token). Adding accounts later uses **Update Mode**
  (`account_selection_enabled`) on the existing Item, not a fresh link. Accounts are
  the unit of ownership and arrive **unassigned/inert**.
- **Alternatives:** Allow multiple Items and dedup downstream (fragile; banks break).
- **Tradeoffs:** Robust connections + no duplicate pulls, vs. a small amount of
  extra link-flow logic.
- **Consequences:** Stable Chase connection; unassigned accounts never post.
- **Status:** Current.

## ADR-013 — Immutable double-entry journal; money as bigint cents; single write path
- **Context:** Partner-facing, money-real books must be trustworthy and auditable.
- **Decision:** The journal is **append-only** — corrections are new entries, never
  row rewrites/deletes (`unpost` removes only `plaid`/`plaid_auto` entries). **Money
  is `bigint` cents** (never floats). **All money writes go through
  `lib/plaid/post.ts`** in one `db.transaction`, entity-scoped, balanced.
- **Alternatives:** Editable entries; float money; scattered write paths.
- **Tradeoffs:** Auditability + integrity vs. edits requiring reversing entries.
- **Consequences:** The core invariant everything else assumes. Do not violate.
- **Status:** Current.

## ADR-014 — Supabase (Postgres + Auth + Storage)
- **Context:** Needed a managed Postgres, auth, and file storage with minimal ops.
- **Decision:** **Supabase.** Drizzle/`postgres.js` direct connection for data (as
  the RLS-bypassing `postgres` role); supabase-js service role for Auth admin +
  Storage (documents).
- **Alternatives:** Raw Postgres + separate auth/storage; a different BaaS.
- **Tradeoffs:** Fast to build vs. the RLS/default-privileges footgun (ADR-007) and
  the app being data-access-authoritative (RLS is defense-in-depth, not enforcement).
- **Consequences:** One project (`your-project-ref`) for local + prod.
- **Status:** Current.

## ADR-015 — Import-floor watermark deferred
- **Context:** The first Plaid sync pulls the full history window; overlap with
  imported books is hidden only by exact amount/date matching, which can miss
  variant duplicates on a messy cutover.
- **Decision:** **Defer** building a per-account import-floor (a frozen "only import
  after the newest existing txn" boundary). When imported books end on a clean
  cutoff, exact-match dedup suffices.
- **Alternatives:** Build it now (unneeded complexity for clean cutovers).
- **Tradeoffs:** Simpler now vs. residual duplicate risk for mid-period connections.
- **Consequences:** Revisit before connecting an entity with a non-clean cutoff
  (TODO M2).
- **Status:** Current (deferred).

## ADR-016 — Remove invoicing + suspense-merge; harden the security perimeter
- **Context:** A security/code audit (2026-07) found the cron/webhook auth
  accepted `Bearer undefined` when `CRON_SECRET` was unset, the cron secret rode
  in the Plaid webhook URL, valuation mutations trusted client-submitted
  `componentId`s (cross-entity IDOR), any signed-in admin could create entities,
  Plaid account assignment never verified the ledger account belonged to the
  chosen entity, and the Wave import writers weren't atomic. Separately, unused invoicing and a Wave suspense-merge tool were retired to
  shrink the attack surface.
- **Decision:** **Delete invoicing and suspense-merge entirely** (UI, actions,
  libraries, cron, PDF route, LLM authoring, `pdf-lib` dependency); their three
  tables stay DORMANT in the DB (dropping is an optional future migration —
  never destructive without approval). **Harden:** fail-closed, constant-time
  machine auth (`lib/security/machine-auth.ts`); a dedicated
  `PLAID_WEBHOOK_SECRET` so `CRON_SECRET` authorizes only crons; entity-scoped
  valuation mutations with a uniform not-found error; **owner-only entity
  creation** (`assertEntityCreator` — identity, not role; only the configured `OWNER_EMAIL`
  may create entities); validated + transactional Plaid
  account↔entity assignment; production CSP without `unsafe-eval` (headers
  single-sourced in `lib/security/headers.ts`); atomic, balance-validated Wave
  import writers; request-size limits on CSV/document uploads.
- **Alternatives:** Repair suspense-merge (rejected — delete beats maintaining a
  non-atomic journal-history rewriter); keep invoicing dormant (rejected — dead
  routes/cron/email paths are attack surface); make entity creation an admin
  capability (rejected — "sees everything" must not imply "changes what the
  portfolio is").
- **Tradeoffs:** Lost features nobody uses vs. a smaller attack surface and
  ~4k fewer lines. The webhook now needs its own secret configured (and Item
  URLs re-registered once via `scripts/update-plaid-webhooks.mts`) — until
  then the daily cron carries sync.
- **Consequences:** One cron remains (`auto-categorize`). Plaid webhook JWT
  verification and a DB-level journal-balance trigger
  (`docs/journal-balance-constraint.md`) are the documented follow-ups.
- **Status:** Current.

## ADR-017 — Liability engine: current-state estimation, loan-as-identity
- **Context:** Mortgage payments are inherently computed splits (P/I/E) the
  rules engine can't express. The original recognizer required origination
  data (principal/term/first payment) nobody maintains — loans typically had rate
  + remaining term only, so it never fired. Servicers change (loans get sold),
  payments change (annual escrow re-analysis), and the design favors automation
  over accounting perfection ("within a few dollars; true up at year end").
- **Decision:** The LOAN is the identity; the SERVICER is a learned label
  (`payee_aliases`). Recognition is structural — funding account + amount band
  (max($100, 15%)) around `expected_payment_cents` (the engine's on-switch;
  null = Review). Estimation is from CURRENT STATE: interest = GL liability
  balance × rate/12; P&I = expected − escrow (constant for fixed-rate);
  escrow = residual (self-corrects through re-analyses, then the new
  payment/escrow are adopted as expected). Escrow legs EXPENSE monthly to a
  "Taxes & Insurance (Escrow)" account, trued up at year end from the 1098/escrow
  analysis (a once-a-year assistant-assisted reconcile, not an in-app feature).
  Interest-only strategy (`interest_only` flag) covers HELOCs / 0%-forbearance notes. Auto-post sweeps run OLDEST-FIRST so an earlier payment's
  principal books before a later one's interest is estimated.
- **Alternatives:** Origination-data amortization (stale after every refi;
  unobtainable); statement parsing each month (reintroduces the manual work);
  per-loan rules in the rules engine (static actions can't compute).
- **Tradeoffs:** Cents-level estimates that drift only when the GL drifts —
  and validated penny-exact against real servicer statements once the GL matched
  the servicer principal. Small ARM changes inside the band would be misread as
  escrow changes (accepted: fixed-rate loans dominate; HELOCs use the
  interest-only strategy).
- **Consequences:** A mortgage's prior-year history can be backfilled (interest
  + escrow reclassified out of principal) so the GL tracks the servicer exactly,
  after which drafts auto-post. Configuring a loan row (funding account +
  expected payment) is the one-time onboarding step per loan. The Loans tab keeps
  rate/term as saved analysis data.
- **Status:** Current.
