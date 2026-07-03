/**
 * Server-side glue for the rule admin UI — the operations both the entity and
 * the global surfaces perform, minus the access checks (the route `actions.ts`
 * wrappers add `assertEntityAccess` / `assertAdmin`). Keeping the logic here
 * means the two surfaces can't drift.
 */
import { createRule, updateRule, getRule } from "@/lib/rules/store";
import { buildPredicate, type ConditionRow } from "@/lib/rules/build";
import { previewRule, type PreviewResult } from "@/lib/rules/preview";
import {
  applyRuleToTxn,
  applyToSimilar,
  applyRetroactively,
  buildFactsContext,
} from "@/lib/rules/apply";
import { extractFacts } from "@/lib/rules/facts";
import { matches } from "@/lib/rules/predicates";
import { newCanonCache } from "@/lib/rules/actions";
import { assertRuleAppliesToEntity, assertTxnInEntity } from "@/lib/rules/authz";
import { listPendingTransactions } from "@/lib/plaid/data";
import type { ActionSpec, ConditionGroup } from "@/lib/rules/types";

export interface RulePayload {
  ruleId?: string;
  name: string;
  description?: string | null;
  combinator: "all" | "any";
  conditions: ConditionRow[];
  action: ActionSpec;
  enabled: boolean;
  autoApply: boolean;
  rank: number;
}

export async function saveRule(
  payload: RulePayload,
  scope: "global" | "entity",
  entityId: string | null,
  actor: string | null
): Promise<{ ruleId: string }> {
  const predicate = buildPredicate(payload.combinator, payload.conditions);
  const common = {
    name: payload.name,
    description: payload.description ?? null,
    enabled: payload.enabled,
    autoApply: payload.autoApply,
    rank: payload.rank,
    predicate,
    action: payload.action,
  };
  if (payload.ruleId) {
    const r = await updateRule(payload.ruleId, common, actor);
    return { ruleId: r.id };
  }
  const r = await createRule({ scope, entityId, ...common }, actor);
  return { ruleId: r.id };
}

/** Dry-run preview against a concrete entity (global rules preview per-entity). */
export async function previewPayload(
  payload: RulePayload,
  scope: "global" | "entity",
  previewEntityId: string
): Promise<PreviewResult> {
  const predicate = buildPredicate(payload.combinator, payload.conditions);
  return previewRule(previewEntityId, {
    scope,
    rank: payload.rank,
    predicate,
    action: payload.action,
    excludeRuleId: payload.ruleId,
  });
}

export async function setRuleFlag(
  ruleId: string,
  patch: { enabled?: boolean; autoApply?: boolean; status?: "active" | "archived" },
  actor: string | null
) {
  await updateRule(ruleId, patch, actor);
}

/** Apply a saved rule to ONE pending transaction (the review-row "Apply here"). */
export async function applyRuleOnce(
  ruleId: string,
  txnId: string,
  entityId: string,
  actor: string | null
) {
  const rule = await getRule(ruleId);
  if (!rule) throw new Error("rule not found");
  // Bind both ids to the authorized entity: the rule must be global or owned by
  // entityId, and the txn must belong to entityId — otherwise a caller could
  // post into another entity's books with a foreign txnId + a (global) ruleId.
  assertRuleAppliesToEntity(rule, entityId);
  await assertTxnInEntity(txnId, entityId);
  return applyRuleToTxn(txnId, rule, "plaid", newCanonCache(), actor);
}

/** Apply a saved rule to every still-pending matching transaction in an entity. */
export async function applyRuleToPending(ruleId: string, entityId: string, actor: string | null) {
  const rule = await getRule(ruleId);
  if (!rule) throw new Error("rule not found");
  assertRuleAppliesToEntity(rule, entityId); // no foreign entity rule on this entity
  return applyToSimilar(entityId, rule, newCanonCache(), actor);
}

/** Retroactively re-categorize already-posted matches in an entity. */
export async function applyRuleRetroactive(ruleId: string, entityId: string, actor: string | null) {
  const rule = await getRule(ruleId);
  if (!rule) throw new Error("rule not found");
  assertRuleAppliesToEntity(rule, entityId); // no foreign entity rule on this entity
  return applyRetroactively(entityId, rule, newCanonCache(), actor);
}

/** Count still-pending matches for a saved rule (used by list "apply" affordances). */
export async function countPendingMatches(ruleId: string, entityId: string): Promise<number> {
  const rule = await getRule(ruleId);
  if (!rule) return 0;
  const [pending, ctx] = await Promise.all([
    listPendingTransactions(entityId),
    buildFactsContext(entityId),
  ]);
  let n = 0;
  for (const t of pending) {
    if (matches(rule.predicate as ConditionGroup, extractFacts(t, ctx))) n++;
  }
  return n;
}
