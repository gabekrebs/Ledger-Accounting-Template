import { eq, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { listPendingTransactions, listItems } from "@/lib/plaid/data";
import {
  postPlaidTransaction,
  postPlaidTransactionSplit,
  linkTransferCounterpart,
} from "@/lib/plaid/post";
import {
  loadLoanRefs,
  planLoanPayment,
  recordLoanRecognition,
} from "@/lib/plaid/loan-match";
import { reconcileBookedExactMatches } from "@/lib/plaid/reconcile";
import {
  planInternalTransfer,
  loadCardContext,
  planCreditCardPayment,
} from "@/lib/plaid/transfer-match";
import { loadRules, selectRule } from "@/lib/rules/engine";
import { extractFacts } from "@/lib/rules/facts";
import { applyRuleToTxn } from "@/lib/rules/apply";
import { newCanonCache } from "@/lib/rules/actions";
import { meetsAutoBar, ruleConfidence } from "@/lib/rules/confidence";
import { recordEvent } from "@/lib/rules/store";
import { buildMerchantBands, gate6, type MerchantBands } from "@/lib/rules/outlier";
import { reviewReasonText, type ReviewReason } from "@/lib/rules/review-reasons";
import type { ActionSpec } from "@/lib/rules/types";

/**
 * Unattended applier — post only the transactions a deterministic writer is
 * certain about, then leave everything else for suggestion + review. Two
 * writers post here without a human: the structural recognizers (owner-payout,
 * internal transfer, loan split, credit-card payment) and `auto_apply` rules
 * (lib/rules). The statistical merchant fingerprint no longer auto-posts — the
 * history learner (lib/rules/learner.ts) proposes rules from the booked ledger
 * instead, so every unattended post traces to a recognizer or an approved rule.
 *
 * Layered on top of `postPlaidTransaction`'s own guards (entity assignment,
 * mapping, exact-dup backstop), this additionally:
 *   - requires the bank account to be mapped (else there's no posting to make),
 *   - skips NEAR matches to imported QBO/Wave lines (post.ts only blocks EXACT
 *     ones) — a possible duplicate is a human call, never an auto-post,
 *   - stamps source `plaid_auto` so the row is flagged + one-click reversible.
 *
 * Idempotent: posting flips status off `pending_review`, so a re-run can't double
 * up. Per-txn failures are isolated — one bad row never aborts the batch.
 */
export interface AutoPostResult {
  entityId: string;
  posted: number;
  skippedDup: number;
  errors: number;
}

export async function autoPostEntity(
  entityId: string
): Promise<AutoPostResult> {
  const result: AutoPostResult = {
    entityId,
    posted: 0,
    skippedDup: 0,
    errors: 0,
  };

  // Suppress already-booked lines FIRST — this is the only unattended write
  // path, and a replaced connection's re-link can re-deliver already-posted
  // history under new ids (e.g. mortgage drafts the loan-matcher would happily
  // split a second time). Idempotent and cheap when there's nothing to do.
  await reconcileBookedExactMatches(entityId);

  // OLDEST FIRST: the liability engine computes interest off the GL balance as
  // of each txn's date, so an earlier payment's principal must be booked before
  // a later payment's interest is estimated (two months of the same mortgage
  // can be pending together after a backfill or a missed sweep).
  const pending = (await listPendingTransactions(entityId)).sort((a, b) =>
    String(a.txnDate).localeCompare(String(b.txnDate))
  );
  if (!pending.length) return result;

  // The imported-books cutoff. Anything dated ON OR BEFORE it lives in the
  // overlap zone where the exact/near dup-matchers can be defeated by how the
  // old books were shaped (e.g. two drafts bundled into one 2× entry — seen in
  // production). Pre-cutoff txns therefore NEVER auto-post; they wait in
  // Review with an explicit reason. Post-cutoff txns are net-new by definition.
  const [entityRow] = await db
    .select({ importedThrough: schema.bkLedgerEntities.importedThrough })
    .from(schema.bkLedgerEntities)
    .where(eq(schema.bkLedgerEntities.id, entityId));
  const importedThrough = entityRow?.importedThrough ?? null;

  const loanRefs = await loadLoanRefs(entityId);
  const cardCtx = await loadCardContext(entityId);
  // Counterparts consumed by an internal-transfer match this pass — skip them so
  // the inflow half isn't re-categorized after its outflow half booked the move.
  const resolvedTransferIds = new Set<string>();

  // plaid account → mapped ledger (bank) account.
  const items = await listItems(entityId);
  const mapByPlaidAcct = new Map<string, string | null>();
  const subtypeByPlaidAcct = new Map<string, string | null>();
  for (const it of items)
    for (const a of it.accounts) {
      mapByPlaidAcct.set(a.plaidAccountId, a.mappedAccountId);
      subtypeByPlaidAcct.set(a.plaidAccountId, a.subtype ?? null);
    }

  // The deterministic rules layer (user-authored), the facts context the
  // predicates read, and a per-entity canonical-resolution cache shared across
  // the batch.
  const rules = await loadRules(entityId);
  const factsCtx = { subtypeByPlaidAcct };
  const canonCache = newCanonCache();
  // Gate 6 (per-txn outlier) only matters once a rule can actually auto-post.
  // While every rule is Review-only (the launch state), skip the history scan
  // entirely — the band is consulted only inside the auto_apply path below.
  let bands: MerchantBands = new Map();
  if (rules.some((r) => r.autoApply)) {
    const since36 = new Date();
    since36.setMonth(since36.getMonth() - 36);
    bands = await buildMerchantBands(entityId, since36.toISOString().slice(0, 10));
  }

  /**
   * Record (idempotently) why a transaction is waiting in review: a matching
   * non-auto rule. Stamps `review_reason`/`matched_rule_id` and appends a
   * `proposed` decision event — only when the proposal actually changed, so
   * re-running the sweep doesn't bloat the log. Clears a stale proposal when
   * nothing matches anymore.
   */
  const markProposed = async (
    t: (typeof pending)[number],
    ruleMatch: (typeof rules)[number] | null,
    // Set when a rule WOULD have auto-posted but a runtime gate (6/7) deferred
    // it — so the inbox shows the specific cause (unusual amount, multiple rules)
    // instead of the generic "not set to auto-apply".
    overrideReason?: ReviewReason
  ) => {
    let reviewReason: string | null = null;
    let matchedRuleId: string | null = null;
    let evt: Parameters<typeof recordEvent>[0] | null = null;
    // A gate reason (pre-cutoff, unusual amount) applies even with no matching
    // rule — the inbox must still say why the row is waiting.
    if (!ruleMatch && overrideReason) {
      reviewReason = reviewReasonText(overrideReason);
    }
    if (ruleMatch) {
      matchedRuleId = ruleMatch.id;
      reviewReason = overrideReason
        ? reviewReasonText(overrideReason)
        : `Matches rule "${ruleMatch.name}" — not set to auto-apply`;
      evt = {
        entityId,
        plaidTxnId: t.id,
        ruleId: ruleMatch.id,
        decisionSource: "rule",
        outcome: "proposed",
        actionKind: (ruleMatch.action as ActionSpec).kind,
        confidence: ruleConfidence(ruleMatch.appliedCount, ruleMatch.correctedCount),
        reason: reviewReason,
      };
    }
    if (
      reviewReason === (t.reviewReason ?? null) &&
      matchedRuleId === (t.matchedRuleId ?? null)
    ) {
      return; // unchanged — nothing to write
    }
    await db
      .update(schema.bkPlaidTransactions)
      .set({ reviewReason, matchedRuleId, updatedAt: new Date() })
      .where(eq(schema.bkPlaidTransactions.id, t.id));
    if (evt) await recordEvent(evt);
  };

  for (const t of pending) {
    if (resolvedTransferIds.has(t.id)) continue; // inflow half of a booked transfer
    const mappedAcct = mapByPlaidAcct.get(t.plaidAccountId) ?? null;
    if (!mappedAcct) continue; // unmapped → can't post yet

    // Pre-cutoff: inside the imported-books window nothing posts unattended —
    // not recognizers, not rules. Stamp the honest reason and move on.
    if (importedThrough && String(t.txnDate).slice(0, 10) <= importedThrough) {
      const preFacts = extractFacts(t, factsCtx);
      await markProposed(t, selectRule(rules, preFacts), "pre_cutoff");
      continue;
    }

    // Deterministic recognizers take precedence over merchant history, in order:
    //  - an internal transfer between two of the entity's own linked accounts
    //    (matched move — book once, ignore the counterpart),
    //  - a loan/mortgage payment split by the amortization schedule,
    //  - a credit-card payment to the card liability (unlinked-card fallback).
    // Everything else with no matching auto-apply rule is left for review.
    let transferPlan = planInternalTransfer(
      t,
      pending,
      mapByPlaidAcct,
      resolvedTransferIds
    );
    // The counterpart could already be consumed/posted this pass — drop the match.
    if (transferPlan && resolvedTransferIds.has(transferPlan.counterpartTxnId))
      transferPlan = null;
    const loanPlan = transferPlan
      ? null
      : await planLoanPayment(t, mappedAcct, loanRefs);
    const ccPlan =
      transferPlan || loanPlan ? null : planCreditCardPayment(t, cardCtx);

    const recognizerHit = !!(transferPlan || loanPlan || ccPlan);

    // Rules sit just below the structural recognizers: a recognizer always wins;
    // otherwise the highest-precedence matching rule decides. Only an `auto_apply`
    // rule still above its confidence bar posts unattended — a matching non-auto
    // rule becomes a proposal, and anything unmatched is left for review.
    const facts = extractFacts(t, factsCtx);
    const ruleMatch = recognizerHit ? null : selectRule(rules, facts);
    let rulePlan = ruleMatch && meetsAutoBar(ruleMatch) ? ruleMatch : null;

    // Gate 6 — the single remaining pre-post check (automation-first). When 2+
    // rules match, selectRule already picked the highest-precedence one, so we
    // post it rather than defer. Only a GROSS amount anomaly vs the merchant's
    // established history still holds the auto-post back as a proposal.
    let gateReason: ReviewReason | null = null;
    if (rulePlan) {
      gateReason = gate6(
        { merchant: facts.merchant, amountCents: t.amountCents, bankAccountId: mappedAcct },
        bands.get(facts.merchant)
      );
      if (gateReason) rulePlan = null;
    }

    if (!recognizerHit && !rulePlan) {
      // No unattended writer claims this — record a proposal (matching non-auto
      // rule, if any) and leave it for review, with the gate reason when a rule
      // was held back. The history learner proposes from the booked ledger
      // separately; the auto-poster never uses the fingerprint.
      await markProposed(t, ruleMatch, gateReason ?? undefined);
      continue;
    }

    // NOTE: the near-match-to-imported-history deferral that used to sit here
    // was removed (owner decision, 2026-07-02). The pre-cutoff guard above is
    // now the boundary defense: anything dated inside the imported-books
    // window never auto-posts, and anything after it is net-new by definition.
    // Amount+date proximity was the wrong signal for this ledger — recurring
    // charges (Turnoverbnb cleanings) legitimately repeat identical amounts on
    // back-to-back days across every entity, so the near window produced only
    // false alarms. post.ts's EXACT-import-dup hard block remains untouched.

    try {
      // Every automated post lands in ONE audit log (bk_categorization_events),
      // whichever executor wrote it — recognizer or rule — so the "who decided
      // this and why" trail is uniform across the cohesive system.
      const recognizerEvent = (journalEntryId: string, kind: string) =>
        recordEvent({
          entityId,
          plaidTxnId: t.id,
          journalEntryId,
          decisionSource: "recognizer",
          outcome: "auto_posted",
          actionKind: kind,
          reason: `${kind} recognizer`,
        });

      if (transferPlan) {
        const { journalEntryId } = await postPlaidTransaction(
          t.id,
          transferPlan.categoryAccountId,
          "plaid_auto"
        );
        await linkTransferCounterpart(transferPlan.counterpartTxnId, journalEntryId);
        resolvedTransferIds.add(transferPlan.counterpartTxnId);
        await recognizerEvent(journalEntryId, "transfer");
      } else if (loanPlan) {
        const { journalEntryId } = await postPlaidTransactionSplit(
          t.id,
          loanPlan.splits,
          "plaid_auto"
        );
        // Loan-specific audit detail: which loan, plus the notable events
        // (servicer change, escrow-re-analysis adoption) surfaced in `reason`
        // so the auto-posted feed reads like a narration, not a mystery.
        const notes = [
          loanPlan.servicerChanged
            ? `servicer appears to have changed (new payee "${loanPlan.payeeAlias}")`
            : null,
          loanPlan.adoptPaymentCents != null
            ? `payment changed — adopted $${(loanPlan.adoptPaymentCents / 100).toFixed(2)} as expected (escrow re-analysis)`
            : null,
        ].filter(Boolean);
        await recordEvent({
          entityId,
          plaidTxnId: t.id,
          journalEntryId,
          decisionSource: "recognizer",
          outcome: "auto_posted",
          actionKind: "loan",
          reason: `loan recognizer: ${loanPlan.loanName}${notes.length ? " — " + notes.join("; ") : ""}`,
        });
        await recordLoanRecognition(loanPlan, t.txnDate);
      } else if (ccPlan) {
        const { journalEntryId } = await postPlaidTransaction(
          t.id,
          ccPlan.categoryAccountId,
          "plaid_auto"
        );
        await recognizerEvent(journalEntryId, "credit_card");
      } else if (rulePlan) {
        // Auto-apply rule: posts via the right writer + logs the decision +
        // bumps the rule's applied counter (see lib/rules/apply.ts).
        await applyRuleToTxn(t.id, rulePlan, "plaid_auto", canonCache);
      }
      result.posted++;
    } catch (e) {
      result.errors++;
      console.error(
        `auto-post: failed txn ${t.id} (${t.merchantName ?? t.name}):`,
        e instanceof Error ? e.message : e
      );
    }
  }

  if (result.posted || result.skippedDup || result.errors) {
    console.log(
      `auto-post ${entityId}: posted=${result.posted} ` +
        `skippedDup=${result.skippedDup} errors=${result.errors}`
    );
  }
  return result;
}

/** Total `pending_review` transactions across all entities — the batch trigger. */
export async function countPendingPortfolio(): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.bkPlaidTransactions)
    .where(eq(schema.bkPlaidTransactions.status, "pending_review"));
  return row?.n ?? 0;
}

/** Distinct entity ids that currently have pending transactions. */
export async function entitiesWithPending(): Promise<string[]> {
  const rows = await db
    .selectDistinct({ entityId: schema.bkPlaidTransactions.entityId })
    .from(schema.bkPlaidTransactions)
    .where(eq(schema.bkPlaidTransactions.status, "pending_review"));
  return rows
    .map((r) => r.entityId)
    .filter((id): id is string => !!id);
}

/**
 * Run the deterministic auto-poster across every entity that has pending
 * transactions — the portfolio sweep the threshold cron fires once outstanding
 * crosses the trigger. Free (no AI) and idempotent. Per-entity failures are
 * isolated so one bad entity can't abort the sweep.
 */
export async function autoPostPortfolio(): Promise<AutoPostResult[]> {
  const ids = await entitiesWithPending();
  if (!ids.length) return [];
  const out: AutoPostResult[] = [];
  for (const entityId of ids) {
    try {
      out.push(await autoPostEntity(entityId));
    } catch (e) {
      console.error(`auto-post portfolio: entity ${entityId} failed:`, e);
      out.push({ entityId, posted: 0, skippedDup: 0, errors: 1 });
    }
  }
  return out;
}
