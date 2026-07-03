"use server";

import { revalidatePath } from "next/cache";
import { assertEntityAccess } from "@/lib/ledger/access";
import {
  createAccount,
  updateAccount,
  setAccountActive,
  setAccountActivity,
  bulkSetAccountActivity,
  getEntityActivities,
} from "@/lib/ledger/manage-accounts";

/** Server actions for chart-of-accounts management (Accounts tab). */

export async function createAccountAction(input: {
  entityId: string;
  name: string;
  accountType: string;
  parentId?: string | null;
}): Promise<{ ok: boolean; accountId?: string; error?: string }> {
  await assertEntityAccess(input.entityId);
  try {
    const { accountId } = await createAccount(input);
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
  await assertEntityAccess(input.entityId);
  try {
    await updateAccount(input);
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
  await assertEntityAccess(input.entityId);
  try {
    await setAccountActive(input);
    revalidateAccounts(input.entityId);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function setAccountActivityAction(input: {
  entityId: string;
  accountId: string;
  activity: string;
}): Promise<{ ok: boolean; error?: string }> {
  await assertEntityAccess(input.entityId);
  try {
    await setAccountActivity(input);
    revalidateAccounts(input.entityId);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function bulkSetAccountActivityAction(input: {
  entityId: string;
  accountIds: string[];
  activity: string;
}): Promise<{ ok: boolean; updated?: number; error?: string }> {
  await assertEntityAccess(input.entityId);
  try {
    const updated = await bulkSetAccountActivity(input);
    revalidateAccounts(input.entityId);
    return { ok: true, updated };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function getEntityActivitiesAction(
  entityId: string
): Promise<string[]> {
  await assertEntityAccess(entityId);
  return getEntityActivities(entityId);
}

/** A chart change moves every report that groups by account. */
function revalidateAccounts(entityId: string) {
  const base = `/ledger/${entityId}`;
  for (const p of ["", "/accounts", "/pl", "/pl/detail", "/bs", "/transactions", "/by-address"]) {
    revalidatePath(`${base}${p}`);
  }
  revalidatePath(`${base}/gl/[accountId]`, "page");
}
