/**
 * Integration tests for Findings 2 & 3 — atomic rule application + learning.
 *
 * Proves: (1) a failure after the ledger post rolls the post BACK (no partial
 * write — no posted txn without its audit event / counter); (2) a retry is
 * idempotent (exactly one journal entry, one audit event, counter bumped once);
 * (3) concurrent applies of the same txn produce exactly one success + one
 * failure (the FOR UPDATE lock serializes them), never a double-post.
 *
 * SAFETY: this writes fixtures, so it runs ONLY against a disposable database.
 * It refuses to touch production: it requires TEST_DATABASE_URL (a throwaway DB
 * with the migrated schema) and SKIPS if unset. It never reads SUPABASE_DB_URL.
 *
 *   TEST_DATABASE_URL=postgres://… npx tsx scripts/rules-atomicity.test.mts
 */
const TEST_URL = process.env.TEST_DATABASE_URL;
if (!TEST_URL) {
  console.log("SKIP rules-atomicity: set TEST_DATABASE_URL (a disposable DB) to run.");
  process.exit(0);
}
// Point the shared db client at the throwaway DB BEFORE importing it.
process.env.SUPABASE_DB_URL = TEST_URL;

import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
const { db, schema } = await import("../lib/db/client");
const { postPlaidTransaction } = await import("../lib/plaid/post");
const { applyRuleToTxn } = await import("../lib/rules/apply");
const { newCanonCache } = await import("../lib/rules/actions");
import type { RuleRow } from "../lib/rules/engine";

let pass = 0;
const fails: string[] = [];
const ok = (c: boolean, m: string) => (c ? pass++ : fails.push(m));

// ── fixtures (all carry a recognizable test- prefix, deleted at the end) ──────
const realmId = `test:${randomUUID()}`;
const [entity] = await db
  .insert(schema.bkLedgerEntities)
  .values({ realmId, name: "ATOMICITY TEST" })
  .returning({ id: schema.bkLedgerEntities.id });
const entityId = entity.id;

const mkAcct = async (name: string, type: string, cls: string, normal: string) =>
  (
    await db
      .insert(schema.bkAccounts)
      .values({
        entityId,
        qboAccountId: `test:${randomUUID()}`,
        name,
        accountType: type,
        normalBalance: normal,
        classification: cls,
      })
      .returning({ id: schema.bkAccounts.id })
  )[0].id;
const bankAcctId = await mkAcct("Test Checking", "Bank", "asset", "debit");
const catAcctId = await mkAcct("Test Utilities", "Expense", "expense", "debit");

const [item] = await db
  .insert(schema.bkPlaidItems)
  .values({ plaidItemId: `test:${randomUUID()}`, accessToken: "test", entityId })
  .returning({ id: schema.bkPlaidItems.id });
const plaidAccountId = `test:${randomUUID()}`;
await db.insert(schema.bkPlaidAccounts).values({
  itemId: item.id,
  entityId,
  plaidAccountId,
  mappedAccountId: bankAcctId,
});

const [rule] = await db
  .insert(schema.bkRules)
  .values({
    scope: "entity",
    entityId,
    name: "test rule",
    predicate: { all: [{ field: "merchant", op: "eq", value: "testco" }] },
    action: { kind: "categorize", target: { by: "account", accountId: catAcctId } },
  })
  .returning();

const mkTxn = async () => {
  const id = randomUUID();
  await db.insert(schema.bkPlaidTransactions).values({
    entityId,
    plaidAccountId,
    plaidTransactionId: `test:${id}`,
    txnDate: "2026-06-30",
    name: "TESTCO",
    merchantName: "TestCo",
    amountCents: 5000,
    status: "pending_review",
  });
  const [row] = await db
    .select({ id: schema.bkPlaidTransactions.id })
    .from(schema.bkPlaidTransactions)
    .where(eq(schema.bkPlaidTransactions.plaidTransactionId, `test:${id}`));
  return row.id;
};
const status = async (txnId: string) =>
  (
    await db
      .select({ s: schema.bkPlaidTransactions.status })
      .from(schema.bkPlaidTransactions)
      .where(eq(schema.bkPlaidTransactions.id, txnId))
  )[0].s;
const countEvents = async (txnId: string) =>
  (await db.select().from(schema.bkCategorizationEvents).where(eq(schema.bkCategorizationEvents.plaidTxnId, txnId))).length;
const appliedCount = async () =>
  (await db.select().from(schema.bkRules).where(eq(schema.bkRules.id, rule.id)))[0].appliedCount;

try {
  // ── 1. FAILURE INJECTION: a throw after the post rolls the post back ──────
  {
    const txnId = await mkTxn();
    try {
      await db.transaction(async (tx) => {
        await postPlaidTransaction(txnId, catAcctId, "plaid", null, tx);
        throw new Error("injected failure after post");
      });
    } catch {
      /* expected */
    }
    ok((await status(txnId)) === "pending_review", "atomicity: post rolled back to pending_review");
    ok((await countEvents(txnId)) === 0, "atomicity: no audit event left behind");
  }

  // ── 2. IDEMPOTENT RETRY: a second apply throws, no double write ───────────
  {
    const txnId = await mkTxn();
    const before = await appliedCount();
    await applyRuleToTxn(txnId, rule as RuleRow, "plaid", newCanonCache());
    let secondThrew = false;
    try {
      await applyRuleToTxn(txnId, rule as RuleRow, "plaid", newCanonCache());
    } catch {
      secondThrew = true;
    }
    ok(secondThrew, "idempotency: retry of an already-posted txn throws");
    ok((await status(txnId)) === "posted", "idempotency: txn posted exactly once");
    ok((await countEvents(txnId)) === 1, "idempotency: exactly one audit event");
    ok((await appliedCount()) === before + 1, "idempotency: counter bumped exactly once");
  }

  // ── 3. CONCURRENCY: two simultaneous applies → one wins, one fails ────────
  {
    const txnId = await mkTxn();
    const results = await Promise.allSettled([
      applyRuleToTxn(txnId, rule as RuleRow, "plaid", newCanonCache()),
      applyRuleToTxn(txnId, rule as RuleRow, "plaid", newCanonCache()),
    ]);
    const wins = results.filter((r) => r.status === "fulfilled").length;
    ok(wins === 1, `concurrency: exactly one apply succeeded (got ${wins})`);
    ok((await countEvents(txnId)) === 1, "concurrency: exactly one audit event");
  }
} finally {
  // ── cleanup: remove every fixture (journal entries cascade from entity) ───
  await db.delete(schema.bkCategorizationEvents).where(eq(schema.bkCategorizationEvents.entityId, entityId));
  await db.delete(schema.bkPlaidTransactions).where(eq(schema.bkPlaidTransactions.entityId, entityId));
  await db.delete(schema.bkPlaidItems).where(eq(schema.bkPlaidItems.entityId, entityId));
  await db.delete(schema.bkRules).where(eq(schema.bkRules.entityId, entityId));
  await db.delete(schema.bkLedgerEntities).where(eq(schema.bkLedgerEntities.id, entityId)); // journal_entries/lines/accounts cascade
}

if (fails.length) {
  console.error(`\n❌ ${fails.length} failed (${pass} passed):`);
  for (const f of fails) console.error("  • " + f);
  await db.$client.end();
  process.exit(1);
}
console.log(`✅ rules-atomicity: all ${pass} assertions passed`);
await db.$client.end();
