/**
 * /review cross-entity Review Queue — data-layer tests.
 *   • pendingCountsByEntity respects the ids scope EXACTLY (only requested
 *     entities come back; empty set → empty map) — the page's authorization
 *     boundary depends on this.
 *   • counts agree with listPendingTransactions (same definition of pending).
 *   • buildEntityReviewData row count matches its own pendingCount.
 *
 *   node --env-file=.env.local ./node_modules/.bin/tsx scripts/review-queue.test.mts
 */
import fs from "fs";
import assert from "node:assert";
for (const line of fs.readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const postgres = (await import("postgres")).default;
const { pendingCountsByEntity, buildEntityReviewData } = await import("../lib/plaid/review-data");
const { listPendingTransactions } = await import("../lib/plaid/data");
const sql = postgres((process.env.SUPABASE_DB_URL || "").replace(/\s+/g, ""), { prepare: false });
let pass = 0;
const ok = (s: string) => { pass++; console.log(`  ✓ ${s}`); };

// Scope: empty set → empty map (a user with no entities sees nothing).
assert.equal((await pendingCountsByEntity(new Set())).size, 0);
ok("empty accessible set → zero counts (no data leaks to entity-less users)");

// Scope: a subset request returns ONLY that subset, even when others have pending.
const all = await pendingCountsByEntity("all");
if (all.size >= 2) {
  const [first] = [...all.keys()];
  const scoped = await pendingCountsByEntity(new Set([first]));
  assert.deepEqual([...scoped.keys()], [first], "scoped counts leak other entities");
  assert.equal(scoped.get(first), all.get(first));
  ok(`subset scoping returns exactly the requested entity (${scoped.get(first)} pending)`);
} else {
  ok("subset scoping (skipped — fewer than 2 entities with pending)");
}

// Definition agreement: grouped counts == listPendingTransactions lengths
// (up to that function's 200 cap).
let checked = 0;
for (const [entityId, n] of all) {
  const list = await listPendingTransactions(entityId);
  const expected = Math.min(n, 200);
  assert.equal(list.length, expected, `${entityId}: count ${n} vs list ${list.length}`);
  const built = await buildEntityReviewData(entityId);
  assert.equal(built.reviewRows.length, built.pendingCount);
  checked++;
}
ok(`counts agree with listPendingTransactions + builder for ${checked} entities`);

// settledOnly excludes bank-pending rows (the /review page + badge contract).
const allSettled = await pendingCountsByEntity("all", { settledOnly: true });
for (const [entityId, n] of allSettled) {
  const list = await listPendingTransactions(entityId);
  const settled = list.filter((t) => !t.pending).length;
  // listPendingTransactions caps at 200; only assert when uncapped.
  if (list.length < 200) assert.equal(n, settled, `${entityId}: settledOnly count`);
  assert(n <= (all.get(entityId) ?? 0), "settledOnly never exceeds full count");
}
ok(`settledOnly counts exclude bank-pending rows (${allSettled.size} entities)`);

console.log(`\nAll ${pass} checks passed.`);
await sql.end();
