/**
 * Authorization regression tests for the valuation mutations
 * (lib/ledger/valuation.ts). Proves every ID-based mutation is scoped by BOTH
 * the resource id and the authorized entity: a componentId belonging to another
 * entity is indistinguishable from a nonexistent one (same generic error), and
 * a malformed id never reaches Postgres as a cast error.
 *
 * The server actions (app/ledger/[entityId]/valuation/actions.ts) call
 * assertEntityAccess(entityId) and then pass that SAME entityId here — so these
 * lib-layer checks are what stops a caller authorized for entity A from
 * mutating entity B's rows by submitting B's componentId.
 *
 * SAFETY: writes fixtures — runs ONLY against a disposable database.
 * Requires TEST_DATABASE_URL and SKIPS if unset (repo convention; see
 * rules-atomicity.test.mts).
 *
 *   TEST_DATABASE_URL=postgres://… npx tsx scripts/valuation-authz.test.mts
 */
const TEST_URL = process.env.TEST_DATABASE_URL;
if (!TEST_URL) {
  console.log("SKIP valuation-authz: set TEST_DATABASE_URL (a disposable DB) to run.");
  process.exit(0);
}
process.env.SUPABASE_DB_URL = TEST_URL;

import { randomUUID } from "crypto";
import { eq, and } from "drizzle-orm";
const { db, schema } = await import("../lib/db/client");
const {
  addComponent,
  updateComponent,
  deleteComponent,
  setEstimate,
  setComponentFacts,
} = await import("../lib/ledger/valuation");

let pass = 0;
const fails: string[] = [];
const ok = (c: boolean, m: string) => (c ? pass++ : fails.push(m));
const GENERIC = "valuation component not found";
async function rejectsGeneric(p: Promise<unknown>, msg: string) {
  try {
    await p;
    fails.push(`${msg} — did not throw`);
  } catch (e) {
    ok(e instanceof Error && e.message === GENERIC, `${msg} — got "${e instanceof Error ? e.message : e}"`);
  }
}

// ── fixtures: two entities, one component each ───────────────────────────────
const mkEntity = async (name: string) =>
  (
    await db
      .insert(schema.bkLedgerEntities)
      .values({ realmId: `test:${randomUUID()}`, name })
      .returning({ id: schema.bkLedgerEntities.id })
  )[0].id;
const entityA = await mkEntity("VALUATION AUTHZ TEST A");
const entityB = await mkEntity("VALUATION AUTHZ TEST B");

try {
  const compA = await addComponent(entityA, {
    label: "A House",
    address: "1 A St",
    zillowUrl: null,
    redfinUrl: null,
  });
  const compB = await addComponent(entityB, {
    label: "B House",
    address: "2 B St",
    zillowUrl: null,
    redfinUrl: null,
  });
  const fields = { label: "X", address: null, zillowUrl: null, redfinUrl: null, chosenSource: null };
  const facts = {
    propertyType: null, units: null, beds: null, baths: null,
    sqft: null, monthlyRent: null, condition: null, factsNote: "probe",
  };

  // ── cross-entity: caller authorized for A submits B's componentId ──────────
  await rejectsGeneric(updateComponent(entityA, compB, fields), "updateComponent cross-entity rejects");
  await rejectsGeneric(deleteComponent(entityA, compB), "deleteComponent cross-entity rejects");
  await rejectsGeneric(setEstimate(entityA, compB, "manual", 100_00), "setEstimate cross-entity rejects");
  await rejectsGeneric(setComponentFacts(entityA, compB, facts), "setComponentFacts cross-entity rejects");

  // ── nonexistent id: SAME error as foreign (no existence leak) ──────────────
  const ghost = randomUUID();
  await rejectsGeneric(updateComponent(entityA, ghost, fields), "updateComponent ghost id rejects identically");
  await rejectsGeneric(deleteComponent(entityA, ghost), "deleteComponent ghost id rejects identically");
  await rejectsGeneric(setEstimate(entityA, ghost, "manual", 1), "setEstimate ghost id rejects identically");

  // ── malformed id: generic error, never a pg uuid cast error ────────────────
  await rejectsGeneric(updateComponent(entityA, "not-a-uuid", fields), "updateComponent malformed id rejects");
  await rejectsGeneric(deleteComponent(entityA, "'; DROP TABLE--"), "deleteComponent malformed id rejects");
  await rejectsGeneric(setEstimate(entityA, "", "manual", 1), "setEstimate blank id rejects");
  await rejectsGeneric(setComponentFacts(entityA, "42", facts), "setComponentFacts malformed id rejects");

  // ── B's data is untouched by all the probing above ─────────────────────────
  const bRows = await db
    .select()
    .from(schema.bkValuationComponents)
    .where(eq(schema.bkValuationComponents.id, compB));
  ok(bRows.length === 1 && bRows[0].label === "B House" && bRows[0].factsNote === null,
    "entity B's component unmodified after cross-entity probes");
  const bEsts = await db
    .select()
    .from(schema.bkValuationEstimates)
    .where(eq(schema.bkValuationEstimates.componentId, compB));
  ok(bEsts.length === 0, "no estimate written onto entity B's component");

  // ── correctly-scoped calls still work ──────────────────────────────────────
  await updateComponent(entityA, compA, { ...fields, label: "A House v2" });
  await setEstimate(entityA, compA, "manual", 250_000_00, { asOf: "2026-07-01" });
  await setComponentFacts(entityA, compA, { ...facts, factsNote: "own" });
  const aRow = (
    await db
      .select()
      .from(schema.bkValuationComponents)
      .where(eq(schema.bkValuationComponents.id, compA))
  )[0];
  ok(aRow.label === "A House v2" && aRow.factsNote === "own", "same-entity update/facts apply");
  const aEst = await db
    .select()
    .from(schema.bkValuationEstimates)
    .where(
      and(
        eq(schema.bkValuationEstimates.componentId, compA),
        eq(schema.bkValuationEstimates.source, "manual")
      )
    );
  ok(aEst.length === 1 && aEst[0].valueCents === 250_000_00, "same-entity estimate upserts");
  await deleteComponent(entityA, compA);
  const gone = await db
    .select({ id: schema.bkValuationComponents.id })
    .from(schema.bkValuationComponents)
    .where(eq(schema.bkValuationComponents.id, compA));
  ok(gone.length === 0, "same-entity delete applies");
} finally {
  await db.delete(schema.bkLedgerEntities).where(eq(schema.bkLedgerEntities.id, entityA));
  await db.delete(schema.bkLedgerEntities).where(eq(schema.bkLedgerEntities.id, entityB)); // components/estimates cascade
}

if (fails.length) {
  console.error(`FAIL (${fails.length}):`);
  for (const f of fails) console.error("  ✗ " + f);
  process.exit(1);
}
console.log(`valuation-authz: ${pass} assertions passed`);
process.exit(0);
