/**
 * Regression tests for Plaid account → entity/ledger-account assignment
 * (lib/plaid/assign.ts).
 *
 * Part 1 (always runs, no DB): parseAssignmentValue — malformed combined form
 * values must THROW, never silently unassign.
 *
 * Part 2 (TEST_DATABASE_URL-gated, repo convention): assignPlaidAccount must
 * reject a ledger account that belongs to a different entity, an inactive
 * account, a non-asset/liability account, and mismatched/malformed pairs —
 * and accept a correct pairing.
 *
 *   TEST_DATABASE_URL=postgres://… npx tsx scripts/plaid-assign.test.mts
 */
const TEST_URL = process.env.TEST_DATABASE_URL;
// Satisfy the db client's load-time env check for the pure part.
if (!TEST_URL && !process.env.SUPABASE_DB_URL) {
  process.env.SUPABASE_DB_URL = "postgres://u:p@127.0.0.1:5432/none";
}
if (TEST_URL) process.env.SUPABASE_DB_URL = TEST_URL;

import { randomUUID } from "crypto";
const { parseAssignmentValue, assignPlaidAccount } = await import("../lib/plaid/assign");

let pass = 0;
const fails: string[] = [];
const ok = (c: boolean, m: string) => (c ? pass++ : fails.push(m));
function throws(fn: () => unknown, msg: string) {
  try {
    fn();
    fails.push(`${msg} — did not throw`);
  } catch {
    pass++;
  }
}
async function rejects(p: Promise<unknown>, msg: string) {
  try {
    await p;
    fails.push(`${msg} — did not throw`);
  } catch {
    pass++;
  }
}

// ── Part 1: combined-value parsing (pure) ────────────────────────────────────
const e = randomUUID();
const a = randomUUID();
ok(
  JSON.stringify(parseAssignmentValue("")) ===
    JSON.stringify({ entityId: null, mappedAccountId: null }),
  "empty value = explicit unassign"
);
ok(
  JSON.stringify(parseAssignmentValue(`${e}:${a}`)) ===
    JSON.stringify({ entityId: e, mappedAccountId: a }),
  "well-formed pair parses"
);
throws(() => parseAssignmentValue("garbage-no-colon"), "missing ':' throws (not silent unassign)");
throws(() => parseAssignmentValue(`:${a}`), "empty entity part throws");
throws(() => parseAssignmentValue(`${e}:`), "empty account part throws");

// Non-UUID pieces parse (parser is shape-only) but must be rejected by the writer:
await rejects(assignPlaidAccount(e, "not-a-uuid", a), "non-uuid entityId rejects before any query");
await rejects(assignPlaidAccount(e, a, "also-not-a-uuid"), "non-uuid accountId rejects before any query");
await rejects(assignPlaidAccount("bogus-row-id", null, null), "non-uuid plaid row id rejects");
await rejects(assignPlaidAccount(e, a, null), "entity without account (mismatched pair) rejects");
await rejects(assignPlaidAccount(e, null, a), "account without entity (mismatched pair) rejects");

// ── Part 2: entity↔account pairing (needs a disposable DB) ───────────────────
if (!TEST_URL) {
  console.log("SKIP plaid-assign DB pairing tests: set TEST_DATABASE_URL to run.");
} else {
  const { db, schema } = await import("../lib/db/client");
  const { eq } = await import("drizzle-orm");
  const mkEntity = async (name: string) =>
    (
      await db
        .insert(schema.bkLedgerEntities)
        .values({ realmId: `test:${randomUUID()}`, name })
        .returning({ id: schema.bkLedgerEntities.id })
    )[0].id;
  const entityA = await mkEntity("ASSIGN TEST A");
  const entityB = await mkEntity("ASSIGN TEST B");
  let itemId: string | null = null;
  try {
    const mkAcct = async (
      entityId: string,
      name: string,
      classification: string,
      active = true
    ) =>
      (
        await db
          .insert(schema.bkAccounts)
          .values({
            entityId,
            qboAccountId: `test:${randomUUID()}`,
            name,
            accountType: classification === "expense" ? "Expense" : "Bank",
            normalBalance: "debit",
            classification,
            active,
          })
          .returning({ id: schema.bkAccounts.id })
      )[0].id;
    const bankA = await mkAcct(entityA, "A Checking", "asset");
    const bankB = await mkAcct(entityB, "B Checking", "asset");
    const inactiveA = await mkAcct(entityA, "A Old", "asset", false);
    const expenseA = await mkAcct(entityA, "A Utilities", "expense");

    const [item] = await db
      .insert(schema.bkPlaidItems)
      .values({
        plaidItemId: `test:${randomUUID()}`,
        accessToken: "test-token",
        institutionName: "Test Bank",
      })
      .returning({ id: schema.bkPlaidItems.id });
    itemId = item.id;
    const [plaidAcct] = await db
      .insert(schema.bkPlaidAccounts)
      .values({
        itemId: item.id,
        plaidAccountId: `test:${randomUUID()}`,
        name: "Checking",
        mask: "0001",
      })
      .returning({ id: schema.bkPlaidAccounts.id });

    const current = async () =>
      (
        await db
          .select({
            entityId: schema.bkPlaidAccounts.entityId,
            mappedAccountId: schema.bkPlaidAccounts.mappedAccountId,
          })
          .from(schema.bkPlaidAccounts)
          .where(eq(schema.bkPlaidAccounts.id, plaidAcct.id))
      )[0];

    await rejects(
      assignPlaidAccount(plaidAcct.id, entityA, bankB),
      "cross-entity pair (A's entity, B's account) rejects"
    );
    await rejects(
      assignPlaidAccount(plaidAcct.id, entityA, inactiveA),
      "inactive ledger account rejects"
    );
    await rejects(
      assignPlaidAccount(plaidAcct.id, entityA, expenseA),
      "non-asset/liability ledger account rejects"
    );
    await rejects(
      assignPlaidAccount(plaidAcct.id, entityA, randomUUID()),
      "nonexistent ledger account rejects"
    );
    let row = await current();
    ok(row.entityId === null && row.mappedAccountId === null,
      "no partial assignment written by any rejected attempt");

    await assignPlaidAccount(plaidAcct.id, entityA, bankA);
    row = await current();
    ok(row.entityId === entityA && row.mappedAccountId === bankA,
      "correct same-entity pair assigns");

    await assignPlaidAccount(plaidAcct.id, null, null);
    row = await current();
    ok(row.entityId === null && row.mappedAccountId === null, "explicit unassign clears both");
  } finally {
    // Scoped cleanup only — never a bare delete, even on a disposable DB.
    if (itemId) {
      await db.delete(schema.bkPlaidItems).where(eq(schema.bkPlaidItems.id, itemId)); // bk_plaid_accounts cascade
    }
    await db.delete(schema.bkLedgerEntities).where(eq(schema.bkLedgerEntities.id, entityA));
    await db.delete(schema.bkLedgerEntities).where(eq(schema.bkLedgerEntities.id, entityB));
  }
}

if (fails.length) {
  console.error(`FAIL (${fails.length}):`);
  for (const f of fails) console.error("  ✗ " + f);
  process.exit(1);
}
console.log(`plaid-assign: ${pass} assertions passed`);
process.exit(0);
