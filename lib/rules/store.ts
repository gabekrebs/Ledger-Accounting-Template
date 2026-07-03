/**
 * Rule persistence + the decision/audit logs.
 *
 *   • CRUD on `bk_rules`, with per-field change logging to `bk_rule_edits`
 *     (mirrors `editTransaction`'s diff loop — append-only provenance for "who
 *     changed this rule and when").
 *   • `recordEvent` → `bk_categorization_events` (the append-only decision log).
 *   • `bumpApplied` / `bumpCorrected` → the counters that feed `ruleConfidence`.
 *   • `proposeLearnedRule` → the hook the FUTURE history→rule learner writes
 *     through (origin='learned', status='proposed', enabled=false). Unused this
 *     phase; present so the schema + call site exist.
 */
import { and, desc, eq, or, sql } from "drizzle-orm";
import { db, schema, type DbOrTx } from "@/lib/db/client";
import { validatePredicate } from "@/lib/rules/predicates";
import { validateAction } from "@/lib/rules/actions";
import { ruleConfidence } from "@/lib/rules/confidence";
import type { RuleRow } from "@/lib/rules/engine";
import type {
  ActionSpec,
  ConditionGroup,
  DecisionSource,
  Outcome,
} from "@/lib/rules/types";

const { bkRules, bkRuleEdits, bkCategorizationEvents } = schema;

// ── CRUD ─────────────────────────────────────────────────────────────────────

export interface RuleInput {
  scope: "global" | "entity";
  entityId: string | null;
  name: string;
  description?: string | null;
  enabled?: boolean;
  autoApply?: boolean;
  rank?: number;
  predicate: ConditionGroup;
  action: ActionSpec;
}

/** The rule fields whose changes are audited to bk_rule_edits. */
type AuditedField =
  | "name"
  | "predicate"
  | "action"
  | "enabled"
  | "auto_apply"
  | "rank"
  | "status";

async function assertValid(input: {
  scope: "global" | "entity";
  entityId: string | null;
  predicate: ConditionGroup;
  action: ActionSpec;
  autoApply?: boolean;
}) {
  if (input.scope === "global" && input.entityId !== null) {
    throw new Error("global rules must not be scoped to an entity");
  }
  if (input.scope === "entity" && !input.entityId) {
    throw new Error("entity rules require an entityId");
  }
  const pErrs = validatePredicate(input.predicate);
  if (pErrs.length) throw new Error(pErrs.join("; "));
  const aErrs = await validateAction(input.action, input.scope, input.entityId);
  if (aErrs.length) throw new Error(aErrs.join("; "));
  // auto_apply is an UNATTENDED write — only meaningful for actions that resolve
  // a transaction without a human (categorize / split / ignore). A
  // leave-uncategorized or transfer rule can only ever be a proposal.
  if (
    input.autoApply &&
    input.action.kind !== "categorize" &&
    input.action.kind !== "split" &&
    input.action.kind !== "ignore"
  ) {
    throw new Error(
      "auto-apply is only valid for categorize / split / ignore actions"
    );
  }
}

export async function createRule(
  input: RuleInput,
  createdBy: string | null
): Promise<RuleRow> {
  await assertValid(input);
  const [row] = await db
    .insert(bkRules)
    .values({
      scope: input.scope,
      entityId: input.entityId,
      name: input.name,
      description: input.description ?? null,
      enabled: input.enabled ?? true,
      // Automation-first default: a new categorize/split/ignore rule auto-applies
      // unless the author opts out. (leave_uncategorized / transfer can't auto-
      // apply, so they default off and the assertValid guard still holds.)
      autoApply:
        input.autoApply ??
        (input.action.kind === "categorize" ||
          input.action.kind === "split" ||
          input.action.kind === "ignore"),
      rank: input.rank ?? 100,
      predicate: input.predicate,
      action: input.action,
      createdBy,
    })
    .returning();
  return row;
}

export interface RulePatch {
  name?: string;
  description?: string | null;
  enabled?: boolean;
  autoApply?: boolean;
  rank?: number;
  status?: "active" | "proposed" | "archived";
  predicate?: ConditionGroup;
  action?: ActionSpec;
}

