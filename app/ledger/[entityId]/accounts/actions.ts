"use server";

import { revalidatePath } from "next/cache";
import { assertEntityWrite } from "@/lib/ledger/access";
import { logAudit } from "@/lib/ledger/audit";
import {
  createAccount,
  updateAccount,
  setAccountActive,
  bulkSetAccountActive,
  setAccountActivity,
} from "@/lib/ledger/manage-accounts";

/** Server actions for chart-of-accounts management (Accounts tab). */

export async function createAccountAction(input: {
  entityId: string;
  name: string;
  accountType: string;
  parentId?: string | null;
}): Promise<{ ok: boolean; accountId?: string; error?: string }> {
  await assertEntityWrite(input.entityId);
  try {
    const { accountId } = await createAccount(input);
    await logAudit({
      entityId: input.entityId,
      actionType: "create_account",
      objectTable: "bk_accounts",
      objectId: accountId,
      description: `Created account "${input.name}" (${input.accountType})`,
      after: { name: input.name, accountType: input.accountType },
    });
    revalidateAccounts(input.entityId);
    return { ok: true, accountId };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function updateAccountAction(input: {
  entityId: string;
  accountId: string;
  name?: string;
  accountType?: string;
}): Promise<{ ok: boolean; error?: string }> {
  await assertEntityWrite(input.entityId);
  try {
    await updateAccount(input);
    await logAudit({
      entityId: input.entityId,
      actionType: "update_account",
      objectTable: "bk_accounts",
      objectId: input.accountId,
      description: `Updated an account${input.name ? ` (renamed to "${input.name}")` : ""}`,
      after: { name: input.name, accountType: input.accountType },
    });
    revalidateAccounts(input.entityId);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function setAccountActiveAction(input: {
  entityId: string;
  accountId: string;
  active: boolean;
}): Promise<{ ok: boolean; error?: string }> {
  await assertEntityWrite(input.entityId);
  try {
    await setAccountActive(input);
    await logAudit({
      entityId: input.entityId,
      actionType: "set_account_active",
      objectTable: "bk_accounts",
      objectId: input.accountId,
      description: `Marked an account ${input.active ? "active" : "inactive"}`,
      after: { active: input.active },
    });
    revalidateAccounts(input.entityId);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function bulkArchiveAccountsAction(input: {
  entityId: string;
  accountIds: string[];
}): Promise<{ ok: boolean; archived?: number; failed?: number; error?: string }> {
  await assertEntityWrite(input.entityId);
  try {
    const { changed, failed } = await bulkSetAccountActive({
      entityId: input.entityId,
      accountIds: input.accountIds,
      active: false,
    });
    await logAudit({
      entityId: input.entityId,
      actionType: "bulk_archive_accounts",
      objectTable: "bk_accounts",
      objectId: null,
      description: `Archived ${changed} account(s)${failed.length ? `, ${failed.length} skipped` : ""}`,
      after: { archived: changed, failed: failed.length },
    });
    revalidateAccounts(input.entityId);
    return { ok: true, archived: changed, failed: failed.length };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function setAccountActivityAction(input: {
  entityId: string;
  accountId: string;
  activity: string;
}): Promise<{ ok: boolean; error?: string }> {
  await assertEntityWrite(input.entityId);
  try {
    await setAccountActivity(input);
    await logAudit({
      entityId: input.entityId,
      actionType: "set_account_activity",
      objectTable: "bk_accounts",
      objectId: input.accountId,
      description: `Set an account's activity tag to "${input.activity}"`,
      after: { activity: input.activity },
    });
    revalidateAccounts(input.entityId);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}



/** A chart change moves every report that groups by account. */
function revalidateAccounts(entityId: string) {
  const base = `/ledger/${entityId}`;
  for (const p of ["", "/accounts", "/pl", "/pl/detail", "/bs", "/transactions", "/by-address"]) {
    revalidatePath(`${base}${p}`);
  }
  revalidatePath(`${base}/gl/[accountId]`, "page");
}
