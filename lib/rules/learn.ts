/**
 * The learning loop — "learn from my decisions."
 *
 * When the owner posts a reviewed transaction that a rule had pre-filled, that
 * post is either a CONFIRMATION (they accepted the rule's suggested category) or
 * a CORRECTION (they chose a different one). This module records that signal and
 * decides whether a Review-only rule has now EARNED auto_apply:
 *
 *   • confirmation → confirmedCount++ (and appliedCount++); if the rule has
 *     reached its clean-confirmation bar with zero corrections it GRADUATES to
 *     auto_apply. Bulk "apply to similar/retroactive" deliberately do NOT touch
 *     confirmedCount, so they can never graduate a rule.
 *   • correction   → correctedCount++; if the rule was auto_apply it is
 *     immediately DEMOTED back to Review-only — one wrong call pulls trust.
 *
 * The counter bump, the graduation/demotion flip, and the audit event are done
 * in ONE transaction against the row locked FOR UPDATE, so a confirmation racing
 * a correction can't graduate a rule the correction should have blocked. Every
 * call returns a plain-language explanation. Only `categorize` rules participate.
 */
import { eq } from "drizzle-orm";
import { db, schema, type DbTx } from "@/lib/db/client";
import { resolveAction, newCanonCache, type CanonCache } from "@/lib/rules/actions";
import {
  meetsGraduationBar,
  ruleConfidence,
  GRADUATE_MIN_CONFIRMATIONS,
} from "@/lib/rules/confidence";
import type { ActionSpec } from "@/lib/rules/types";

const { bkRules, bkCategorizationEvents } = schema;

export interface RuleOutcome {
  outcome: "confirmed" | "corrected" | "none";
  graduated: boolean;
  demoted: boolean;
  /** Owner-facing explanation of what this decision did. "" when outcome=none. */
  explanation: string;
}

const NONE: RuleOutcome = { outcome: "none", graduated: false, demoted: false, explanation: "" };

/**
 * Record a confirmation/correction for the rule that pre-filled a now-posted
 * transaction. `chosenAccountId` is the category the owner actually posted.
 */
export async function recordRuleOutcome(opts: {
  ruleId: string;
  entityId: string;
  chosenAccountId: string;
  absAmountCents: number;
  journalEntryId?: string | null;
  actor: string | null;
  cache?: CanonCache;
  // Optional caller transaction — when present, the confirmation/correction
  // (counter bump + graduation/demotion + audit event) joins the caller's
  // transaction so it's atomic with the ledger post. Absent → own transaction.
  tx?: DbTx;
}): Promise<RuleOutcome> {
  const body = async (tx: DbTx): Promise<RuleOutcome> => {
    // Lock the rule for the whole decision so the bump + flip + event are atomic.
    const [rule] = await tx
      .select()
      .from(bkRules)
      .where(eq(bkRules.id, opts.ruleId))
      .for("update");
    if (!rule) return NONE;
    const action = rule.action as ActionSpec;
    if (action.kind !== "categorize") return NONE; // only single-category rules confirm/correct

    // Resolve the rule's suggested account (read-only) to compare with the choice.
    const res = await resolveAction(action, opts.entityId, opts.absAmountCents, opts.cache ?? newCanonCache());
    if (!res.resolved || res.resolved.kind !== "categorize") return NONE;
    const suggested = res.resolved.categoryAccountId;

    const confirmed = opts.chosenAccountId === suggested;
    const now = new Date();

    if (confirmed) {
      const confirmedAfter = rule.confirmedCount + 1;
      const graduated =
        !rule.autoApply &&
        meetsGraduationBar({ confirmedCount: confirmedAfter, correctedCount: rule.correctedCount });
      await tx
        .update(bkRules)
        .set({
          appliedCount: rule.appliedCount + 1,
          confirmedCount: confirmedAfter,
          autoApply: rule.autoApply || graduated,
          lastAppliedAt: now,
          updatedAt: now,
        })
        .where(eq(bkRules.id, rule.id));
      await tx.insert(bkCategorizationEvents).values({
        entityId: opts.entityId,
        journalEntryId: opts.journalEntryId ?? null,
        ruleId: rule.id,
        decisionSource: "manual",
        outcome: "applied_manual",
        actionKind: "categorize",
        confidence: ruleConfidence(rule.appliedCount + 1, rule.correctedCount),
        reason: graduated ? "confirmed → graduated to auto-apply" : "confirmed",
        createdBy: opts.actor,
      });
      const remaining = Math.max(0, GRADUATE_MIN_CONFIRMATIONS - confirmedAfter);
      const explanation = graduated
        ? `Confirmed “${rule.name}” — confirmation #${confirmedAfter}, 0 corrections. ✅ This rule has now EARNED auto-apply and will post matching transactions unattended (each still passes the per-transaction outlier check first).`
        : `Confirmed “${rule.name}” — confirmation #${confirmedAfter}, ${rule.correctedCount} correction${rule.correctedCount === 1 ? "" : "s"}. ${remaining} more clean confirmation${remaining === 1 ? "" : "s"} until it graduates from Review-only to auto-apply.`;
      return { outcome: "confirmed", graduated, demoted: false, explanation };
    }

    // ---- correction ----
    const demoted = rule.autoApply;
    await tx
      .update(bkRules)
      .set({ correctedCount: rule.correctedCount + 1, autoApply: false, updatedAt: now })
      .where(eq(bkRules.id, rule.id));
    await tx.insert(bkCategorizationEvents).values({
      entityId: opts.entityId,
      journalEntryId: opts.journalEntryId ?? null,
      ruleId: rule.id,
      decisionSource: "manual",
      outcome: "corrected",
      actionKind: "categorize",
      confidence: ruleConfidence(rule.appliedCount, rule.correctedCount + 1),
      reason: demoted ? "corrected → demoted from auto-apply" : "corrected",
      createdBy: opts.actor,
    });
    const explanation = demoted
      ? `Re-categorized away from “${rule.name}”. ⚠️ That rule is DEMOTED from auto-apply back to Review-only until it earns trust again.`
      : `Re-categorized away from “${rule.name}”. Logged as a correction — its confidence dropped and it stays Review-only.`;
    return { outcome: "corrected", graduated: false, demoted, explanation };
  };
  return opts.tx ? body(opts.tx) : db.transaction(body);
}
