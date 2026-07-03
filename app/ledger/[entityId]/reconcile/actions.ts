"use server";

import { revalidatePath } from "next/cache";
import { assertEntityAccess } from "@/lib/ledger/access";
import { getCurrentUser } from "@/lib/supabase/auth-server";
import {
  startReconciliation,
  setLinesCleared,
  finishReconciliation,
  cancelReconciliation,
  undoLastReconciliation,
} from "@/lib/ledger/reconcile";

/** Server actions for the bank-reconciliation workflow. */

export async function startReconciliationAction(input: {
  entityId: string;
  accountId: string;
  statementDate: string;
  statementBalanceCents: number;
}): Promise<{ ok: boolean; reconciliationId?: string; error?: string }> {
  await assertEntityAccess(input.entityId);
  const user = await getCurrentUser();
  try {
    const { reconciliationId } = await startReconciliation({
      ...input,
      createdBy: user?.email ?? null,
    });
    revalidateRec(input.entityId);
    return { ok: true, reconciliationId };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function setLinesClearedAction(input: {
  entityId: string;
  reconciliationId: string;
  lineIds: string[];
  cleared: boolean;
}): Promise<{ ok: boolean; updated?: number; error?: string }> {
  await assertEntityAccess(input.entityId);
  try {
    const { updated } = await setLinesCleared(input);
    return { ok: true, updated };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function finishReconciliationAction(input: {
  entityId: string;
  reconciliationId: string;
}): Promise<{ ok: boolean; error?: string }> {
  await assertEntityAccess(input.entityId);
  try {
    await finishReconciliation(input.entityId, input.reconciliationId);
    revalidateRec(input.entityId);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function cancelReconciliationAction(input: {
  entityId: string;
  reconciliationId: string;
}): Promise<{ ok: boolean; error?: string }> {
  await assertEntityAccess(input.entityId);
  try {
    await cancelReconciliation(input.entityId, input.reconciliationId);
    revalidateRec(input.entityId);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function undoLastReconciliationAction(input: {
  entityId: string;
  accountId: string;
}): Promise<{ ok: boolean; error?: string }> {
  await assertEntityAccess(input.entityId);
  try {
    await undoLastReconciliation(input.entityId, input.accountId);
    revalidateRec(input.entityId);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function revalidateRec(entityId: string) {
  const base = `/ledger/${entityId}`;
  revalidatePath(`${base}/reconcile/[accountId]`, "page");
  revalidatePath(`${base}/gl/[accountId]`, "page");
  revalidatePath(`${base}/accounts`);
}
