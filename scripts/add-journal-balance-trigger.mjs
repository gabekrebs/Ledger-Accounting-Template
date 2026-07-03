/**
 * DB-enforced journal balance — defense in depth behind the app-layer checks.
 * Design + rationale: docs/journal-balance-constraint.md.
 *
 * A DEFERRABLE INITIALLY DEFERRED constraint trigger checks Σdebit = Σcredit
 * per entry at COMMIT time, so multi-row atomic inserts (header + N lines in
 * one transaction — every writer) are validated once, after all lines exist.
 * Wave balance-sheet imports keep their documented ≤200¢ report-rounding
 * tolerance. Fully reversible: DROP TRIGGER + DROP FUNCTION, no data change.
 *
 * Pre-flight (run first; must return 0 rows — verified clean 2026-07-01):
 *   SELECT e.id FROM bk_journal_entries e JOIN bk_journal_lines l ON l.entry_id = e.id
 *   GROUP BY e.id, e.source
 *   HAVING SUM(l.debit_cents) <> SUM(l.credit_cents)
 *      AND NOT (e.source = 'wave_import' AND abs(SUM(l.debit_cents) - SUM(l.credit_cents)) <= 200);
 *
 * Direct ALTER (not drizzle-kit). Idempotent — safe to re-run. No new table,
 * so no RLS step needed.
 *
 *   node scripts/add-journal-balance-trigger.mjs
 */
import { readFileSync } from "fs";
import postgres from "postgres";

const env = readFileSync(".env.local", "utf8");
const url = env
  .match(/^SUPABASE_DB_URL=(.*)$/m)[1]
  .trim()
  .replace(/^["']|["']$/g, "")
  .replace(/\\n$/, "");
const sql = postgres(url, { ssl: "require", max: 1 });

try {
  await sql.begin(async (tx) => {
    await tx`
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
        -- Entry deleted in the same txn (unpost / delete) → nothing to check.
        IF entry_source IS NULL THEN RETURN NULL; END IF;
        -- Wave balance-sheet imports carry a documented ≤200¢ report-rounding
        -- residual (lib/ledger/wave-balance-import.ts); all else is exact.
        IF entry_source = 'wave_import' AND abs(dr - cr) <= 200 THEN RETURN NULL; END IF;
        IF dr <> cr THEN
          RAISE EXCEPTION 'journal entry % unbalanced: dr=% cr=%',
            COALESCE(NEW.entry_id, OLD.entry_id), dr, cr;
        END IF;
        RETURN NULL;
      END $$ LANGUAGE plpgsql`;

    await tx`
      DROP TRIGGER IF EXISTS bk_journal_lines_balanced ON bk_journal_lines`;
    await tx`
      CREATE CONSTRAINT TRIGGER bk_journal_lines_balanced
        AFTER INSERT OR UPDATE OR DELETE ON bk_journal_lines
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION bk_assert_entry_balanced()`;
  });
  console.log("✓ bk_journal_lines_balanced constraint trigger installed");

  // Verification, all inside ONE rolled-back transaction: a balanced entry
  // commits the deferred check cleanly; an unbalanced one must raise. Nothing
  // is persisted either way.
  const [{ id: entityId }] =
    await sql`SELECT id FROM bk_ledger_entities LIMIT 1`;
  const [{ id: acctA }, { id: acctB }] =
    await sql`SELECT id FROM bk_accounts WHERE entity_id = ${entityId} LIMIT 2`;

  let balancedOk = false;
  try {
    await sql.begin(async (tx) => {
      const [e] = await tx`
        INSERT INTO bk_journal_entries (entity_id, source, qbo_txn_type, qbo_txn_id, txn_date, total_cents)
        VALUES (${entityId}, 'manual', 'TriggerCheck', ${"trigger-check-" + Date.now()}, '2000-01-01', 100)
        RETURNING id`;
      await tx`INSERT INTO bk_journal_lines (entry_id, account_id, line_no, debit_cents, credit_cents)
               VALUES (${e.id}, ${acctA}, 1, 100, 0), (${e.id}, ${acctB}, 2, 0, 100)`;
      await tx`SET CONSTRAINTS ALL IMMEDIATE`; // force the deferred check NOW
      balancedOk = true;
      throw new Error("rollback"); // never persist the probe
    });
  } catch (e) {
    if (e.message !== "rollback") throw e;
  }
  console.log(balancedOk ? "✓ balanced entry passes the trigger" : "✗ balanced entry FAILED");

  let unbalancedRejected = false;
  try {
    await sql.begin(async (tx) => {
      const [e] = await tx`
        INSERT INTO bk_journal_entries (entity_id, source, qbo_txn_type, qbo_txn_id, txn_date, total_cents)
        VALUES (${entityId}, 'manual', 'TriggerCheck', ${"trigger-check-bad-" + Date.now()}, '2000-01-01', 100)
        RETURNING id`;
      await tx`INSERT INTO bk_journal_lines (entry_id, account_id, line_no, debit_cents, credit_cents)
               VALUES (${e.id}, ${acctA}, 1, 100, 0), (${e.id}, ${acctB}, 2, 0, 99)`;
      await tx`SET CONSTRAINTS ALL IMMEDIATE`;
    });
  } catch (e) {
    unbalancedRejected = /unbalanced/.test(e.message ?? "");
    if (!unbalancedRejected) throw e;
  }
  console.log(
    unbalancedRejected
      ? "✓ unbalanced entry rejected by the trigger (and rolled back)"
      : "✗ unbalanced entry was NOT rejected"
  );
  if (!balancedOk || !unbalancedRejected) process.exit(1);
} finally {
  await sql.end();
}
