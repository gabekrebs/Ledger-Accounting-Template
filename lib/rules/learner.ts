/**
 * History → rule learner — an AUTHOR, not an executor.
 *
 * Reads the same precedent the statistical fingerprint auto-posts — this
 * entity's own unanimous history AND cross-ledger (portfolio) precedent — and,
 * for each such merchant that no rule already covers, authors a PROPOSED rule
 * (`origin:'learned'`, `status:'proposed'`, `enabled:false`) via
 * `proposeLearnedRule`. It never posts and never enables a rule — a human
 * approves it in the proposed-rules queue, after which the deterministic engine
 * takes over.
 *
 * This is the replacement for the fingerprint's auto-post: "zero-touch silent
 * posting" becomes "one-click approve, then deterministic". Idempotent — a
 * merchant already covered by an active OR proposed rule is skipped, so re-runs
 * don't pile up duplicates.
 */
import { and, eq, inArray, or } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import {
  buildMerchantHistory,
  buildPortfolioMerchantHistory,
  historyVerdict,
  portfolioVerdict,
  activeAccountIds,
  AUTOPOST_MIN_SAMPLES,
  type PortfolioHistory,
  type TargetAccount,
} from "@/lib/plaid/auto-categorize";
import { listPendingTransactions } from "@/lib/plaid/data";
import { extractFacts } from "@/lib/rules/facts";
import { loadRules, selectRule, type RuleRow } from "@/lib/rules/engine";
import { matches } from "@/lib/rules/predicates";
import { proposeLearnedRule } from "@/lib/rules/store";
import type { ConditionGroup, TxnFacts } from "@/lib/rules/types";

const { bkRules, bkAccounts } = schema;

export type CandidateSource = "local" | "portfolio";
export interface Candidate {
  merchant: string;
  accountId: string;
  samples: number;
  source: CandidateSource;
}

/** A neutral facts bag carrying only the merchant — for "is this already covered?". */
export function synthFacts(merchant: string): TxnFacts {
  return {
    merchant,
    rawName: merchant,
    amountCents: 0,
    direction: "outflow",
    plaidCategoryPrimary: null,
    plaidCategoryDetailed: null,
    bankAccountSubtype: null,
    isoCurrencyCode: null,
    dayOfMonth: 1,
    weekday: 0,
  };
}

/**
 * Every merchant the fingerprint would auto-post, resolved to an ACTIVE account
 * in this entity — the shared source of truth for both the learner (what to
 * propose) and the parity report (what must be covered before the fingerprint
 * is retired). Mirrors `auto-post.ts`'s `verdictFor`: local precedent wins; the
 * portfolio only steps in when there's no auto-postable local verdict that
 * points elsewhere.
 */
export async function fingerprintCandidates(
  entityId: string,
  portfolioHistory?: PortfolioHistory
): Promise<Candidate[]> {
  const history = await buildMerchantHistory(entityId);

  // (a) LOCAL: unanimous (single tallied account) with enough samples.
  const raw: Candidate[] = [];
  for (const [key, tallies] of history) {
    if (key.length < 3 || tallies.length !== 1) continue;
    if (tallies[0].count < AUTOPOST_MIN_SAMPLES) continue;
    raw.push({ merchant: key, accountId: tallies[0].accountId, samples: tallies[0].count, source: "local" });
  }

  // (b) PORTFOLIO: pending merchants with no auto-postable LOCAL verdict but an
  // auto-postable CROSS-LEDGER verdict resolving to one of this entity's
  // accounts (utilities/county/trades a thin/new entity hasn't booked yet).
  const pending = await listPendingTransactions(entityId);
  if (pending.length) {
    const targets: TargetAccount[] = await db
      .select({
        id: bkAccounts.id,
        name: bkAccounts.name,
        classification: bkAccounts.classification,
        active: bkAccounts.active,
      })
      .from(bkAccounts)
      .where(eq(bkAccounts.entityId, entityId));
    let portfolio: PortfolioHistory | null = portfolioHistory ?? null;
    const seen = new Set<string>();
    for (const t of pending) {
      const localV = historyVerdict(history, t.merchantName, t.name);
      if (localV?.autoPostable) continue; // local owns this merchant
      portfolio ??= await buildPortfolioMerchantHistory();
      const pv = portfolioVerdict(portfolio, targets, t.merchantName, t.name);
      if (!pv?.autoPostable) continue;
      if (localV && localV.accountId !== pv.accountId) continue; // local points elsewhere → veto
      const key = extractFacts(t, {}).merchant; // exact key future facts will carry
      if (key.length < 3 || seen.has(key)) continue;
      seen.add(key);
      raw.push({ merchant: key, accountId: pv.accountId, samples: pv.samples, source: "portfolio" });
    }
  }

  if (!raw.length) return [];
  // Only target still-active accounts (the fingerprint never posts to a deleted one).
  const active = await activeAccountIds(entityId, raw.map((c) => c.accountId));
  return raw.filter((c) => active.has(c.accountId));
}

