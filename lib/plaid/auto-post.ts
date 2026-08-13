import { and, eq, sql } from "drizzle-orm";
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
  awaitingTransferOutflow,
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
import { loadInterceptingHolds, holdMatches, recordHoldMatch } from "@/lib/plaid/holds";
import { reviewReasonText, type ReviewReason } from "@/lib/rules/review-reasons";
import { activeAccountIds } from "@/lib/plaid/auto-categorize";
import {
  recordSuggestionDecision,
  AI_AUTOPOST_MAX_CENTS,
  aiAutopostEnabled,
} from "@/lib/ai/events";
import type { ActionSpec } from "@/lib/rules/types";

/**
 * Unattended applier — post only the transactions a trusted writer is certain
 * about, then leave everything else for suggestion + review. Three writers
 * post here without a human, in precedence order: the structural recognizers
 * (internal transfer, loan split, credit-card payment), `auto_apply` rules
 * (lib/rules), and — LAST, only for transactions no rule even matches — AI
 * suggestions whose calibration bucket has EARNED auto-post (ADR-021:
 * measured ≥98% precision over ≥50 outcomes, ≤$1,000, Gate-6 checked; one
 * undo locks the bucket again). The statistical merchant fingerprint no
 * longer auto-posts — the history learner proposes rules from the booked
 * ledger instead, so every unattended post traces to a recognizer, an
 * approved rule, or an earned AI bucket.
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
  const last4ByPlaidAcct = new Map<string, string | null>();
  for (const it of items)
    for (const a of it.accounts) {
      mapByPlaidAcct.set(a.plaidAccountId, a.mappedAccountId);
      subtypeByPlaidAcct.set(a.plaidAccountId, a.subtype ?? null);
      last4ByPlaidAcct.set(a.plaidAccountId, a.mask ?? null);
    }

  // The deterministic rules layer (user-authored), the facts context the
  // predicates read, and a per-entity canonical-resolution cache shared across
  // the batch.
  const rules = await loadRules(entityId);
  const factsCtx = { subtypeByPlaidAcct, last4ByPlaidAcct };
  const canonCache = newCanonCache();

  // Owner heads-up holds — active-window, unacknowledged. Checked FIRST per
  // transaction (ahead of recognizers/rules/AI): the owner explicitly asked to
  // eyeball a matching transaction, so nothing posts it unattended.
  const holds = await loadInterceptingHolds(entityId);

  // Equity accounts, for the Gate 6 exemption below. A rule that posts to
  // EQUITY is a capital move between the owner/partners' own bank accounts —
  // amounts legitimately swing by orders of magnitude (a $700 top-up one week,
  // a six-figure capital call the next), so the merchant amount-band check
  // produces only false alarms there (owner decision 2026-08-05: partner
  // transfer rules post unattended at any amount). Everything else keeps the
  // gate.
  const equityAccountIds = new Set(
    (
      await db
        .select({ id: schema.bkAccounts.id })
        .from(schema.bkAccounts)
        .where(
          and(
            eq(schema.bkAccounts.entityId, entityId),
            eq(schema.bkAccounts.accountType, "Equity")
          )
        )
    ).map((r) => r.id)
  );
  // Unlocked AI calibration buckets — the earned-trust set. Usually empty
  // (shadow mode) or tiny; loaded once per entity sweep. The owner-controlled
  // AI_AUTOPOST_ENABLED flag (default OFF) is the master switch: while it is
  // off, even earned buckets stay suggestion-only and the AI stage below never
  // fires. Deterministic rules/recognizers are unaffected.
  const unlockedBuckets = aiAutopostEnabled()
    ? new Set(
        (
          await db
            .select({ bucketKey: schema.bkAutopostBuckets.bucketKey })
            .from(schema.bkAutopostBuckets)
            .where(eq(schema.bkAutopostBuckets.status, "unlocked"))
        ).map((r) => r.bucketKey)
      )
    : new Set<string>();

  // Gate 6 (per-txn outlier) only matters once something can actually
  // auto-post beyond the recognizers. Skip the history scan when neither an
  // auto-apply rule nor an unlocked AI bucket exists.
  let bands: MerchantBands = new Map();
  if (rules.some((r) => r.autoApply) || unlockedBuckets.size) {
    const since36 = new Date();
    since36.setMonth(since36.getMonth() - 36);
    bands = await buildMerchantBands(entityId, since36.toISOString().slice(0, 10));
  }

  // AI auto-posts must target a still-active account; validated per batch.
  const suggestedIds = pending
    .map((t) => t.suggestedAccountId)
    .filter((v): v is string => !!v);
  const activeSuggested = suggestedIds.length
    ? await activeAccountIds(entityId, suggestedIds)
    : new Set<string>();

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
    // Bank-PENDING rows never auto-post. The sync no longer stores them at
    // all; this skip is a defensive guard for any pre-policy straggler (the
    // settled version arrives as its own transaction).
    if (t.pending) continue;
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

    // Owner hold — outranks EVERYTHING, recognizers included: the owner
    // placed a heads-up that this exact amount / vendor is coming and wants
    // it in the review queue, not auto-posted. Rules are untouched; the hold
    // simply wins for its window.
    const hold = holds.find((h) => holdMatches(h, { name: t.name, merchantName: t.merchantName, amountCents: Number(t.amountCents) }));
    if (hold) {
      await recordHoldMatch(hold.id, t.id);
      await markProposed(t, null, "owner_hold");
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
    // The inflow half of a pending transfer WAITS for its outflow — the source
    // side books the move and resolves this row. Rules must never claim it in
    // the meantime (that double-books the move, one entry per side).
    if (
      !transferPlan &&
      awaitingTransferOutflow(t, pending, mapByPlaidAcct, resolvedTransferIds)
    ) {
      await markProposed(t, null, "transfer_recognizer_conflict");
      continue;
    }
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
    // established history still holds the auto-post back as a proposal —
    // except when the rule targets an EQUITY account (capital moves; see the
    // equityAccountIds note above).
    let gateReason: ReviewReason | null = null;
    if (rulePlan) {
      const targetsEquity =
        rulePlan.action.kind === "categorize" &&
        rulePlan.action.target.by === "account" &&
        equityAccountIds.has(rulePlan.action.target.accountId);
      if (!targetsEquity) {
        gateReason = gate6(
          { merchant: facts.merchant, amountCents: t.amountCents, bankAccountId: mappedAcct },
          bands.get(facts.merchant)
        );
        if (gateReason) rulePlan = null;
      }
    }

    // AI stage — ONLY for transactions no rule even matches (a matching rule,
    // auto or not, is the owner's explicit intent and outranks the model).
    // Every condition is an independent brake: the suggestion's bucket must
    // have EARNED unlock (measured precision), the amount must be under the
    // owner's $1,000 cap, the target account must still be active, and Gate 6
    // must not flag the amount as an outlier for this merchant.
    let aiPost: { accountId: string; payee: string | null } | null = null;
    if (
      !recognizerHit &&
      !ruleMatch &&
      unlockedBuckets.size &&
      t.suggestionSource === "ai" &&
      t.suggestedAccountId &&
      t.suggestionBucket &&
      unlockedBuckets.has(t.suggestionBucket) &&
      activeSuggested.has(t.suggestedAccountId) &&
      Math.abs(t.amountCents) <= AI_AUTOPOST_MAX_CENTS
    ) {
      const aiGate = gate6(
        { merchant: facts.merchant, amountCents: t.amountCents, bankAccountId: mappedAcct },
        bands.get(facts.merchant)
      );
      if (aiGate) {
        gateReason = aiGate;
      } else {
        aiPost = { accountId: t.suggestedAccountId, payee: t.suggestedPayee ?? null };
      }
    }

    if (!recognizerHit && !rulePlan && !aiPost) {
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
      //
      // Each branch runs post + counterpart-link + event in a SINGLE
      // db.transaction, so an unattended write can never partially succeed
      // (e.g. a posted transfer whose counterpart stayed pending, or a post
      // with no audit event). recordLoanRecognition stays outside — it only
      // updates learning metadata (aliases/counters), never money.
      if (transferPlan) {
        const plan = transferPlan;
        await db.transaction(async (tx) => {
          const { journalEntryId } = await postPlaidTransaction(
            t.id,
            plan.categoryAccountId,
            "plaid_auto",
            undefined,
            tx
          );
          await linkTransferCounterpart(plan.counterpartTxnId, journalEntryId, tx);
          await recordEvent(
            {
              entityId,
              plaidTxnId: t.id,
              journalEntryId,
              decisionSource: "recognizer",
              outcome: "auto_posted",
              actionKind: "transfer",
              reason: "transfer recognizer",
            },
            tx
          );
        });
        resolvedTransferIds.add(plan.counterpartTxnId);
      } else if (loanPlan) {
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
        await db.transaction(async (tx) => {
          const { journalEntryId } = await postPlaidTransactionSplit(
            t.id,
            loanPlan.splits,
            "plaid_auto",
            tx
          );
          await recordEvent(
            {
              entityId,
              plaidTxnId: t.id,
              journalEntryId,
              decisionSource: "recognizer",
              outcome: "auto_posted",
              actionKind: "loan",
              reason: `loan recognizer: ${loanPlan.loanName}${notes.length ? " — " + notes.join("; ") : ""}`,
            },
            tx
          );
        });
        await recordLoanRecognition(loanPlan, t.txnDate);
      } else if (ccPlan) {
        await db.transaction(async (tx) => {
          const { journalEntryId } = await postPlaidTransaction(
            t.id,
            ccPlan.categoryAccountId,
            "plaid_auto",
            undefined,
            tx
          );
          await recordEvent(
            {
              entityId,
              plaidTxnId: t.id,
              journalEntryId,
              decisionSource: "recognizer",
              outcome: "auto_posted",
              actionKind: "credit_card",
              reason: "credit_card recognizer",
            },
            tx
          );
        });
      } else if (rulePlan) {
        // Auto-apply rule: posts via the right writer + logs the decision +
        // bumps the rule's applied counter (see lib/rules/apply.ts).
        await applyRuleToTxn(t.id, rulePlan, "plaid_auto", canonCache);
      } else if (aiPost) {
        // Earned AI bucket: post through the same guarded writer, carry the
        // AI-cleaned payee, and flip the suggestion event to auto_posted (an
        // un-reversed auto-post counts as correct; an undo locks the bucket).
        const plan = aiPost;
        await db.transaction(async (tx) => {
          await postPlaidTransaction(t.id, plan.accountId, "plaid_auto", plan.payee, tx);
          await recordSuggestionDecision(
            { txnId: t.id, postedAccountId: plan.accountId, kind: "auto" },
            tx
          );
        });
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
