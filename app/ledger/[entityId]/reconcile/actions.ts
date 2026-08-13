"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db, schema } from "@/lib/db/client";
import { assertEntityWrite } from "@/lib/ledger/access";
import { logAudit } from "@/lib/ledger/audit";
import { usd } from "@/lib/ledger/format";
import { getCurrentUser } from "@/lib/supabase/auth-server";
import {
  startReconciliation,
  setLinesCleared,
  finishReconciliation,
  cancelReconciliation,
  undoLastReconciliation,
} from "@/lib/ledger/reconcile";

/** Server actions for the bank-reconciliation workflow. */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Record a manual balance checkpoint for the Reconciliation view: "the real
 * statement/portal showed `actualBalanceCents` (NATURAL sign — a loan's balance
 * owed is positive) as of `asOfDate`". Append-only INSERT into
 * `bk_account_recon`; the view reads the latest as_of_date row per account.
 * Never touches the journal — this is an observation, not a posting.
 */
export async function saveManualRecon(
  entityId: string,
  accountQboId: string,
  asOfDate: string,
  actualBalanceCents: number,
  note?: string
): Promise<{ ok: boolean; error?: string }> {
  await assertEntityWrite(entityId);
  const user = await getCurrentUser();
  try {
    if (!ISO_DATE.test(asOfDate)) throw new Error("invalid as-of date");
    if (!Number.isInteger(actualBalanceCents)) {
      throw new Error("balance must be integer cents");
    }
    // The GL key must belong to THIS entity — an unchecked accountQboId would
    // let a checkpoint be filed against another entity's account.
    const { bkAccounts, bkAccountRecon } = schema;
    const [acct] = await db
      .select({ name: bkAccounts.name })
      .from(bkAccounts)
      .where(
        and(
          eq(bkAccounts.entityId, entityId),
          eq(bkAccounts.qboAccountId, accountQboId)
        )
      );
    if (!acct) throw new Error("account not found for this entity");

    const [row] = await db
      .insert(bkAccountRecon)
      .values({
        entityId,
        accountQboId,
        asOfDate,
        actualBalanceCents,
        note: note?.trim() || null,
        createdBy: user?.email ?? null,
      })
      .returning({ id: bkAccountRecon.id });
    await logAudit({
      entityId,
      actionType: "save_manual_recon",
      objectTable: "bk_account_recon",
      objectId: row.id,
      description: `Recorded ${acct.name} actual balance ${usd(actualBalanceCents)} as of ${asOfDate}`,
      affectedLedger: false,
    });
    revalidatePath(`/ledger/${entityId}/reconcile`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function startReconciliationAction(input: {
  entityId: string;
  accountId: string;
  statementDate: string;
  statementBalanceCents: number;
}): Promise<{ ok: boolean; reconciliationId?: string; error?: string }> {
  await assertEntityWrite(input.entityId);
  const user = await getCurrentUser();
  try {
    const { reconciliationId } = await startReconciliation({
      ...input,
      createdBy: user?.email ?? null,
    });
    await logAudit({
      entityId: input.entityId,
      actionType: "start_reconciliation",
      objectTable: "bk_reconciliations",
      objectId: reconciliationId,
      description: `Started a reconciliation (statement ${input.statementDate})`,
      affectedLedger: false,
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
  await assertEntityWrite(input.entityId);
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
  await assertEntityWrite(input.entityId);
  try {
    await finishReconciliation(input.entityId, input.reconciliationId);
    await logAudit({
      entityId: input.entityId,
      actionType: "finish_reconciliation",
      objectTable: "bk_reconciliations",
      objectId: input.reconciliationId,
      description: "Finished (locked) a bank reconciliation",
      affectedLedger: false,
    });
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
  await assertEntityWrite(input.entityId);
  try {
    await cancelReconciliation(input.entityId, input.reconciliationId);
    await logAudit({
      entityId: input.entityId,
      actionType: "cancel_reconciliation",
      objectTable: "bk_reconciliations",
      objectId: input.reconciliationId,
      description: "Cancelled an in-progress reconciliation",
      affectedLedger: false,
    });
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
  await assertEntityWrite(input.entityId);
  try {
    await undoLastReconciliation(input.entityId, input.accountId);
    await logAudit({
      entityId: input.entityId,
      actionType: "undo_reconciliation",
      objectTable: "bk_reconciliations",
      objectId: null,
      description: "Undid the last completed reconciliation for an account",
      affectedLedger: false,
    });
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
