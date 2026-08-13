# Ledger Accounting Template

A **multi-entity, double-entry bookkeeping starter** for a portfolio of
businesses — an automation-first "AI bookkeeping assistant." Bank transactions
flow in through **Plaid**, are categorized by a **deterministic rules engine**
(AI assists, never silently moves money), and post into an **immutable
double-entry journal** that always balances.

> This is a **template / starting point**, not a hosted product. Fork it, wire up
> your own Supabase / Plaid / Vercel, and build from here. It ships with no data
> and no secrets — everything is configured through environment variables.

## Features

- **Multi-entity ledger** — one instance handles many businesses; every feature
  is entity-scoped, with no hardcoded entity/owner/property facts in the code.
- **Plaid bank feed** — OAuth linking, cursor sync, real-time webhook. One bank
  login can fan out its accounts to many entities.
- **Deterministic rules engine** — global (portfolio-wide) and per-entity rules
  over a **canonical account layer**, so a rule written once resolves to each
  entity's real chart of accounts.
- **Structural recognizers** — internal transfers, credit-card payments, and a
  **liability engine** that splits loan/mortgage payments into principal /
  interest / escrow from current state (survives servicer sales & escrow
  re-analyses).
- **Immutable journal** — append-only, `bigint` cents, single guarded write
  path, balance enforced (optionally at the DB layer too).
- **Reports** — P&L, balance sheet, general ledger, reconciliation, property
  valuation, document storage, Wave-CSV history import.
- **Review & automation trust** — a cross-entity, mobile-friendly review queue,
  owner "heads-up" holds, per-merchant outlier gates, and an evidence ledger
  that lets AI suggestions *earn* unattended posting (measured precision,
  small caps, one undo re-locks).
- **Reconciliation & close** — per-account book-vs-bank health with honest
  "settling" windows, statement ties, and trial-balance XLSX export for your
  accountant. Light and dark mode.
- **Security-first** — Row-Level-Security lockdown, fail-closed machine-endpoint
  auth, encrypted Plaid tokens, webhook signature verification, targeted rate
  limiting, owner-only entity creation, tight CSP.

## Stack

- **Next.js 16** (App Router, Turbopack) — note: breaking changes vs. older
  Next; read `AGENTS.md` before writing framework code.
- **Drizzle ORM** over **Supabase Postgres** (`postgres.js`, direct connection).
- **Supabase** — Postgres + Auth (email/password, admin-provisioned) + Storage.
- **Plaid** — the bank feed.
- **Anthropic** (optional) — AI category suggestions & valuation.
- **Vercel** — hosting + cron.

## Required services

