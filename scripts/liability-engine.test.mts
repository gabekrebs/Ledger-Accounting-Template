/**
 * Unit tests for the liability engine's pure split estimator
 * (lib/plaid/loan-match.ts). No database.
 *
 *   SUPABASE_DB_URL=postgres://u:p@127.0.0.1:5432/none npx tsx scripts/liability-engine.test.mts
 *
 * Fixtures are the REAL NW Johnson Shellpoint statements (acct 0678006271,
 * 6.5% fixed, maturity 07/2063) — the engine must reproduce the servicer's own
 * arithmetic to the penny when the GL balance matches their principal.
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

// ── Shellpoint ground truth ──────────────────────────────────────────────────
// Jan 2026 payment $6,413.61 on balance $878,439.14:
//   statement says P $456.17 / I $4,758.21 / E $1,199.23.
eq(
  estimateLiabilitySplit({
    amountCents: 641361,
    balanceCents: 87843914,
    annualRateBps: 650,
    expectedPaymentCents: 641361,
    monthlyEscrowCents: 119923,
    interestOnly: false,
  }),
  { interestCents: 475821, principalCents: 45617, escrowCents: 119923 },
  "Jan 2026 statement split reproduced exactly"
);

// Feb 2026 after escrow re-analysis: payment $6,497.57 on balance $877,982.97:
//   statement says P $458.64 / I $4,755.74 / E $1,283.19. Note the EXPECTED
//   payment is still the old $6,413.61 — the residual escrow absorbs the
//   re-analysis in the same month it happens, before adoption. P&I is
//   invariant either way.
eq(
  estimateLiabilitySplit({
    amountCents: 649757,
    balanceCents: 87798297,
    annualRateBps: 650,
    expectedPaymentCents: 641361, // pre-adoption
    monthlyEscrowCents: 119923,
    interestOnly: false,
  }),
  { interestCents: 475574, principalCents: 45864, escrowCents: 128319 },
  "escrow re-analysis month: residual escrow absorbs the change, P&I exact"
);
// …and identically AFTER adoption (expected updated to the new draft):
eq(
  estimateLiabilitySplit({
    amountCents: 649757,
    balanceCents: 87798297,
    annualRateBps: 650,
    expectedPaymentCents: 649757,
    monthlyEscrowCents: 128319,
    interestOnly: false,
  }),
  { interestCents: 475574, principalCents: 45864, escrowCents: 128319 },
  "post-adoption terms give the identical split"
);

// June 2026 (engine-derived, verified against GL): balance $876,133.46 →
//   P $468.66 / I $4,745.72 / E $1,283.19.
eq(
  estimateLiabilitySplit({
    amountCents: 649757,
    balanceCents: 87613346,
    annualRateBps: 650,
    expectedPaymentCents: 649757,
    monthlyEscrowCents: 128319,
    interestOnly: false,
  }),
  { interestCents: 474572, principalCents: 46866, escrowCents: 128319 },
  "June 2026 forward-rolled split"
);

// ── no-escrow term loan (SBA-style) ──────────────────────────────────────────
eq(
  estimateLiabilitySplit({
    amountCents: 250000,
    balanceCents: 20000000, // $200k @ 2.75%
    annualRateBps: 275,
    expectedPaymentCents: 250000,
    monthlyEscrowCents: 0,
    interestOnly: false,
  }),
  { interestCents: 45833, principalCents: 204167, escrowCents: 0 },
  "no-escrow term loan splits P+I only"
);

// ── interest-only strategy (HELOC / 0% forbearance uses principal leg 0) ─────
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
    amountCents: 500000, // below scheduled P&I of 5214.38
    balanceCents: 87613346,
    annualRateBps: 650,
    expectedPaymentCents: 649757,
    monthlyEscrowCents: 128319,
    interestOnly: false,
  }) === null,
  "payment below scheduled P&I rejects (partial payment — human call)"
);
ok(
  estimateLiabilitySplit({
    amountCents: 649757,
    balanceCents: 0, // zero balance → interest 0 → misconfigured
    annualRateBps: 650,
    expectedPaymentCents: 649757,
    monthlyEscrowCents: 128319,
    interestOnly: false,
  }) === null,
  "zero GL balance rejects (interest would be 0)"
);
ok(
  estimateLiabilitySplit({
    amountCents: 649757,
    balanceCents: 200000000, // $2M at 6.5% → interest > P&I → negative amortization
    annualRateBps: 650,
    expectedPaymentCents: 649757,
    monthlyEscrowCents: 128319,
    interestOnly: false,
  }) === null,
  "interest exceeding P&I rejects (negative amortization — human call)"
);

// ── recognition band ─────────────────────────────────────────────────────────
eq(paymentBandCents(649757), Math.round(649757 * 0.15), "band is 15% for a mortgage-sized payment");
eq(paymentBandCents(40000), 100_00, "band floors at $100 for small payments");
ok(
  Math.abs(649757 - 641361) <= paymentBandCents(641361),
  "the real Jan→Feb escrow bump ($83.96) sits comfortably inside the band"
);

if (fails.length) {
  console.error(`FAIL (${fails.length}):`);
  for (const f of fails) console.error("  ✗ " + f);
  process.exit(1);
}
console.log(`liability-engine: ${pass} assertions passed`);