/** Active rules + every proposed rule visible to the entity — the coverage sets. */
export async function coverageSets(entityId: string): Promise<{ active: RuleRow[]; proposed: RuleRow[] }> {
  const [active, proposed] = await Promise.all([
    loadRules(entityId),
    db
      .select()
      .from(bkRules)
      .where(
        and(
          eq(bkRules.status, "proposed"),
          or(eq(bkRules.scope, "global"), eq(bkRules.entityId, entityId))
        )
      ),
  ]);
  return { active, proposed };
}

/** Is this merchant already covered by an active or proposed rule? */
export function coverageFor(
  merchant: string,
  sets: { active: RuleRow[]; proposed: RuleRow[] }
): "active" | "proposed" | "uncovered" {
  const facts = synthFacts(merchant);
  if (selectRule(sets.active, facts)) return "active";
  if (sets.proposed.some((r) => matches(r.predicate as ConditionGroup, facts))) return "proposed";
  return "uncovered";
}

export interface LearnerResult {
  proposed: number;
  skipped: number;
  /** Fingerprint candidates total, and how many are already on an ACTIVE rule. */
  total: number;
  activeCovered: number;
  details: { merchant: string; accountId: string; samples: number; source: CandidateSource }[];
}

/**
 * Author proposed rules for every fingerprint candidate not already covered.
 * Writes only proposed rules — no posts, no enables. `portfolioHistory` may be
 * passed in (the cron builds the cross-ledger fingerprint once and shares it).
 */
export async function proposeRulesFromHistory(
  entityId: string,
  portfolioHistory?: PortfolioHistory
): Promise<LearnerResult> {
  const candidates = await fingerprintCandidates(entityId, portfolioHistory);
  if (!candidates.length) return { proposed: 0, skipped: 0, total: 0, activeCovered: 0, details: [] };

  const acctNames = new Map(
    (
      await db
        .select({ id: bkAccounts.id, name: bkAccounts.name, fqn: bkAccounts.fullyQualifiedName })
        .from(bkAccounts)
        .where(inArray(bkAccounts.id, candidates.map((c) => c.accountId)))
    ).map((a) => [a.id, a.fqn ?? a.name ?? ""])
  );
  const sets = await coverageSets(entityId);

  let proposed = 0;
  let skipped = 0;
  let activeCovered = 0;
  const details: LearnerResult["details"] = [];

  for (const c of candidates) {
    const cov = coverageFor(c.merchant, sets);
    if (cov !== "uncovered") {
      if (cov === "active") activeCovered++;
      skipped++;
      continue;
    }
    const acctLabel = acctNames.get(c.accountId) || "category";
    await proposeLearnedRule({
      scope: "entity",
      entityId,
      name: `${c.source === "portfolio" ? "Cross-ledger" : "History"}: ${c.merchant} → ${acctLabel}`,
      description:
        c.source === "portfolio"
          ? `Proposed from ${c.samples} cross-ledger postings (no local history yet).`
          : `Proposed from ${c.samples} unanimous prior postings.`,
      predicate: { all: [{ field: "merchant", op: "eq", value: c.merchant }] },
      action: { kind: "categorize", target: { by: "account", accountId: c.accountId } },
    });
    proposed++;
    details.push({ merchant: c.merchant, accountId: c.accountId, samples: c.samples, source: c.source });
    // Keep idempotency within this run: a freshly-proposed rule now covers it.
    sets.proposed.push({
      predicate: { all: [{ field: "merchant", op: "eq", value: c.merchant }] },
    } as RuleRow);
  }

  return { proposed, skipped, total: candidates.length, activeCovered, details };
}

/** Portfolio-wide learner sweep — propose for every entity with pending history. */
export async function proposeRulesPortfolio(
  entityIds: string[]
): Promise<{ entityId: string; result: LearnerResult }[]> {
  if (!entityIds.length) return [];
  // Build the cross-ledger fingerprint ONCE and share it across the sweep.
  const portfolio = await buildPortfolioMerchantHistory();
  const out: { entityId: string; result: LearnerResult }[] = [];
  for (const entityId of entityIds) {
    try {
      out.push({ entityId, result: await proposeRulesFromHistory(entityId, portfolio) });
    } catch (e) {
      console.error(`learner: entity ${entityId} failed:`, e);
      out.push({ entityId, result: { proposed: 0, skipped: 0, total: 0, activeCovered: 0, details: [] } });
    }
  }
  return out;
}
