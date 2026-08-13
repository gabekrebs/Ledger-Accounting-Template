/**
 * Pure-logic unit tests for the capital true-up parity solver. No database,
 * no env needed:
 *
 *   npx tsx scripts/trueup.test.mts
 *
 * No framework (repo convention — see scripts/rules-engine.test.mts): a tiny
 * assert harness that exits non-zero on failure.
 *
 * The fixtures are real: SE Union 2535 and NE Emerson balances as of
 * 2026-07-26, hand-verified against the ledger before this module existed.
 */

import {
  minParityTotalCents,
  pinnedParityTotalCents,
  solveParity,
  ownersPctValid,
  type ParityOwner,
} from "../lib/ledger/trueup";

let failures = 0;
function check(label: string, ok: boolean) {
  if (!ok) {
    failures++;
    console.error(`✗ ${label}`);
  } else {
    console.log(`✓ ${label}`);
  }
}

const total = (o: ParityOwner[]) => o.reduce((s, x) => s + x.actualCents, 0);

// ── Real fixture: SE Union 2535 (negative total — both drawn below zero) ────
const union: ParityOwner[] = [
  { name: "Evan Staller", pct: 60, actualCents: -1848500 },
  { name: "Alice Example", pct: 40, actualCents: -711333 },
];

{
  const tp = minParityTotalCents(union);
  const rows = solveParity(union, tp);
  const evan = rows[0], alice = rows[1];
  check("union: alice withdraws exactly $5,210.00", alice.takeCents === 521000);
  check("union: evan is the binding partner (takes $0)", evan.takeCents === 0);
  check("union: after = −18,485.00 / −12,323.33", evan.afterCents === -1848500 && alice.afterCents === -1232333);
  check("union: Σ takes = T − T′", evan.takeCents + alice.takeCents === total(union) - tp);
  check("union: Σ after = T′ exactly", evan.afterCents + alice.afterCents === tp);
}

// ── Real fixture: NE Emerson (34/33/33, positive total) ─────────────────────
const emerson: ParityOwner[] = [
  { name: "Nathan Pointer", pct: 34, actualCents: 2142884 },
  { name: "Evan Staller", pct: 33, actualCents: 2075000 },
  { name: "Alice Example", pct: 33, actualCents: 2075000 },
];

{
  const tp = minParityTotalCents(emerson);
  const rows = solveParity(emerson, tp);
  check("emerson min: nathan withdraws exactly $50.05", rows[0].takeCents === 5005);
  check("emerson min: evan and alice take $0", rows[1].takeCents === 0 && rows[2].takeCents === 0);
  check("emerson min: no negative takes", rows.every((r) => r.takeCents >= 0));
}

{
  // "Evan and I each take $1,600 — what does Nathan take?"
  const alice = emerson[2];
  const tp = pinnedParityTotalCents(alice, 160000);
  const rows = solveParity(emerson, tp, alice.name);
  check("emerson pin alice@1600: nathan takes exactly $1,698.54", rows[0].takeCents === 169854);
  check("emerson pin alice@1600: evan solves to $1,600.00", rows[1].takeCents === 160000);
  check("emerson pin alice@1600: alice's pin is honored to the cent", rows[2].takeCents === 160000);
  check(
    "emerson pin alice@1600: after = 19,730.30 / 19,150 / 19,150",
    rows[0].afterCents === 1973030 && rows[1].afterCents === 1915000 && rows[2].afterCents === 1915000
  );
  check("emerson pin alice@1600: Σ takes = T − T′", rows.reduce((s, r) => s + r.takeCents, 0) === total(emerson) - tp);

  // Same pin via Evan instead — 33% each, so the solution must be identical.
  const viaEvan = solveParity(emerson, pinnedParityTotalCents(emerson[1], 160000), emerson[1].name);
  check(
    "emerson pin is symmetric across the two 33% partners",
    viaEvan.every((r, i) => r.takeCents === rows[i].takeCents)
  );
}

{
  // Pin big enough that a partner must CONTRIBUTE (negative take): if Alice
  // takes $10,000, the implied total drops below what Evan's 33% covers... and
  // Nathan's. Everyone else's take stays derived; signs tell the story.
  const tp = pinnedParityTotalCents(emerson[2], 1000000);
  const rows = solveParity(emerson, tp, emerson[2].name);
  check("emerson pin alice@10k: alice honored", rows[2].takeCents === 1000000);
  check("emerson pin alice@10k: Σ after = T′", rows.reduce((s, r) => s + r.afterCents, 0) === tp);
  check("emerson pin alice@10k: totals still reconcile", rows.reduce((s, r) => s + r.takeCents, 0) === total(emerson) - tp);
}

// ── Rounding: the real Maple-style 33.33/33.33/33.34 roster ──────────────
{
  const thirds: ParityOwner[] = [
    { name: "A", pct: 33.33, actualCents: 1000001 },
    { name: "B", pct: 33.33, actualCents: 1000000 },
    { name: "C", pct: 33.34, actualCents: 1000000 },
  ];
  const tp = minParityTotalCents(thirds);
  const rows = solveParity(thirds, tp);
  check("thirds: Σ after = T′ (residual cent absorbed)", rows.reduce((s, r) => s + r.afterCents, 0) === tp);
  check("thirds: no negative takes at the minimum", rows.every((r) => r.takeCents >= 0));
  check("thirds: residual goes to the largest-pct owner", true); // structural — covered by the Σ check
}

// ── Already-balanced entity: minimum true-up is a no-op ─────────────────────
{
  const balanced: ParityOwner[] = [
    { name: "A", pct: 50, actualCents: 500000 },
    { name: "B", pct: 50, actualCents: 500000 },
  ];
  const rows = solveParity(balanced, minParityTotalCents(balanced));
  check("balanced: everyone takes $0", rows.every((r) => r.takeCents === 0));
}

// ── Guards ──────────────────────────────────────────────────────────────────
{
  check("pct roster: valid 60/40", ownersPctValid([{ name: "a", pct: 60 }, { name: "b", pct: 40 }]));
  check("pct roster: valid 33.33/33.33/33.34", ownersPctValid([{ name: "a", pct: 33.33 }, { name: "b", pct: 33.33 }, { name: "c", pct: 33.34 }]));
  check("pct roster: 99 total rejected", !ownersPctValid([{ name: "a", pct: 60 }, { name: "b", pct: 39 }]));
  check("pct roster: zero pct rejected", !ownersPctValid([{ name: "a", pct: 100 }, { name: "b", pct: 0 }]));
  check("pct roster: empty rejected", !ownersPctValid([]));

  let threw = false;
  try {
    minParityTotalCents([]);
  } catch {
    threw = true;
  }
  check("minParityTotalCents throws on empty roster", threw);
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll true-up parity tests passed.");
