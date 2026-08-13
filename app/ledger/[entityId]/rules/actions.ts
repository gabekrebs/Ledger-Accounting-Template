"use server";

import { revalidatePath } from "next/cache";
import {
  assertEntityAccess,
  assertEntityWrite,
  assertOwner,
  currentUserIsAdmin,
} from "@/lib/ledger/access";
import { logAudit } from "@/lib/ledger/audit";
import { limitAction } from "@/lib/security/rate-limit";
import { actionIdentity } from "@/lib/security/rate-limit-identity";
import { getCurrentUser } from "@/lib/supabase/auth-server";
import {
  saveRule,
  previewPayload,
  setRuleFlag,
  applyRuleToPending,
  applyRuleRetroactive,
  type RulePayload,
} from "@/lib/rules/admin";
import { getRule } from "@/lib/rules/store";
import { assertRuleMutable } from "@/lib/rules/authz";
import { proposeRulesFromAI, draftRuleFromNL, type NLDraft } from "@/lib/rules/ai-author";
import type { PreviewResult } from "@/lib/rules/preview";

async function actor(): Promise<string | null> {
  return (await getCurrentUser())?.email ?? null;
}

/** Create or update an ENTITY rule (scope='entity'). */
export async function saveEntityRule(
  entityId: string,
  payload: RulePayload
): Promise<{ ok: boolean; error?: string; ruleId?: string }> {
  await assertEntityWrite(entityId);
  try {
    // Edits to an inherited GLOBAL rule are admin-only and never re-scoped here.
    if (payload.ruleId) {
      const existing = await getRule(payload.ruleId);
      if (!existing) return { ok: false, error: "rule not found" };
      // Bind the rule to the authorized entity: an entity rule must belong to
      // entityId; a global rule may only be edited by an admin. Without this a
      // user authorized for A could rewrite another entity's rule by id.
      assertRuleMutable(
        existing,
        entityId,
        existing.scope === "global" ? await currentUserIsAdmin() : false
      );
      const scope = existing.scope as "global" | "entity";
      const { ruleId } = await saveRule(payload, scope, existing.entityId, await actor());
      await logAudit({
        entityId,
        actionType: "update_rule",
        objectTable: "bk_rules",
        objectId: ruleId,
        description: `Edited a ${scope} categorization rule`,
        affectedLedger: false,
      });
      revalidatePath(`/ledger/${entityId}/rules`);
      return { ok: true, ruleId };
    }
    const { ruleId } = await saveRule(payload, "entity", entityId, await actor());
    await logAudit({
      entityId,
      actionType: "create_rule",
      objectTable: "bk_rules",
      objectId: ruleId,
      description: "Created a new entity categorization rule",
      affectedLedger: false,
    });
    revalidatePath(`/ledger/${entityId}/rules`);
    return { ok: true, ruleId };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function previewEntityRule(
  entityId: string,
  payload: RulePayload
): Promise<{ ok: boolean; error?: string; result?: PreviewResult }> {
  await assertEntityAccess(entityId);
  try {
    const result = await previewPayload(payload, "entity", entityId);
    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}


/**
 * Ask AI to author proposed rules for this entity's recurring merchants.
 * OWNER-ONLY: spends AI budget (accountants approve/dismiss proposals but
 * never trigger the model).
 */
export async function aiProposeRules(
  entityId: string
): Promise<{ ok: boolean; error?: string; proposed?: number }> {
  await assertOwner();
  await assertEntityAccess(entityId); // 404 on an unknown entity id
  const rl = await limitAction("ai", await actionIdentity());
  if (rl) return rl;
  const r = await proposeRulesFromAI(entityId);
  if (r.error) return { ok: false, error: r.error };
  if ((r.proposed ?? 0) > 0) {
    await logAudit({
      entityId,
      actionType: "ai_propose_rules",
      objectTable: "bk_rules",
      objectId: null,
      description: `AI proposed ${r.proposed} new rules for review`,
      affectedLedger: false,
    });
  }
  revalidatePath(`/ledger/${entityId}/rules`);
  return { ok: true, proposed: r.proposed };
}

/**
 * Draft a rule from a natural-language phrase (returns a draft; writes
 * nothing). OWNER-ONLY: spends AI budget.
 */
export async function nlDraftRule(
  entityId: string,
  phrase: string
): Promise<{ ok: boolean; error?: string; draft?: NLDraft }> {
  await assertOwner();
  await assertEntityAccess(entityId); // 404 on an unknown entity id
  const rl = await limitAction("ai", await actionIdentity());
  if (rl) return rl;
  const r = await draftRuleFromNL(entityId, phrase);
  if (r.error || !r.draft) return { ok: false, error: r.error ?? "no draft" };
  return { ok: true, draft: r.draft };
}

/** Approve a proposed rule → active + enabled (audited). */
export async function approveRule(
  entityId: string,
  ruleId: string
): Promise<{ ok: boolean; error?: string }> {
  await assertEntityWrite(entityId);
  try {
    const existing = await getRule(ruleId);
    if (!existing) return { ok: false, error: "rule not found" };
    assertRuleMutable(
      existing,
      entityId,
      existing.scope === "global" ? await currentUserIsAdmin() : false
    );
    await setRuleFlag(ruleId, { status: "active", enabled: true }, await actor());
    await logAudit({
      entityId,
      actionType: "approve_rule",
      objectTable: "bk_rules",
      objectId: ruleId,
      description: "Approved (activated) a proposed rule",
      affectedLedger: false,
    });
    revalidatePath(`/ledger/${entityId}/rules`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Dismiss a proposed rule → archived (audited). */
export async function dismissRule(
  entityId: string,
  ruleId: string
): Promise<{ ok: boolean; error?: string }> {
  await assertEntityWrite(entityId);
  try {
    const existing = await getRule(ruleId);
    if (!existing) return { ok: false, error: "rule not found" };
    assertRuleMutable(
      existing,
      entityId,
      existing.scope === "global" ? await currentUserIsAdmin() : false
    );
    await setRuleFlag(ruleId, { status: "archived" }, await actor());
    await logAudit({
      entityId,
      actionType: "dismiss_rule",
      objectTable: "bk_rules",
      objectId: ruleId,
      description: "Dismissed (archived) a proposed rule",
      affectedLedger: false,
    });
    revalidatePath(`/ledger/${entityId}/rules`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function applyRulePending(
  entityId: string,
  ruleId: string
): Promise<{ ok: boolean; error?: string; applied?: number; errors?: number }> {
  await assertEntityWrite(entityId);
  try {
    const r = await applyRuleToPending(ruleId, entityId, await actor());
    await logAudit({
      entityId,
      actionType: "apply_rule_pending",
      objectTable: "bk_rules",
      objectId: ruleId,
      description: `Applied a rule to ${r.applied ?? 0} pending transactions`,
      affectedLedger: true,
    });
    revalidatePath(`/ledger/${entityId}/rules`);
    revalidatePath(`/ledger/${entityId}/bank`);
    return { ok: true, ...r };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function applyRuleRetro(
  entityId: string,
  ruleId: string
): Promise<{
  ok: boolean;
  error?: string;
  updated?: number;
  refused?: number;
  skipped?: number;
}> {
  await assertEntityWrite(entityId);
  try {
    const r = await applyRuleRetroactive(ruleId, entityId, await actor());
    await logAudit({
      entityId,
      actionType: "apply_rule_retroactive",
      objectTable: "bk_rules",
      objectId: ruleId,
      description: `Retroactively recategorized ${r.updated ?? 0} posted transactions`,
      affectedLedger: true,
    });
    revalidatePath(`/ledger/${entityId}/rules`);
    revalidatePath(`/ledger/${entityId}`);
    return { ok: true, ...r };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
