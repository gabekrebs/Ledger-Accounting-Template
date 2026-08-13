"use server";

import { revalidatePath } from "next/cache";
import { assertEntityAccess, assertEntityWrite } from "@/lib/ledger/access";
import { logAudit } from "@/lib/ledger/audit";
import { getCurrentUser } from "@/lib/supabase/auth-server";
import {
  getEditableTransaction,
  editTransaction,
  revertTransaction,
  type EditableTransaction,
  type LineEdit,
} from "@/lib/ledger/edit-transaction";
import { listPostableAccounts } from "@/lib/plaid/data";

/** A category option for the edit panel's account picker. */
export interface CategoryOption {
  id: string;
  label: string;
  classification: string;
}

/**
 * Load one transaction for editing, plus the entity's postable accounts for the
 * category picker. Entity-scoped (404s for users without access).
 */
export async function loadTransactionForEdit(
  entityId: string,
  entryId: string
): Promise<{ txn: EditableTransaction | null; accounts: CategoryOption[] }> {
  await assertEntityAccess(entityId);
  const [txn, accounts] = await Promise.all([
    getEditableTransaction(entityId, entryId),
    listPostableAccounts(entityId),
  ]);
  return {
    txn,
    accounts: accounts.map((a) => ({
      id: a.id,
      label: a.fullyQualifiedName ?? a.name,
      classification: a.classification,
    })),
  };
}

/**
 * Apply an edit (recategorize lines and/or fix payee/memo/date). Revalidates
 * every surface a transaction touches so the corrected figure shows everywhere.
 */
export async function saveTransactionEdit(input: {
  entityId: string;
  entryId: string;
  name?: string | null;
  memo?: string | null;
  txnDate?: string;
  lines?: LineEdit[];
}): Promise<{ ok: boolean; changed?: number; error?: string }> {
  await assertEntityWrite(input.entityId);
  const user = await getCurrentUser();
  try {
    const { changed } = await editTransaction({
      ...input,
      editedBy: user?.email ?? null,
    });
    await logAudit({
      entityId: input.entityId,
      actionType: "edit_transaction",
      objectTable: "bk_journal_entries",
      objectId: input.entryId,
      description: `Edited a transaction (${changed} line(s)/field(s) changed)`,
      after: {
        name: input.name ?? undefined,
        memo: input.memo ?? undefined,
        txnDate: input.txnDate,
        lineEdits: input.lines?.length ?? 0,
      },
      affectedLedger: true,
    });
    revalidateEntity(input.entityId);
    return { ok: true, changed };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Revert a transaction to its original (pre-edit) state. */
export async function revertTransactionEdit(input: {
  entityId: string;
  entryId: string;
}): Promise<{ ok: boolean; reverted?: boolean; error?: string }> {
  await assertEntityWrite(input.entityId);
  try {
    const { reverted } = await revertTransaction(input.entityId, input.entryId);
    if (reverted) {
      await logAudit({
        entityId: input.entityId,
        actionType: "revert_transaction_edit",
        objectTable: "bk_journal_entries",
        objectId: input.entryId,
        description: "Reverted a transaction to its pre-edit state",
        affectedLedger: true,
      });
    }
    revalidateEntity(input.entityId);
    return { ok: true, reverted };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Refresh every ledger view whose numbers an edit can move. */
function revalidateEntity(entityId: string) {
  const base = `/ledger/${entityId}`;
  for (const p of ["", "/pl", "/pl/detail", "/transactions", "/bs", "/by-address"]) {
    revalidatePath(`${base}${p}`);
  }
  // GL pages are per-account; revalidate the segment layout to catch any.
  revalidatePath(`${base}/gl/[accountId]`, "page");
}