| Service | Why | Free to start? |
|---|---|---|
| [Supabase](https://supabase.com) | Postgres, Auth, Storage | yes |
| [Plaid](https://dashboard.plaid.com) | bank connections | yes (sandbox) |
| [Vercel](https://vercel.com) | hosting + daily cron | yes (Hobby) |
| [Anthropic](https://console.anthropic.com) | AI suggestions (optional) | pay-as-you-go |
| [RentCast](https://www.rentcast.io) | property valuations (optional) | free tier |

## Setup

### 1. Clone & install
```bash
git clone https://github.com/YOUR-GITHUB-USER/ledger-accounting-template.git
cd ledger-accounting-template
npm install
```

### 2. Provision Supabase
- Create a project. Copy the project URL, anon key, service-role key, and the
  direct Postgres connection string into your env (below).
- Enable **Email** auth. This app is **admin-provisioned** (no self-signup) — you
  add users via the in-app Users screen or the env allowlist.

### 3. Provision Plaid
- Create an app; start in **sandbox**. Copy the client ID + secret.
- For OAuth banks, register your redirect URI (`.../ledger/connections`) in the
  Plaid dashboard and set `PLAID_REDIRECT_URI` to match exactly.

### 4. Configure environment
```bash
cp .env.example .env.local
# fill in real values — see .env.example for what each one is
```
Generate the two secrets and the token key:
```bash
openssl rand -base64 32   # PLAID_TOKEN_KEY
openssl rand -hex 32      # CRON_SECRET  (and again for PLAID_WEBHOOK_SECRET)
```
Set `OWNER_EMAIL` to the one account allowed to create entities, and
`AUTH_ALLOWED_EMAILS` / `AUTH_ADMIN_EMAILS` to your sign-in allowlist.

### 5. Create the database schema
Schema ships as **idempotent, hand-run migration scripts** (not `drizzle-kit
push` — see `docs/DECISIONS.md` ADR-007 for why). Run them in order; each also
enables Row-Level Security and revokes the public roles:
```bash
for f in scripts/add-*.mjs; do node "$f"; done   # reads .env.local
node scripts/rls-audit.mjs                        # must report 0 exposed tables
```
> The optional journal-balance DB trigger
> (`scripts/add-journal-balance-trigger.mjs`) adds defense-in-depth; run its
> read-only pre-flight first (`docs/journal-balance-constraint.md`).

### 6. Run it
```bash
npm run dev        # http://localhost:3000
```
Sign in with an allowlisted email (create the Supabase auth user first), connect
a Plaid **sandbox** bank on the Connections screen, assign its accounts to an
entity, and watch transactions flow Review → auto-post.

## Local development

```bash
npm run dev                 # dev server on :3000 (reads .env.local)
npm run build               # production build
npx tsc --noEmit            # typecheck
npm run lint                # eslint

# Pure-logic tests (no DB):
SUPABASE_DB_URL=postgres://u:p@127.0.0.1:5432/none npx tsx scripts/rules-engine.test.mts
# DB-backed tests self-skip unless TEST_DATABASE_URL points at a disposable DB.
node scripts/rls-audit.mjs  # security posture (read-only)
```

## Deployment (Vercel)

1. Push to **GitHub**; import the repo into **Vercel**. Production branch = `main`.
2. Set **all** env vars in the Vercel project (Production scope) — Vercel does
   **not** read `.env.local`. Use production Plaid credentials and real URLs.
3. Push to `main` → Vercel auto-deploys. `vercel.json` registers the daily
   `auto-categorize` cron.
4. After setting `PLAID_WEBHOOK_SECRET` in production, register it on existing
   Plaid Items once:
   `node --env-file=.env.local ./node_modules/.bin/tsx scripts/update-plaid-webhooks.mts`
5. Commit-author email must be a real address (Vercel blocks `*.local` authors).

## What you must configure (checklist)

- [ ] Supabase project (URL, anon key, service-role key, DB URL)
- [ ] Run the migration scripts + `rls-audit` (0 exposed tables)
- [ ] Plaid app (client ID, secret, env; redirect URI for OAuth banks)
- [ ] `PLAID_TOKEN_KEY`, `CRON_SECRET`, `PLAID_WEBHOOK_SECRET` (generated)
- [ ] `OWNER_EMAIL`, `AUTH_ALLOWED_EMAILS`, `AUTH_ADMIN_EMAILS`
- [ ] `NEXT_PUBLIC_APP_URL` and (prod) `PLAID_WEBHOOK_URL` / `PLAID_REDIRECT_URI`
- [ ] (optional) `ANTHROPIC_API_KEY`, `RENTCAST_API_KEY`
- [ ] Create your first Supabase auth user, then create entities (owner only)
- [ ] Adjust the canonical taxonomy in `lib/ledger/canonical-accounts.ts` to your
      chart of accounts

## Project layout

- `lib/db/` — Drizzle client + `schema.ts` (all `bk_*` tables).
- `lib/plaid/` — link/exchange/sync, `post.ts` (the only journal writer),
  structural recognizers, the unattended auto-poster, dedup.
- `lib/rules/` — the deterministic rules engine (predicates, actions,
  canonical resolution, confidence, audit, learner).
- `lib/ledger/` — chart of accounts, reports, reconciliation, loans, valuations,
  documents, Wave import, `access.ts` (authz).
- `lib/security/` — fail-closed machine auth + the shared CSP/security headers.
- `app/ledger/` — the UI (per-entity ledger, bank review inbox, rules admin,
  connections).
- `scripts/` — idempotent schema migrations (`add-*.mjs`), `rls-audit.mjs`, tests.

## Documentation

- `CLAUDE.md` — fast onboarding (read first if using an AI coding assistant).
- `docs/ARCHITECTURE.md` — how the system works and why.
- `docs/DECISIONS.md` — the architecture decision record (ADRs).
- `docs/TODO.md` — a starter roadmap of optional enhancements.
- `docs/security-rls-lockdown.md`, `docs/journal-balance-constraint.md`,
  `docs/transfer-recognizer-design.md` — deep-dive design notes.

## License

No license file is included — add one that fits your use before sharing publicly.
