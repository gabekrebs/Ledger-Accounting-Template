/**
 * Confidence model — PURE (no db), so it's safe to import from anywhere,
 * including display badges.
 *
 * A rule starts structurally certain (~1.0) and decays as it accrues
 * corrections: `(applied − corrected + 1) / (applied + 1)`. A brand-new rule
 * (0/0) reads 1.0; each correction relative to applications pulls it down. An
 * `auto_apply` rule only keeps posting unattended while it stays above the AUTO
 * bar.
 *
 * The threshold constants mirror the statistical layer's gates verbatim
 * (`AUTOPOST_MIN_SAMPLES` in auto-categorize.ts; `HISTORY_SUGGEST_*` in
 * suggest-categories.ts). They're re-declared here rather than imported so this
 * module stays db-free — keep the numbers in sync if those ever change.
 */

/** Fingerprint/learned AUTO gate: unanimous + this many samples. */
export const AUTO_MIN_SAMPLES = 6;
/** Suggestion (surface-as-reason) gate. */
export const SUGGEST_MIN_AGREEMENT = 0.8;
export const SUGGEST_MIN_SAMPLES = 2;

/**
 * A rule's auto_apply is only honored while its confidence holds at or above
 * this bar — corrections erode trust until a human re-confirms. A fresh rule
 * (1.0) clears it; it takes a meaningful correction rate to fall below.
 */
export const RULE_AUTO_MIN_CONFIDENCE = 0.8;

/** Laplace-smoothed precision of a rule from its application history (clamped 0–1). */
export function ruleConfidence(appliedCount: number, correctedCount: number): number {
  const applied = Math.max(0, appliedCount);
  const corrected = Math.max(0, correctedCount);
  // Clamp: a rule corrected more often than applied (e.g. corrected before ever
  // confirmed) would otherwise read as a negative, partner-facing percentage.
  return Math.max(0, Math.min(1, (applied - corrected + 1) / (applied + 1)));
}

/** Whether a rule's auto_apply should currently be honored (flag ∧ confidence). */
export function meetsAutoBar(rule: {
  autoApply: boolean;
  appliedCount: number;
  correctedCount: number;
}): boolean {
  return (
    rule.autoApply &&
    ruleConfidence(rule.appliedCount, rule.correctedCount) >= RULE_AUTO_MIN_CONFIDENCE
  );
}

/**
 * Clean human confirmations a Review-only rule must accrue before it may
 * graduate to auto_apply. "When in doubt, review": a rule earns unattended
 * posting only after the owner has accepted its suggestion this many times with
 * ZERO corrections — never by bulk grant. Tunable; deliberately small so a clear
 * recurring merchant graduates within a few cycles, but never on first sight.
 */
export const GRADUATE_MIN_CONFIRMATIONS = 3;

/**
 * Has a Review-only rule earned auto_apply? Requires enough GENUINE review-flow
 * confirmations (confirmedCount — incremented only when the owner posts a real
 * transaction keeping the rule's suggestion; NOT by bulk "apply to similar/
 * retroactive") and a SPOTLESS record (any correction bumps correctedCount and
 * demotes, so correctedCount===0 means the rule has never been wrong). The
 * offline gates held at authoring; Gate 6 (per-transaction outlier/ambiguity)
 * is still enforced at post time. This only answers "may it flip suggest→auto?".
 */
export function meetsGraduationBar(rule: {
  confirmedCount: number;
  correctedCount: number;
}): boolean {
  return rule.correctedCount === 0 && rule.confirmedCount >= GRADUATE_MIN_CONFIRMATIONS;
}
