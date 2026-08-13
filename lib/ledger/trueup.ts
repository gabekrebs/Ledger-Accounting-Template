/**
 * Pure pro-rata parity math for the capital true-up distribution planner.
 *
 * Owners hold capital balances a_i and ownership fractions p_i. A distribution
 * w_i (positive = cash out, negative = contribute) leaves b_i = a_i − w_i and a
 * new total T′ = T − Σw_i. Parity means b_i = p_i · T′, so the entire solution
 * family is one scalar — the post-distribution total:
 *
 *     w_i = a_i − p_i · T′
 *
 * Two ways to pick T′: the minimum true-up (largest T′ with every take ≥ 0 —
 * the binding partner takes $0), or pinning one partner at a chosen take
 * ("Evan and I each take $1,600 — what does Nathan take?").
 *
 * Everything here is integer cents, no DB, no dates. The withdrawal ≠ gap
 * subtlety lives entirely in this file: taking money out shrinks the
 * denominator, so the correct take is diff / (1 − p), not diff.
 */

export interface ParityOwner {
  name: string;
  /** Ownership percentage, 0–100 (e.g. 34, 33.34). Must be > 0. */
  pct: number;
  /** Current capital balance, credit-normal (negative = drawn below zero). */
  actualCents: number;
}

export interface ParityRow extends ParityOwner {
  /** Distribution: positive = withdraw, negative = contribute. */
  takeCents: number;
  /** Balance after the distribution: exactly pct of the new total. */
  afterCents: number;
}

/** Roster is usable for parity math: non-empty, every pct > 0, sums to 100. */
export function ownersPctValid(
  owners: { name: string; pct: number }[] | null | undefined
): boolean {
  if (!owners?.length) return false;
  if (owners.some((o) => !(o.pct > 0))) return false;
  const sum = owners.reduce((s, o) => s + o.pct, 0);
  return Math.abs(sum - 100) < 0.01;
}

/**
 * Split a post-distribution total T′ into per-owner rows. b_i = round(p_i·T′);
 * the ±1–2¢ rounding residual goes to the largest-pct owner so Σb_i = T′
 * exactly (and therefore Σ takes = T − T′ with no drift). `residualSkipName`
 * keeps the residual off a pinned owner — their take must equal what was typed.
 */
export function solveParity(
  owners: ParityOwner[],
  postTotalCents: number,
  residualSkipName?: string
): ParityRow[] {
  if (!owners.length) return [];
  const rows: ParityRow[] = owners.map((o) => ({
    ...o,
    afterCents: Math.round((postTotalCents * o.pct) / 100),
    takeCents: 0,
  }));
  const residual = postTotalCents - rows.reduce((s, r) => s + r.afterCents, 0);
  if (residual !== 0) {
    const eligible = rows.filter((r) => r.name !== residualSkipName);
    const target = (eligible.length ? eligible : rows).reduce((a, b) =>
      b.pct > a.pct ? b : a
    );
    target.afterCents += residual;
  }
  for (const r of rows) r.takeCents = r.actualCents - r.afterCents;
  return rows;
}

/**
 * Largest post-distribution total where every take ≥ 0 — the minimum true-up.
 * The exact solution is min_i(a_i / p_i), usually not a whole cent; start at
 * its ceiling and step down until the rounded split leaves no negative take
 * (rounding perturbs each row by <1¢, so this converges in a step or two).
 */
export function minParityTotalCents(owners: ParityOwner[]): number {
  if (!owners.length) throw new Error("minParityTotalCents: empty roster");
  if (owners.some((o) => !(o.pct > 0)))
    throw new Error("minParityTotalCents: every pct must be > 0");
  let cand = Math.ceil(Math.min(...owners.map((o) => (o.actualCents * 100) / o.pct)));
  for (let i = 0; i < 8; i++) {
    if (solveParity(owners, cand).every((r) => r.takeCents >= 0)) return cand;
    cand -= 1;
  }
  return cand;
}

/** Post-distribution total implied by pinning one owner at a given take. */
export function pinnedParityTotalCents(
  owner: ParityOwner,
  takeCents: number
): number {
  if (!(owner.pct > 0))
    throw new Error("pinnedParityTotalCents: pct must be > 0");
  return Math.round(((owner.actualCents - takeCents) * 100) / owner.pct);
}
