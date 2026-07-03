# Proposal — database-enforced journal balance (defense in depth)

**Status: OPTIONAL, ships as a migration** —
`scripts/add-journal-balance-trigger.mjs`. Run it against your database to add a
defense-in-depth trigger enforcing per-entry balance at the storage layer. Run
the read-only pre-flight (below) first; it must return 0 rows. The migration
self-verifies with rolled-back probes (balanced commit passes, unbalanced commit
raises). Reversal: `DROP TRIGGER bk_journal_lines_balanced ON bk_journal_lines;
DROP FUNCTION bk_assert_entry_balanced();` — no data change.

## Problem

The application enforces Σdebit = Σcredit per journal entry (every writer
validates before commit — audited 2026-07, see below), but the DATABASE does
not. A bug in a future writer, a manual psql session, or a partial failure in
a non-transactional path could persist an unbalanced entry and nothing at the
storage layer would object.

A naive `CHECK` constraint can't express this (it spans rows), and a naive
per-row trigger would reject every multi-row insert mid-flight — while lines
of an entry are being inserted one-by-one, the entry is legitimately
unbalanced until the last line lands.

## Proposed design: `CONSTRAINT TRIGGER … DEFERRABLE INITIALLY DEFERRED`

A Postgres **constraint trigger** with `INITIALLY DEFERRED` timing runs at
**COMMIT time**, not per statement — so a multi-row atomic insert (header +
N lines in one transaction, which is how every writer now works) is checked
once, after all its lines exist:

```sql
CREATE OR REPLACE FUNCTION bk_assert_entry_balanced() RETURNS trigger AS $$
DECLARE
  dr bigint;
  cr bigint;
  entry_source text;
BEGIN
  SELECT COALESCE(SUM(debit_cents), 0), COALESCE(SUM(credit_cents), 0)
    INTO dr, cr
    FROM bk_journal_lines WHERE entry_id = COALESCE(NEW.entry_id, OLD.entry_id);
  SELECT source INTO entry_source
    FROM bk_journal_entries WHERE id = COALESCE(NEW.entry_id, OLD.entry_id);
  -- Entry deleted in the same txn (unpost) → nothing to check.
  IF entry_source IS NULL THEN RETURN NULL; END IF;
  -- Wave balance-sheet imports carry a documented ≤200¢ report-rounding
  -- residual; everything else must balance exactly.
  IF entry_source = 'wave_import' AND abs(dr - cr) <= 200 THEN RETURN NULL; END IF;
  IF dr <> cr THEN
    RAISE EXCEPTION 'journal entry % unbalanced: dr=% cr=%',
      COALESCE(NEW.entry_id, OLD.entry_id), dr, cr;
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER bk_journal_lines_balanced
  AFTER INSERT OR UPDATE OR DELETE ON bk_journal_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION bk_assert_entry_balanced();
```

Notes:
- `FOR EACH ROW` on a constraint trigger still defers each queued event to
  commit; the redundant per-line re-checks of the same entry are cheap (an
  index scan on `entry_id`). If insert volume ever makes this measurable, a
  transition-table statement trigger is the optimization, at the cost of not
  being deferrable — the row-level deferred form is the correct semantics.
- The `wave_import` tolerance mirrors the parse/write-time gate in
  `lib/ledger/wave-balance-import.ts` (Wave's balance-sheet report rounds; the
  residual is accepted up to $2). Historical `qbo_import` rows are not
  re-validated (the trigger only fires on new writes).
- Amount edits never happen in-app (`editTransaction` only re-points
  `account_id`), so the UPDATE arm is pure belt-and-braces.

## Pre-flight (run BEFORE applying, read-only)

```sql
SELECT e.id, e.source, SUM(l.debit_cents) dr, SUM(l.credit_cents) cr
FROM bk_journal_entries e JOIN bk_journal_lines l ON l.entry_id = e.id
GROUP BY e.id, e.source
HAVING SUM(l.debit_cents) <> SUM(l.credit_cents)
   AND NOT (e.source = 'wave_import'
            AND abs(SUM(l.debit_cents) - SUM(l.credit_cents)) <= 200);
```

Any rows returned are pre-existing unbalanced entries that must be understood
(and corrected with reversing entries, never rewrites) before the trigger can
be enabled — otherwise unrelated future transactions touching those entries'
lines would start failing.

## Migration protocol

Ship as an idempotent `scripts/add-journal-balance-trigger.mjs` following
ARCHITECTURE.md § 12 (direct ALTER; this one needs no RLS step since it adds
no table). Run the pre-flight, run the migration, then re-run the writer test
suites. **Do not apply without the owner's explicit go-ahead.**

## Application-layer audit (2026-07)

Every journal writer was audited; after this change-set all of them run the
header + lines in a single `db.transaction` and validate balance (explicitly
or by construction) before commit:

| Writer | Atomic | Balance check |
|---|---|---|
| `lib/ledger/manual-entry.ts` `createManualEntry` | yes | explicit Σdr=Σcr pre-check |
| `lib/plaid/post.ts` `postPlaidTransaction` | yes | 2 mirror lines by construction |
| `lib/plaid/post.ts` `postPlaidTransactionSplit` | yes | split total must equal amount |
| `lib/plaid/post.ts` `postPlaidTransactionEntry` | yes | explicit Σdr=Σcr check |
| `lib/ledger/wave-import.ts` `importWaveEntries` | yes (fixed 2026-07) | explicit per-entry Σdr=Σcr (fixed 2026-07) |
| `lib/ledger/wave-balance-import.ts` `importWaveBalances` | yes (fixed 2026-07) | parse gate + write-time backstop, ≤200¢ documented residual (fixed 2026-07) |
| `lib/ledger/edit-transaction.ts` `editTransaction` / `revertTransaction` | yes | re-points accounts only; asserts Σdr=Σcr backstop |
| `lib/plaid/post.ts` `unpostPlaidTransaction`, `lib/ledger/manual-entry.ts` `deleteManualEntry`, `lib/ledger/balance-health.ts` opening-entry deletes | yes (whole-entry deletes) | trivially preserved |
| `lib/ledger/reconcile.ts` clearing marks | yes | never touches amounts |

(The former `lib/ledger/suspense-merge.ts` — non-atomic, no post-merge balance
assertion — was removed entirely in this change-set.)
