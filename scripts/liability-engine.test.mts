/**
 * Unit tests for the liability engine's pure split estimator
 * (lib/plaid/loan-match.ts). No database.
 *
 *   SUPABASE_DB_URL=postgres://u:p@127.0.0.1:5432/none npx tsx scripts/liability-engine.test.mts
 *
 * Fixtures are SYNTHETIC (round numbers, no real loan). The estimator formula:
 *   scheduledPI = expectedPayment − monthlyEscrow   (constant for a fixed rate)
 *   interest    = round(balance × rateBps / 120000)  (bps ÷ 12 months ÷ 10000)
 *   principal   = scheduledPI − interest
 *   escrow      = payment − scheduledPI              (residual, absorbs re-analysis)
 * The engine must reproduce a servicer's own arithmetic to the cent when the GL
 * balance equals their principal.
 */
import {
  estimateLiabilitySplit,
  paymentBandCents,
} from "../lib/plaid/loan-match";

let pass = 0;
const fails: string[] = [];
const ok = (c: boolean, m: string) => (c ? pass++ : fails.push(m));
const eq = (got: unknown, want: unknown, m: string) =>
  ok(JSON.stringify(got) === JSON.stringify(want), `${m} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

// ── ordinary month ───────────────────────────────────────────────────────────
// $600,000 balance, 5.00% (500 bps), $3,500 draft, $800 escrow.
// interest = round(60000000 × 500 / 120000) = 250000; P&I = 2700 → principal 200.
eq(
  estimateLiabilitySplit({
    amountCents: 350000,
    balanceCents: 60000000,
    annualRateBps: 500,
    expectedPaymentCents: 350000,
    monthlyEscrowCents: 80000,
    interestOnly: false,
  }),
  { interestCents: 250000, principalCents: 20000, escrowCents: 80000 },
  "ordinary month split reproduced exactly"
);

// ── escrow re-analysis (draft rises, expected still the OLD amount) ───────────
// The residual escrow absorbs the change the same month it happens, before the
// engine adopts the new payment. P&I is invariant. Balance $599,800.
eq(
  estimateLiabilitySplit({
    amountCents: 360000, // new higher draft
    balanceCents: 59980000,
    annualRateBps: 500,
    expectedPaymentCents: 350000, // pre-adoption (old expected)
    monthlyEscrowCents: 80000,
    interestOnly: false,
  }),
  { interestCents: 249917, principalCents: 20083, escrowCents: 90000 },
  "escrow re-analysis month: residual escrow absorbs the +$100, P&I exact"
);
// …and identically AFTER adoption (expected updated to the new draft/escrow):
eq(
  estimateLiabilitySplit({
    amountCents: 360000,
    balanceCents: 59980000,
    annualRateBps: 500,
    expectedPaymentCents: 360000,
    monthlyEscrowCents: 90000,
    interestOnly: false,
  }),
  { interestCents: 249917, principalCents: 20083, escrowCents: 90000 },
  "post-adoption terms give the identical split"
);

// ── no-escrow term loan (SBA-style) ──────────────────────────────────────────
// $200,000 @ 2.75%, $2,500 payment, no escrow.
eq(
  estimateLiabilitySplit({
    amountCents: 250000,
    balanceCents: 20000000,
    annualRateBps: 275,
    expectedPaymentCents: 250000,
    monthlyEscrowCents: 0,
    interestOnly: false,
  }),
  { interestCents: 45833, principalCents: 204167, escrowCents: 0 },
  "no-escrow term loan splits P+I only"
);

// ── interest-only strategy (HELOC draw period / 0% forbearance) ──────────────
eq(
  estimateLiabilitySplit({
    amountCents: 120000,
    balanceCents: 0, // balance unused for interest-only
    annualRateBps: 0,
    expectedPaymentCents: 120000,
    monthlyEscrowCents: 0,
    interestOnly: true,
  }),
  { interestCents: 120000, principalCents: 0, escrowCents: 0 },
  "interest-only books the whole payment to interest"
);

// ── rejection cases → null → the txn stays in Review ────────────────────────
ok(
  estimateLiabilitySplit({
    amountCents: 50000, // far below scheduled P&I of $2,700
    balanceCents: 60000000,
    annualRateBps: 500,
    expectedPaymentCents: 350000,
    monthlyEscrowCents: 80000,
    interestOnly: false,
  }) === null,
  "payment below scheduled P&I rejects (partial payment — human call)"
);
ok(
  estimateLiabilitySplit({
    amountCents: 350000,
    balanceCents: 0, // zero balance → interest 0 → misconfigured
    annualRateBps: 500,
    expectedPaymentCents: 350000,
    monthlyEscrowCents: 80000,
    interestOnly: false,
  }) === null,
  "zero GL balance rejects (interest would be 0)"
);
ok(
  estimateLiabilitySplit({
    amountCents: 350000,
    balanceCents: 200000000, // $2M at 5% → interest > P&I → negative amortization
    annualRateBps: 500,
    expectedPaymentCents: 350000,
    monthlyEscrowCents: 80000,
    interestOnly: false,
  }) === null,
  "interest exceeding P&I rejects (negative amortization — human call)"
);

// ── recognition band ─────────────────────────────────────────────────────────
eq(paymentBandCents(350000), Math.round(350000 * 0.15), "band is 15% for a mortgage-sized payment");
eq(paymentBandCents(40000), 100_00, "band floors at $100 for small payments");
ok(
  Math.abs(360000 - 350000) <= paymentBandCents(350000),
  "a $100 escrow bump sits comfortably inside the recognition band"
);

if (fails.length) {
  console.error(`FAIL (${fails.length}):`);
  for (const f of fails) console.error("  ✗ " + f);
  process.exit(1);
}
console.log(`liability-engine: ${pass} assertions passed`);
