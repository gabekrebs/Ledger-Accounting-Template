/**
 * Pure types/constants for the Reconciliation view, shared by the server-side
 * assembly (lib/ledger/recon-status.ts) and the client row component. Split out
 * (valuation-shared.ts precedent) so the client bundle never imports the
 * db-touching module.
 */

/** |variance| under a dollar reads "In sync" — absorbs cent-level rounding. */
export const IN_SYNC_TOLERANCE_CENTS = 100;

/**
 * How long an unexplained residual may persist before it stops reading as
 * "settling" and turns into a real "Off by". Sized to the worst honest lag:
 * a weekend charge can take 3 business days to settle at the bank, plus a day
 * for Plaid's extraction and the daily posting sweep. Anything that survives
 * longer is a genuine discrepancy, not timing.
 */
export const SETTLING_GRACE_DAYS = 5;

export interface ReconStatusRow {
  qboAccountId: string;
  name: string;
  accountType: string;
  source: "plaid" | "manual";
  /** Natural-sign book balance — current for Plaid rows, as-of for manual. */
  bookCents: number;
  /** Natural-sign external balance; null = unavailable / never entered. */
  actualCents: number | null;
  /** actual − book; null when there's no actual to compare. */
  varianceCents: number | null;
  /**
   * The UNEXPLAINED part of the variance, after netting out in-flight items the
   * book can't have yet: staged settled rows awaiting the sweep/review, plus
   * the bank's own pending txns (fetched live — never staged, but credit cards
   * especially report them inside the current balance). Plaid rows only; manual
   * rows mirror varianceCents. This is what the status pill judges: a variance
   * fully explained by in-flight items IS reconciled — the book isn't wrong,
   * it's 1–2 days behind the bank by design.
   */
  residualCents: number | null;
  /** Staged unposted txns used to explain the variance (Plaid rows; else 0). */
  inflightCount: number;
  /**
   * True when the residual is out of tolerance but YOUNG — first observed less
   * than SETTLING_GRACE_DAYS ago (per bk_account_recon_state). The pill keeps
   * these green: pending-charge timing the pipeline self-corrects. Only a
   * residual that outlives the grace window renders as genuinely off.
   */
  settling: boolean;
  /** Days the current out-of-tolerance streak has run (Plaid rows; else null). */
  offSinceDays: number | null;
  /** Manual rows: the checkpoint's as-of date. Plaid rows: null (live). */
  asOfDate: string | null;
  /** Last completed statement-tie date (bk_reconciliations), if any. */
  lastStatementDate: string | null;
  /** Bank/CC accounts have the full statement-tie page to deep-link into. */
  hasFullReconcile: boolean;
}
