"use server";

import { revalidatePath } from "next/cache";
import { assertAdmin } from "@/lib/ledger/access";
import { getCurrentUser } from "@/lib/supabase/auth-server";
import {
  saveRule,
  previewPayload,
  setRuleFlag,
  type RulePayload,
} from "@/lib/rules/admin";
import type { PreviewResult } from "@/lib/rules/preview";

async function actor(): Promise<string | null> {
  return (await getCurrentUser())?.email ?? null;
}

/** Create or update a GLOBAL rule (admin-only; targets canonical keys). */
export async function saveGlobalRule(
  payload: RulePayload
): Promise<{ ok: boolean; error?: string; ruleId?: string }> {
  await assertAdmin();
  try {
    const { ruleId } = await saveRule(payload, "global", null, await actor());
    revalidatePath("/ledger/rules");
    return { ok: true, ruleId };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function previewGlobalRule(
  payload: RulePayload,
  previewEntityId?: string
): Promise<{ ok: boolean; error?: string; result?: PreviewResult }> {
  await assertAdmin();
  if (!previewEntityId) return { ok: false, error: "pick an entity to preview against" };
  try {
    const result = await previewPayload(payload, "global", previewEntityId);
    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Approve a proposed global rule → active + enabled (admin only). */
export async function approveGlobalRule(
  ruleId: string
): Promise<{ ok: boolean; error?: string }> {
  await assertAdmin();
  try {
    await setRuleFlag(ruleId, { status: "active", enabled: true }, await actor());
    revalidatePath("/ledger/rules");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Dismiss a proposed global rule → archived (admin only). */
export async function dismissGlobalRule(
  ruleId: string
): Promise<{ ok: boolean; error?: string }> {
  await assertAdmin();
  try {
    await setRuleFlag(ruleId, { status: "archived" }, await actor());
    revalidatePath("/ledger/rules");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function toggleGlobalRule(
  ruleId: string,
  patch: { enabled?: boolean; autoApply?: boolean; status?: "active" | "archived" }
): Promise<{ ok: boolean; error?: string }> {
  await assertAdmin();
  try {
    await setRuleFlag(ruleId, patch, await actor());
    revalidatePath("/ledger/rules");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