/**
 * Apply a patch, logging each audited field change to bk_rule_edits. Re-validates
 * predicate/action when they change. Atomic. Returns the updated row.
 */
export async function updateRule(
  ruleId: string,
  patch: RulePatch,
  editedBy: string | null
): Promise<RuleRow> {
  return db.transaction(async (tx) => {
    const [cur] = await tx
      .select()
      .from(bkRules)
      .where(eq(bkRules.id, ruleId))
      .for("update");
    if (!cur) throw new Error("rule not found");

    // Validate the resulting (merged) rule when predicate/action/auto change.
    if (patch.predicate || patch.action || patch.autoApply !== undefined) {
      await assertValid({
        scope: cur.scope as "global" | "entity",
        entityId: cur.entityId,
        predicate: patch.predicate ?? (cur.predicate as ConditionGroup),
        action: patch.action ?? (cur.action as ActionSpec),
        autoApply: patch.autoApply ?? cur.autoApply,
      });
    }

    const next: Record<string, unknown> = {};
    const edits: (typeof bkRuleEdits.$inferInsert)[] = [];
    const stamp = { editedAt: new Date(), editedBy };
    const log = (field: AuditedField, oldV: unknown, newV: unknown) => {
      edits.push({
        ruleId,
        entityId: cur.entityId,
        field,
        oldValue: JSON.stringify(oldV ?? null),
        newValue: JSON.stringify(newV ?? null),
        ...stamp,
      });
    };

    if (patch.name !== undefined && patch.name !== cur.name) {
      next.name = patch.name;
      log("name", cur.name, patch.name);
    }
    if (patch.description !== undefined && patch.description !== cur.description) {
      next.description = patch.description; // descriptive only — not audited
    }
    if (patch.enabled !== undefined && patch.enabled !== cur.enabled) {
      next.enabled = patch.enabled;
      log("enabled", cur.enabled, patch.enabled);
    }
    if (patch.autoApply !== undefined && patch.autoApply !== cur.autoApply) {
      next.autoApply = patch.autoApply;
      log("auto_apply", cur.autoApply, patch.autoApply);
    }
    if (patch.rank !== undefined && patch.rank !== cur.rank) {
      next.rank = patch.rank;
      log("rank", cur.rank, patch.rank);
    }
    if (patch.status !== undefined && patch.status !== cur.status) {
      next.status = patch.status;
      log("status", cur.status, patch.status);
    }
    // Deep-compare (admin.saveRule always passes predicate+action, even on a
    // no-op re-save) so we don't write spurious bk_rule_edits rows + re-validate.
    if (
      patch.predicate !== undefined &&
      JSON.stringify(patch.predicate) !== JSON.stringify(cur.predicate)
    ) {
      next.predicate = patch.predicate;
      log("predicate", cur.predicate, patch.predicate);
    }
    if (
      patch.action !== undefined &&
      JSON.stringify(patch.action) !== JSON.stringify(cur.action)
    ) {
      next.action = patch.action;
      log("action", cur.action, patch.action);
    }

    if (Object.keys(next).length === 0) return cur;
    next.updatedAt = new Date();

    const [row] = await tx
      .update(bkRules)
      .set(next)
      .where(eq(bkRules.id, ruleId))
      .returning();
    if (edits.length) await tx.insert(bkRuleEdits).values(edits);
    return row;
  });
}

export async function getRule(ruleId: string): Promise<RuleRow | null> {
  const [row] = await db.select().from(bkRules).where(eq(bkRules.id, ruleId));
  return row ?? null;
}

/** Proposed rules awaiting approval for an entity (its own, entity-scoped). */
export async function listProposedForEntity(entityId: string): Promise<RuleRow[]> {
  return db
    .select()
    .from(bkRules)
    .where(
      and(
        eq(bkRules.status, "proposed"),
        eq(bkRules.scope, "entity"),
        eq(bkRules.entityId, entityId)
      )
    )
    .orderBy(desc(bkRules.createdAt));
}

/** Proposed GLOBAL rules awaiting admin approval. */
export async function listProposedGlobal(): Promise<RuleRow[]> {
  return db
    .select()
    .from(bkRules)
    .where(and(eq(bkRules.status, "proposed"), eq(bkRules.scope, "global")))
    .orderBy(desc(bkRules.createdAt));
}

