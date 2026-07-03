/**
 * Entity-binding authorization guards for the rules engine.
 *
 * `assertEntityAccess(entityId)` only proves the caller may touch the entity id
 * NAMED in the request — it does NOT prove that a separately-supplied ruleId /
 * txnId / account id belongs to that entity. Without that binding, a user
 * authorized for entity A could submit entity B's ids and mutate B. These guards
 * close that gap; the route actions call them right after `assertEntityAccess`.
 *
 * Intended design (preserved): a GLOBAL rule (scope='global', entityId NULL)
 * applies to every entity and may be APPLIED by any authorized entity user, but
 * only an admin may MODIFY its definition/status. An ENTITY rule belongs to one
 * entity and must never affect another.
 */
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import type { RuleRow } from "@/lib/rules/engine";

type RuleScope = Pick<RuleRow, "scope" | "entityId">;

/** Pure: may this rule be APPLIED to a transaction in `entityId`? */
export function ruleAppliesToEntity(rule: RuleScope, entityId: string): boolean {
  return rule.scope === "global" || rule.entityId === entityId;
}

/** Pure: may the caller MODIFY this rule's definition/status for `entityId`? */
export function ruleMutableBy(
  rule: RuleScope,
  entityId: string,
  isAdmin: boolean
): boolean {
  if (rule.scope === "global") return isAdmin; // global rules are admin-only
  return rule.entityId === entityId; // entity rules: must be the owning entity
}

/** Throw unless the rule may be applied to `entityId` (global or entity-owned). */
export function assertRuleAppliesToEntity(rule: RuleRow, entityId: string): void {
  if (!ruleAppliesToEntity(rule, entityId)) {
    throw new Error("rule does not belong to this entity");
  }
}

/**
 * Throw unless the caller may modify this rule. Global → admins only; entity →
 * must belong to `entityId`. Distinct messages so the UI can tell them apart.
 */
export function assertRuleMutable(
  rule: RuleRow,
  entityId: string,
  isAdmin: boolean
): void {
  if (rule.scope === "global") {
    if (!isAdmin) throw new Error("global rules are admin-only");
    return;
  }
  if (rule.entityId !== entityId) {
    throw new Error("rule does not belong to this entity");
  }
}

/** Throw unless the Plaid transaction belongs to `entityId`. */
export async function assertTxnInEntity(
  txnId: string,
  entityId: string
): Promise<void> {
  const [t] = await db
    .select({ entityId: schema.bkPlaidTransactions.entityId })
    .from(schema.bkPlaidTransactions)
    .where(eq(schema.bkPlaidTransactions.id, txnId));
  if (!t || t.entityId !== entityId) {
    throw new Error("transaction does not belong to this entity");
  }
}

/** Throw unless the Plaid-account row belongs to `entityId`. */
export async function assertPlaidAccountInEntity(
  plaidAccountRowId: string,
  entityId: string
): Promise<void> {
  const [a] = await db
    .select({ entityId: schema.bkPlaidAccounts.entityId })
    .from(schema.bkPlaidAccounts)
    .where(eq(schema.bkPlaidAccounts.id, plaidAccountRowId));
  if (!a || a.entityId !== entityId) {
    throw new Error("bank account does not belong to this entity");
  }
}

/** Throw unless the ledger account belongs to `entityId`. */
export async function assertAccountInEntity(
  accountId: string,
  entityId: string
): Promise<void> {
  const [a] = await db
    .select({ id: schema.bkAccounts.id })
    .from(schema.bkAccounts)
    .where(
      and(eq(schema.bkAccounts.id, accountId), eq(schema.bkAccounts.entityId, entityId))
    );
  if (!a) throw new Error("account does not belong to this entity");
}
