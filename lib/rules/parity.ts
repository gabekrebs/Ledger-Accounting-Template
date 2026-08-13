/**
 * Fingerprint parity report — READ-ONLY. The go/no-go signal for retiring the
 * statistical fingerprint's auto-posting: for every merchant the fingerprint
 * would auto-post (local ∪ cross-ledger, via the shared `fingerprintCandidates`),
 * is it now covered by an ACTIVE rule, a PROPOSED rule (awaiting approval), or
 * still UNCOVERED?
 *
 *   • uncovered = 0  → the fingerprint's value is at least captured as proposals;
 *                       nothing is lost that the learner couldn't even propose.
 *   • active == total → every fingerprint merchant is already on a deterministic
 *                       rule; the fingerprint can be retired with no review backlog.
 *
 * Writes nothing — safe to run against live books.
 */
import {
  fingerprintCandidates,
  coverageSets,
  coverageFor,
  type CandidateSource,
} from "@/lib/rules/learner";
import type { PortfolioHistory } from "@/lib/plaid/auto-categorize";

export interface ParityEntry {
  merchant: string;
  accountId: string;
  samples: number;
  source: CandidateSource;
  coverage: "active" | "proposed" | "dismissed" | "uncovered";
}

export interface ParityReport {
  entityId: string;
  total: number;
  active: number;
  proposed: number;
  /** Owner said "stop suggesting this merchant" — deliberately not covered. */
  dismissed: number;
  uncovered: number;
  entries: ParityEntry[];
}

export async function fingerprintParity(
  entityId: string,
  portfolio?: PortfolioHistory
): Promise<ParityReport> {
  const [candidates, sets] = await Promise.all([
    fingerprintCandidates(entityId, portfolio),
    coverageSets(entityId),
  ]);
  const entries: ParityEntry[] = candidates.map((c) => ({
    merchant: c.merchant,
    accountId: c.accountId,
    samples: c.samples,
    source: c.source,
    coverage: coverageFor(c.merchant, sets),
  }));
  return {
    entityId,
    total: entries.length,
    active: entries.filter((e) => e.coverage === "active").length,
    proposed: entries.filter((e) => e.coverage === "proposed").length,
    dismissed: entries.filter((e) => e.coverage === "dismissed").length,
    uncovered: entries.filter((e) => e.coverage === "uncovered").length,
    entries,
  };
}
