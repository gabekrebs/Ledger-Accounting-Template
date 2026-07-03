"use server";

import { revalidatePath } from "next/cache";
import { assertAdmin } from "@/lib/ledger/access";
import { getCurrentUser } from "@/lib/supabase/auth-server";
import {
  createAppUser,
  grantEntity,
  removeUser,
  resetUserPassword,
  revokeEntity,
  setUserActive,
  setUserEntities,
  setUserRole,
  type AppRole,
} from "@/lib/ledger/users";

/**
 * Admin-only mutations for user management. Every action re-asserts admin on
 * the server (the UI hiding a button is not authorization). Results carry the
 * one-time temp password back to the admin's browser when one was generated —
 * it is never logged or stored.
 */

export type UserActionResult = {
  ok: boolean;
  error?: string;
  tempPassword?: string;
  reusedExistingLogin?: boolean;
};

function fail(e: unknown): UserActionResult {
  return { ok: false, error: e instanceof Error ? e.message : String(e) };
}

function revalidate(entityId?: string) {
  revalidatePath("/ledger/users");
  if (entityId) revalidatePath(`/ledger/${entityId}/access`);
}

export async function createUserAction(input: {
  email: string;
  displayName: string;
  role: AppRole;
  entityIds: string[];
  /** When invoked from an entity Access tab — revalidates that page too. */
  fromEntityId?: string;
}): Promise<UserActionResult> {
  await assertAdmin();
  try {
    const me = await getCurrentUser();
    const { tempPassword, reusedExistingLogin } = await createAppUser({
      email: input.email,
      displayName: input.displayName,
      role: input.role,
      entityIds: input.entityIds,
      createdBy: me?.email?.toLowerCase() ?? null,
    });
    revalidate(input.fromEntityId);
    return {
      ok: true,
      tempPassword: tempPassword ?? undefined,
      reusedExistingLogin,
    };
  } catch (e) {
    return fail(e);
  }
}

export async function setRoleAction(
  userId: string,
  role: AppRole
): Promise<UserActionResult> {
  await assertAdmin();
  try {
    await setUserRole(userId, role);
    revalidate();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function setActiveAction(
  userId: string,
  active: boolean,
  email: string
): Promise<UserActionResult> {
  await assertAdmin();
  try {
    const me = await getCurrentUser();
    if (!active && me?.email?.toLowerCase() === email.toLowerCase()) {
      return { ok: false, error: "You can't deactivate your own account." };
    }
    await setUserActive(userId, active);
    revalidate();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function setEntitiesAction(
  userId: string,
  entityIds: string[]
): Promise<UserActionResult> {
  await assertAdmin();
  try {
    await setUserEntities(userId, entityIds);
    revalidate();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function resetPasswordAction(
  userId: string
): Promise<UserActionResult> {
  await assertAdmin();
  try {
    const tempPassword = await resetUserPassword(userId);
    return { ok: true, tempPassword };
  } catch (e) {
    return fail(e);
  }
}

export async function removeUserAction(
  userId: string,
  email: string
): Promise<UserActionResult> {
  await assertAdmin();
  try {
    const me = await getCurrentUser();
    if (me?.email?.toLowerCase() === email.toLowerCase()) {
      return { ok: false, error: "You can't remove your own account." };
    }
    await removeUser(userId);
    revalidate();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function grantEntityAction(
  email: string,
  entityId: string
): Promise<UserActionResult> {
  await assertAdmin();
  try {
    await grantEntity(email, entityId);
    revalidate(entityId);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function revokeEntityAction(
  email: string,
  entityId: string
): Promise<UserActionResult> {
  await assertAdmin();
  try {
    await revokeEntity(email, entityId);
    revalidate(entityId);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}