/** Global rules (the admin-only portfolio surface), newest first within precedence. */
export async function listGlobalRules(): Promise<RuleRow[]> {
  return db
    .select()
    .from(bkRules)
    .where(eq(bkRules.scope, "global"))
    .orderBy(bkRules.rank, desc(bkRules.createdAt));
}

/** Every rule visible to an entity: its own + all global (any status, for the admin list). */
export async function listRulesForEntity(entityId: string): Promise<RuleRow[]> {
  return db
    .select()
    .from(bkRules)
    .where(or(eq(bkRules.scope, "global"), eq(bkRules.entityId, entityId)))
    .orderBy(bkRules.rank, desc(bkRules.createdAt));
}

// ── Decision log ──────────────────────────────────────────────────────────────

export interface CategorizationEventInput {
  entityId: string | null;
  plaidTxnId?: string | null;
  journalEntryId?: string | null;
  ruleId?: string | null;
  decisionSource: DecisionSource;
  outcome: Outcome;
  actionKind?: string | null;
  confidence?: number | null;
  reason?: string | null;
  detail?: unknown;
  createdBy?: string | null;
}

export async function recordEvent(
  evt: CategorizationEventInput,
  exec: DbOrTx = db
): Promise<void> {
  await exec.insert(bkCategorizationEvents).values({
    entityId: evt.entityId,
    plaidTxnId: evt.plaidTxnId ?? null,
    journalEntryId: evt.journalEntryId ?? null,
    ruleId: evt.ruleId ?? null,
    decisionSource: evt.decisionSource,
    outcome: evt.outcome,
    actionKind: evt.actionKind ?? null,
    confidence: evt.confidence ?? null,
    reason: evt.reason ?? null,
    detail: evt.detail ?? null,
    createdBy: evt.createdBy ?? null,
  });
}

/** Recent decision-log events for a rule (the "[ruleId] recent events" panel). */
export async function recentEventsForRule(ruleId: string, limit = 25) {
  return db
    .select()
    .from(bkCategorizationEvents)
    .where(eq(bkCategorizationEvents.ruleId, ruleId))
    .orderBy(desc(bkCategorizationEvents.createdAt))
    .limit(limit);
}

// ── Counters / confidence ─────────────────────────────────────────────────────

export async function bumpApplied(
  ruleId: string,
  n = 1,
  exec: DbOrTx = db
): Promise<void> {
  await exec
    .update(bkRules)
    .set({
      appliedCount: sql`${bkRules.appliedCount} + ${n}`,
      lastAppliedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(bkRules.id, ruleId));
}

export async function bumpCorrected(ruleId: string, n = 1, exec: DbOrTx = db): Promise<void> {
  await exec
    .update(bkRules)
    .set({
      correctedCount: sql`${bkRules.correctedCount} + ${n}`,
      updatedAt: new Date(),
    })
    .where(eq(bkRules.id, ruleId));
}

export function precisionFor(rule: {
  appliedCount: number;
  correctedCount: number;
}): number {
  return ruleConfidence(rule.appliedCount, rule.correctedCount);
}

// ── Learner hook (UNUSED this phase) ─────────────────────────────────────────

/**
 * Insert a PROPOSED rule the history→rule learner discovered. Disabled and
 * non-active by construction, so it can never post until a human promotes it.
 * Present only so the learner (a later phase) has a stable write path.
 */
export async function proposeLearnedRule(
  input: Omit<RuleInput, "enabled"> & { proposedFromTxnId?: string | null }
): Promise<RuleRow> {
  await assertValid({ ...input, autoApply: false });
  const [row] = await db
    .insert(bkRules)
    .values({
      scope: input.scope,
      entityId: input.entityId,
      name: input.name,
      description: input.description ?? null,
      enabled: false,
      autoApply: false,
      status: "proposed",
      origin: "learned",
      rank: input.rank ?? 100,
      predicate: input.predicate,
      action: input.action,
      proposedFromTxnId: input.proposedFromTxnId ?? null,
    })
    .returning();
  return row;
}
