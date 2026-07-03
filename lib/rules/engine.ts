/**
 * Rule loading + selection — the precedence spine.
 *
 * `loadRules` returns the rules that apply to an entity (its own ∪ global),
 * already sorted into precedence order:
 *
 *   1. ENTITY before GLOBAL    — a concrete entity rule overrides the portfolio default
 *   2. rank ascending          — lower rank wins (author-controlled priority)
 *   3. specificity descending  — more conditions = more specific = wins ties
 *   4. created_at ascending     — stable, oldest-first final tiebreak
 *
 * `selectRule` returns the first rule whose predicate matches — so the sort IS
 * the precedence. The auto-poster and the dry-run preview share both functions.
 */
import { and, eq, or } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { matches, predicateSpecificity } from "@/lib/rules/predicates";
import type { ConditionGroup, TxnFacts } from "@/lib/rules/types";

export type RuleRow = typeof schema.bkRules.$inferSelect;

/** Precedence comparator (see module doc). Exported so preview can reuse it. */
export function compareRules(a: RuleRow, b: RuleRow): number {
  const scope = (a.scope === "entity" ? 0 : 1) - (b.scope === "entity" ? 0 : 1);
  if (scope) return scope;
  if (a.rank !== b.rank) return a.rank - b.rank;
  const spec =
    predicateSpecificity(b.predicate as ConditionGroup) -
    predicateSpecificity(a.predicate as ConditionGroup);
  if (spec) return spec;
  const at = a.createdAt ? a.createdAt.getTime() : 0;
  const bt = b.createdAt ? b.createdAt.getTime() : 0;
  return at - bt;
}

export function sortRules(rules: RuleRow[]): RuleRow[] {
  return [...rules].sort(compareRules);
}

/**
 * All enabled, active rules that apply to this entity: every global rule plus the
 * entity's own, in precedence order. (A global rule has `entityId IS NULL` and
 * `scope='global'`; another entity's rules are excluded by the scope/entity
 * filter.)
 */
export async function loadRules(entityId: string): Promise<RuleRow[]> {
  const { bkRules } = schema;
  const rows = await db
    .select()
    .from(bkRules)
    .where(
      and(
        eq(bkRules.enabled, true),
        eq(bkRules.status, "active"),
        or(eq(bkRules.scope, "global"), eq(bkRules.entityId, entityId))
      )
    );
  return sortRules(rows);
}

/** First rule (in precedence order) whose predicate matches — or null. */
export function selectRule(rules: RuleRow[], facts: TxnFacts): RuleRow | null {
  for (const r of rules) {
    if (matches(r.predicate as ConditionGroup, facts)) return r;
  }
  return null;
}

/**
 * Every rule whose predicate matches, in precedence order. Used for Gate 7's
 * ambiguity check: when more than one DISTINCT-action rule matches a txn, the
 * destination isn't unambiguous, so the auto-poster must defer to review rather
 * than silently let precedence pick a winner.
 */
export function allMatchingRules(rules: RuleRow[], facts: TxnFacts): RuleRow[] {
  return rules.filter((r) => matches(r.predicate as ConditionGroup, facts));
}
