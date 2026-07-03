"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { assertEntityAccess } from "@/lib/ledger/access";
import { getCurrentUser } from "@/lib/supabase/auth-server";
import { db } from "@/lib/db/client";
import { bkLedgerEntities } from "@/lib/db/schema";
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
  await assertEntityAccess(input.entityId);
  const user = await getCurrentUser();
  try {
    const { changed } = await editTransaction({
      ...input,
      editedBy: user?.email ?? null,
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
  await assertEntityAccess(input.entityId);
  try {
    const { reverted } = await revertTransaction(input.entityId, input.entryId);
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

/**
 * Set (or clear) an entity's formation date. Drives the capital "initial vs
 * capital call" split: contributions in the formation fiscal year are initial,
 * later ones are capital calls. Clearing it falls back to the earliest journal
 * txn. Per-entity, UI-editable — no hardcoded dates anywhere (multi-tenant).
 */
export async function setFormationDate(formData: FormData) {
  const entityId = String(formData.get("entityId"));
  await assertEntityAccess(entityId);
  const raw = String(formData.get("formationDate") ?? "").trim();
  const formationDate = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
  await db
    .update(bkLedgerEntities)
    .set({ formationDate })
    .where(eq(bkLedgerEntities.id, entityId));
  revalidatePath(`/ledger/${entityId}`);
}
