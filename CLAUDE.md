@AGENTS.md

# Ledger Accounting Template — Claude onboarding

> Read this file, then `docs/ARCHITECTURE.md`, `docs/DECISIONS.md`, and
> `docs/TODO.md` before writing code. They are the project's memory — keep them
> current so a fresh session is productive in ~10 minutes. (This is a starter
> template — see `README.md` for what you must configure first.)

## What this is

A **personal, multi-entity, double-entry bookkeeping system** for the owner's
portfolio of property (mostly short-term-rental) LLCs. Bank transactions flow in
from **Plaid**, are categorized by a **deterministic rules engine** (AI assists,
never silently decides money), and post into an **immutable double-entry journal**
that always balances. Live at **https://your-app.example.com**.

**Product vision:** an *AI bookkeeping assistant* that handles as much
categorization as possible **automatically**, while keeping the ledger accurate
and auditable. Optimize for **maximum automation and minimum manual bookkeeping**;
accept the occasional wrong auto-post and learn from the correction. This is a
**personal tool, not a SaaS product** — but the code stays multi-entity-clean (no
hardcoded entity ids/owner names/property facts) because that is simply good
engineering and makes every feature portable across entities.

> **Naming:** the **user-facing product is "Ledger Accounting Template."** Internal
> identifiers (GitHub repo, `package.json` name, Plaid `client_user_id`,
> `User-Agent`) stay **`ledger-accounting-template`**. Don't rename internals. See
> DECISIONS.md.

## Tech stack

- **Next.js 16** — App Router, Turbopack, Server Components, Server Actions.
  ⚠️ This is *not* the Next.js in your training data — breaking API/convention
  changes. **Read `node_modules/next/dist/docs/` before writing framework code.**
- **Drizzle ORM** over **Supabase Postgres** via `postgres.js` (`lib/db/client.ts`).
  The app connects as the `postgres` role / service role, which **bypasses RLS**.
- **Supabase** — Postgres + Auth (email+password, admin-provisioned) + Storage
  (document uploads). Project ref `your-project-ref`.
- **Plaid** — the bank feed (link, OAuth redirect, cursor sync, webhook).
- **Anthropic** — Haiku (Batch API) for category *suggestions*; never posts.
- **Vercel** — hosting + cron. Production deploys from **`main`**.

## Architecture in one breath

```
Plaid bank feed → staging inbox → recognizers + rules engine → immutable journal
 (bk_plaid_*)     (bk_plaid_transactions)  (bk_rules)         (bk_journal_entries/lines)
```

- A bank login = **one Plaid Item** (`bk_plaid_items`). Each **account**
  (`bk_plaid_accounts`) is the unit of ownership — assigned to an entity and
  mapped to a ledger account. Unassigned accounts are inert.
- The only money-write path is **`lib/plaid/post.ts`** (balanced, atomic, guarded).
- **Rules** (`lib/rules/`): global rules target **canonical category keys**
  resolved per-entity; entity rules target concrete accounts and override global.
- Full detail + diagrams: **`docs/ARCHITECTURE.md`**.

## Directory map

| Path | Responsibility |
|---|---|
| `lib/db/` | Drizzle client + `schema.ts` (all `bk_*` tables) |
| `lib/plaid/` | Link/exchange, sync, `post.ts` (journal writer), recognizers, `auto-post.ts` (unattended poster), dedup (`data.ts`), `reconcile.ts` |
| `lib/rules/` | `types`, `facts`, `predicates`, `engine` (load/select), `actions` (canonical resolution), `store` (CRUD + audit), `apply`, `learn` (confirm/correct/demote), `confidence`, `outlier` (Gate 6), `learner` |
| `lib/ledger/` | `canonical-accounts.ts`, reports, reconciliation, loans, valuations, documents, Wave CSV import, `access.ts` (authz) |
| `lib/security/` | `machine-auth.ts` (fail-closed cron/webhook secrets), `headers.ts` (CSP — shared by next.config.ts + proxy.ts) |
| `app/ledger/` | Per-entity ledger UI, bank **review inbox**, rules admin, `connections/` (bank linking) |
| `app/api/plaid/` | `link-token`, `exchange`, `refresh-accounts`, `webhook` |
| `app/api/cron/` | `auto-categorize` (Plaid sync + auto-post, daily) — the only cron |
| `proxy.ts` | Auth gate (renamed Next middleware) |
| `scripts/` | Idempotent schema migrations (`add-*.mjs`), audits (`rls-audit.mjs`), tests |

## Coding conventions

- **Money is `bigint` cents.** Never floats for money.
- **Immutable journal.** Corrections are *new* entries; never rewrite/delete
  posted `bk_journal_lines`. `postPlaidTransaction*` insert; `unpost` only removes
  `plaid`/`plaid_auto` entries (never imported/manual).
- **All money writes go through `lib/plaid/post.ts`** in a single `db.transaction`.
- **Multi-tenant clean:** no hardcoded entity ids, owner names, or property facts.
  Per-entity data lives in tables; use `lib/ledger/canonical-accounts.ts` to map a
  concept to an entity's real account.
- **New `bk_` tables** ship via an idempotent direct-ALTER script in `scripts/`
  that also runs `ENABLE ROW LEVEL SECURITY` + `REVOKE ALL … FROM anon,
  authenticated` in the same migration (see `scripts/add-rules-engine.mjs`). They
  are declared in `schema.ts` but kept OUT of `drizzle.config.ts` `tablesFilter`.
