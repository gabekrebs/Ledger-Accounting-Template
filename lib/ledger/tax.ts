/**
 * Depreciation tax benefit — the deferral framing.
 *
 * Depreciation is a non-cash deduction. To date it shelters two distinct kinds
 * of income, which get different tax treatment, so we decompose it:
 *
 *   1. The property's OWN profit (shelter-of-own-income). Depreciation first
 *      offsets the rental income the property actually earned, so that cash
 *      reaches the owner tax-deferred. This benefit ALWAYS applies — it isn't a
 *      loss being deducted against other income, it's income that simply isn't
 *      there. Passive-activity rules don't touch it.
 *
 *   2. The EXCESS loss. Any depreciation beyond what the property's own profit
 *      could absorb spills into a net rental (passive) loss. That loss shelters
 *      the owner's OTHER income only if they're passive-eligible (real-estate
 *      professional, the $25k active-participation allowance, or other passive
 *      income). Otherwise it's suspended and carried forward — not lost, but no
 *      current benefit. The `lossesUsable` flag gates this slice.
 *
 * Tax deferred = (shelter-of-own-income + usable excess loss) × marginal rate.
 * When losses are usable that collapses to simply `depreciation × rate`.
 *
 * This is a DEFERRAL, not a permanent windfall: the same depreciation reduces
 * tax basis and is recaptured on a taxable sale. For a buy-and-hold owner that's
 * a contingent future event (and a 1031 exchange or a step-up at death can erase
 * it entirely), so recapture is surfaced as a footnote, not modeled here.
 *
 * Pure + dependency-free so both the server page and the client returns
 * components compute one identical number.
 */
export function depreciationTaxBenefit(input: {
  /** Cumulative depreciation (+ amortization) to date, as a positive magnitude. */
  depreciationCents: number;
  /** Cumulative net income to date (negative = a cumulative loss). */
  netIncomeCents: number;
  /** Owner's marginal tax rate, as a percentage (e.g. 37). */
  taxRatePct: number;
  /** Whether the excess passive loss is currently deductible against other income. */
  lossesUsable: boolean;
}): {
  /** Depreciation that offset the property's own profit — always tax-deferred. */
  shelteredOwnIncomeCents: number;
  /** Depreciation that spilled into a deductible passive loss. */
  excessLossCents: number;
  /** Tax deferred to date = usable shelter × marginal rate. */
  benefitCents: number;
} {
  const depreciationCents = Math.max(0, input.depreciationCents);
  // Net income BEFORE depreciation = how much profit there was to shelter.
  const preDepNetIncomeCents = input.netIncomeCents + depreciationCents;
  const shelteredOwnIncomeCents = Math.max(
    0,
    Math.min(depreciationCents, preDepNetIncomeCents)
  );
  const excessLossCents = depreciationCents - shelteredOwnIncomeCents;
  const usableCents =
    shelteredOwnIncomeCents + (input.lossesUsable ? excessLossCents : 0);
  return {
    shelteredOwnIncomeCents,
    excessLossCents,
    benefitCents: Math.round(usableCents * (input.taxRatePct / 100)),
  };
}
