/**
 * `sync_excluded` on bk_plaid_accounts — a per-account "never store
 * transactions" switch for accounts that came along with a bank login but
 * must stay out of the books entirely (owner request 2026-07-11: Barclays
 * forces all accounts under one login; the personal Skywards Mastercard
 * ··3527 must not be downloaded or saved).
 *
 * sync.ts skips storing txns for excluded accounts; this migration also
 * flags the Skywards card and PURGES its already-staged rows (all inert —
 * entity_id null, nothing ever posted from them).
 *
 * Idempotent — safe to re-run.   node scripts/add-sync-excluded.mjs
 */
import { readFileSync } from "fs";
import postgres from "postgres";

const env = readFileSync(".env.local", "utf8");
const url = env
  .match(/^SUPABASE_DB_URL=(.*)$/m)[1]
  .trim()
  .replace(/^["']|["']$/g, "");
const sql = postgres(url, { ssl: "require", max: 1 });

await sql.begin(async (sql) => {
  await sql`ALTER TABLE bk_plaid_accounts
    ADD COLUMN IF NOT EXISTS sync_excluded boolean NOT NULL DEFAULT false`;

  // Flag the personal Skywards Mastercard (Barclays ··3527).
  const flagged = await sql`UPDATE bk_plaid_accounts
    SET sync_excluded = true, updated_at = now()
    WHERE name = 'Skywards Mastercard' AND mask = '3527' AND entity_id IS NULL
    RETURNING plaid_account_id`;
  console.log(`flagged ${flagged.length} account(s) as sync-excluded`);

  // Purge its staged transactions — guard: ONLY unposted rows on the excluded
  // account (a journal-linked row must never be deleted; none exist since the
  // account was never assigned to an entity).
  if (flagged.length) {
    const ids = flagged.map((r) => r.plaid_account_id);
    const purged = await sql`DELETE FROM bk_plaid_transactions
      WHERE plaid_account_id = ANY(${ids})
        AND journal_entry_id IS NULL
        AND status <> 'posted'
      RETURNING id`;
    console.log(`purged ${purged.length} staged transactions`);
  }
});

console.log("add-sync-excluded: done");
await sql.end();
