/**
 * Unit tests for the ADR-021 AI pipeline's PURE logic — bucket keys, the
 * calibrated-display rule, and the similar-transaction scorer. No journal
 * writes; safe anywhere.
 *
 *   node --env-file=.env.local ./node_modules/.bin/tsx scripts/ai-pipeline.test.mts
 */
import assert from "node:assert/strict";
import { bucketKeyFor, confidenceBand } from "../lib/ai/events";
import { calibratedDisplay, CALIBRATED_MIN_OUTCOMES } from "../lib/ai/calibration";
import { similarFor, type Precedent } from "../lib/ai/similar";

let passed = 0;
function ok(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

// ── bucket keys ───────────────────────────────────────────────────────────────
ok("confidence bands split at decade boundaries", () => {
  assert.equal(confidenceBand(0.95), "b90");
  assert.equal(confidenceBand(0.9), "b90");
  assert.equal(confidenceBand(0.89), "b80");
  assert.equal(confidenceBand(0.6), "b60");
  assert.equal(confidenceBand(0.2), "blo");
});
ok("bucket key encodes source, seen axis, band", () => {
  assert.equal(bucketKeyFor("ai", true, 0.92), "ai|seen|b90");
  assert.equal(bucketKeyFor("ai", false, 0.92), "ai|new|b90");
  assert.equal(bucketKeyFor("history", true, 0.85), "history|seen|b80");
});

// ── calibrated display ────────────────────────────────────────────────────────
ok("raw % shown (unproven) until the bucket has enough outcomes", () => {
  const thin = {
    bucketKey: "ai|seen|b90", status: "shadow", outcomes: CALIBRATED_MIN_OUTCOMES - 1,
    correct: 20, measuredPrecision: 0.7, unlockedAt: null, lockedAt: null, lockReason: null,
  };
  const d = calibratedDisplay(0.92, thin);
  assert.equal(d.calibrated, false);
  assert.equal(d.confidence, 0.92);
});
ok("measured precision replaces the model's number once proven", () => {
  const proven = {
    bucketKey: "ai|seen|b90", status: "shadow", outcomes: 40,
    correct: 34, measuredPrecision: 0.85, unlockedAt: null, lockedAt: null, lockReason: null,
  };
  const d = calibratedDisplay(0.92, proven);
  assert.equal(d.calibrated, true);
  assert.equal(d.confidence, 0.85);
});
ok("no bucket row at all → raw, unproven", () => {
  const d = calibratedDisplay(0.8, undefined);
  assert.deepEqual(d, { confidence: 0.8, calibrated: false });
});

// ── similar-transaction scoring ───────────────────────────────────────────────
const P = (payee: string, amountCents: number, accountLabel: string, txnDate = "2025-06-01"): Precedent => ({
  merchantKey: payee.toLowerCase(), payee, amountCents, txnDate,
  accountId: `acct-${accountLabel}`, accountLabel,
});
const pool: Precedent[] = [
  P("home depot", 9210, "Repairs & Maintenance"),
  P("home depot", 780000, "CapEx: Improvements"),
  P("home depot", 3755, "Supplies"),
  P("nw natural", 8100, "Utilities:Gas"),
  P("city of portland", 145000, "Water & Sewer"),
];

ok("exact merchant match found; amount proximity ranks within it", () => {
  const picks = similarFor(
    { merchantName: "HOME DEPOT", name: null, amountCents: 18422 },
    pool,
    3
  );
  assert.ok(picks.length >= 2);
  // $92.10 and $37.55 are the log-scale neighbors of $184.22; the $7,800
  // renovation draw ranks last of the three.
  assert.equal(picks[0].amountCents, 9210);
  assert.notEqual(picks[0].accountLabel, "CapEx: Improvements");
});

ok("unrelated merchants never pad the results", () => {
  const picks = similarFor(
    { merchantName: "HOME DEPOT", name: null, amountCents: 18422 },
    pool,
    8
  );
  assert.ok(picks.every((p) => p.merchantKey.includes("home")));
});

ok("no merchant info → no precedents", () => {
  assert.deepEqual(
    similarFor({ merchantName: null, name: null, amountCents: 500 }, pool),
    []
  );
});

console.log(`\nai-pipeline: ${passed} assertions groups passed`);