- Match surrounding style; keep comments at the existing density (this codebase
  comments the *why*).
- TypeScript strict; `bigint`/`Date` at the edges. Server code only touches secrets.

## Never change without asking

- **The immutable double-entry journal** or the money-write path invariants
  (Σdebit = Σcredit, atomic, entity-scoped).
- **Duplicate-prevention logic** (`matchBooked`, cursor + unique `plaid_transaction_id`,
  exact-import block). These prevent double-booking real money.
- **Row Level Security posture** — every public table has RLS on + anon/authenticated
  revoked. Re-run `scripts/rls-audit.mjs` after ANY schema change (drizzle-kit +
  Supabase default privileges silently re-expose tables — see Pitfalls).
- **Plaid access-token encryption** (`lib/plaid/crypto.ts`, `PLAID_TOKEN_KEY`).
- **The one-login-one-Item / duplicate-Item block** and update-mode add-accounts.
- **Historical/imported data** (`source = 'qbo_import' | 'wave_import' | 'manual'`).

## Common commands

```bash
npm run dev                 # local dev on :3000 (reads .env.local)
npm run build               # production build (run before every deploy)
npx tsc --noEmit            # typecheck
npm run lint                # eslint

# Unit tests / verifiers need env loaded (they import the db client):
node --env-file=.env.local ./node_modules/.bin/tsx scripts/rules-engine.test.mts
node scripts/rls-audit.mjs                       # security posture (READ-ONLY)
```

Schema migrations are hand-run idempotent scripts, e.g.
`node scripts/add-rules-engine.mjs` — run FIRST, then deploy code that uses the
new columns. See `docs/ARCHITECTURE.md` § Database.

## Environments

| | Local | Production |
|---|---|---|
| URL | `http://localhost:3000` | `https://your-app.example.com` |
| Config | `.env.local` (git-ignored) | Vercel env vars (Production scope) |
| Plaid | usually `sandbox` (prod tokens only live on the deployed site) | `production` |
| Cron / webhook | OFF (`CRON_SECRET` / `PLAID_WEBHOOK_SECRET` unset — both fail closed) | ON (separate secrets) |
| DB | same Supabase project `your-project-ref` | same |

**Vercel does not read `.env.local`.** Production env vars are set in the Vercel
dashboard. `NEXT_PUBLIC_*` and any URL default must be production values there.

## Git & deploy workflow

1. Work on **`main`** (feature branches only when the owner asks).
2. Make changes → `tsc` + tests + `npm run build` (must all pass) → commit with a
   descriptive message → **push `main`**.
3. Vercel auto-deploys `main`. Verify on `https://your-app.example.com`.
4. **Commit author email must be a real address** (`owner@example.com`) — Vercel
   blocks deploys from `*.local` authors. Global git identity is set; keep it.
5. **Never commit** `.agents/`, `skills-lock.json`, or `.env.local`.
6. Commit-message trailer: `Co-Authored-By: <your AI assistant, if used>`.

Production-behavior or financial-data changes: build + deploy, then **verify on
production** (the review inbox / ledger), because Plaid production only exists
there. The owner accepts occasional wrong auto-posts (reversible) in exchange for
automation — but confirm before anything that could alter *existing* books.

## How the services fit together

- **GitHub** (`YOUR-GITHUB-USER/ledger-accounting-template`) — source of truth for code; Vercel
  deploys from it.
- **Vercel** — hosts the Next app + runs the two daily crons. Production branch = `main`.
- **Supabase** — the database (Drizzle/`postgres.js` direct connection), Auth
  (login), and Storage (documents). One project, used by both local and prod.
- **Plaid** — bank connections + transaction sync. Tokens are AES-encrypted at rest.
- **Migrating existing books** — there is no live accounting-software
  integration. To seed history, import via **Wave CSV** (`lib/ledger/`); those
  journal entries carry `source='wave_import'` (and legacy `'qbo_import'`) purely
  as data lineage the duplicate-detection keys on. Keep those source tags.

## Pitfalls we've hit (don't relearn these)

- **RLS re-exposure:** `drizzle-kit` + Supabase default privileges create tables
  that grant `anon`/`authenticated`. A table with RLS off + those grants is
  world-readable/writable via the public PostgREST API. **Run `scripts/rls-audit.mjs`
  after any schema change.**
- **Vercel ≠ `.env.local`:** production needs its own env vars; a localhost
  `NEXT_PUBLIC_APP_URL` or a missing `PLAID_WEBHOOK_URL` misdirects production.
- **Commit author `*.local`** blocks Vercel deploys.
- **Canonical resolution is read-only** in the auto-poster — a global rule keyed to
  a channel account (`income.airbnb`) fails for an entity that only has a generic
  "Rental Income" unless the **canonical fallback** resolves it. Keep fallbacks
  generic (DECISIONS.md).
- **Bracketed route paths** (`app/ledger/[entityId]/…`) break zsh globbing — quote
  them in shell commands.

## Absolute must-knows before writing code

1. It's real money in an immutable ledger — never rewrite posted entries; use the
   guarded write path.
2. Automation-first is the *current* philosophy (rules auto-apply by default;
   review gates are relaxed) — but correctness/dup/RLS guards stay. Know the
   difference (DECISIONS.md).
3. Read `node_modules/next/dist/docs/` for Next 16 specifics.
4. After schema changes: re-run the RLS audit and migrate FIRST, deploy second.
