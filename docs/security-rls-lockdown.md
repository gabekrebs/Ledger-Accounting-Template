# RLS lockdown — public-schema exposure fix (project `your-project-ref`)

## What was vulnerable

An audit on 2026-06-30 found **20 of 23 `public` tables with Row Level Security
DISABLED while the internet-facing `anon` / `authenticated` PostgREST roles held
full `SELECT/INSERT/UPDATE/DELETE/TRUNCATE` grants**. Because the direct
connection (`SUPABASE_DB_URL`) and the public API (`NEXT_PUBLIC_SUPABASE_URL`)
are the **same** Supabase project, anyone with the project's public anon key
(shipped to browsers) could read, modify, or destroy all bookkeeping, Plaid,
user, and bank data through `https://<project>.supabase.co/rest/v1/`.

Exposed tables: `bk_accounts`, `bk_app_users`, `bk_entity_access`,
`bk_journal_entries`, `bk_journal_lines`, `bk_journal_edits`, `bk_plaid_items`,
`bk_plaid_accounts`, `bk_plaid_transactions`, `bk_reconciliations`,
`bk_ledger_entities`, `bk_loans`, `bk_notes_receivable`, `bk_invoices`,
`bk_invoice_templates`, `bk_documents`, `bk_category_batches`, `bk_wave_imports`,
`bk_valuation_components`, `bk_valuation_estimates`.

Already-correct (RLS on, no public grant): `bk_rules`, `bk_rule_edits`,
`bk_categorization_events` — these shipped under the standing RLS+REVOKE rule.

Partial mitigation: Plaid access tokens in `bk_plaid_items` are AES-256-GCM
encrypted (`lib/plaid/crypto.ts`), so a reader gets ciphertext — but every other
column was plaintext and every row was writable.

## Why it was safe to fix without policies

Every application access path to these tables bypasses RLS and never uses the
public roles (verified across the whole codebase):

- **Drizzle / postgres.js** (`lib/db/client.ts`) connects as role **`postgres`**
  with `rolbypassrls = true`. All ledger/Plaid/bookkeeping data access is here.
- **supabase-js service-role client** (`lib/supabase/server.ts`) uses
  `SUPABASE_SERVICE_ROLE_KEY` (bypasses RLS); at the time of the audit its
  `.from()` calls targeted only legacy integration tables that do not exist in
  this database.
- **The anon client** (`lib/supabase/auth-server.ts`, `@supabase/ssr`) is used
  **only** for `supabase.auth.*` (login/getUser) — never `.from()` data queries.

No legitimate functionality depends on `anon`/`authenticated` grants for these
tables, so the correct posture is **deny-all** (RLS on, zero policies), not new
policies (which could only loosen it).

## The fix

`scripts/fix-rls-lockdown.mjs` — idempotent, single transaction. Per public
table: `ENABLE ROW LEVEL SECURITY` (deny-all for non-bypass roles) +
`REVOKE ALL FROM anon, authenticated` (removes it from the exposed API surface).
Pure DDL/grants — **no DML**, so no row data can change.

## Verification (2026-07-01, live)

- `scripts/rls-audit.mjs`: 23/23 RLS on, **0 exposed**, **0** anon/authenticated grants.
- Read all formerly-exposed tables as `postgres`: OK, **184,026 rows intact**
  (53,123 journal entries, 129,725 lines) — nothing deleted/truncated.
- Live app: `/login` 200, `/ledger` 200 (authenticated), `/` 401 (auth gate) — functional.

## Root cause & recurrence prevention

`drizzle-kit` creates tables without RLS, and Supabase's default privileges
auto-grant `anon`/`authenticated`. The older tables were created that way and
never received the REVOKE the direct-ALTER migration scripts apply. To prevent
recurrence: keep shipping new `bk_` tables via the idempotent ALTER-script
pattern (RLS + REVOKE in the same migration), and consider revoking the schema
default privileges so a future table can't silently re-open the hole. Re-run
`node scripts/rls-audit.mjs` after any schema change.

## Scripts

- `scripts/rls-audit.mjs` — read-only: RLS flag + policies + anon/auth grants per table.
- `scripts/rls-role-check.mjs` — read-only: confirms the app role bypasses RLS.
- `scripts/fix-rls-lockdown.mjs` — the fix (`--live` to apply; dry-run by default).
