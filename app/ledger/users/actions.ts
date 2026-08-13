"use server";

import { revalidatePath } from "next/cache";
import { assertAdmin } from "@/lib/ledger/access";
import { getCurrentUser } from "@/lib/supabase/auth-server";
import {
  createAppUser,
  getUserRole,
  grantEntity,
  removeUser,
  resetUserPassword,
  revokeEntity,
  setUserActive,
  setUserEntityLevels,
  setUserRole,
  type AppRole,
  type EntityAccessLevel,
} from "@/lib/ledger/users";

type EntityGrant = { entityId: string; accessLevel: EntityAccessLevel };

/**
 * The only roles a BROWSER action may assign. Owner-tier roles ('owner',
 * legacy 'admin') and the legacy 'member' value are rejected server-side even
 * though the UI never offers them — a compromised admin session must not be
 * able to mint another all-access user. Owner-tier accounts are provisioned
 * out-of-band only (env AUTH_ADMIN_EMAILS / scripts/provision-users.mts).
 */
const ASSIGNABLE_ROLES: readonly AppRole[] = [
  "accountant",
  "business_partner",
];

function assertAssignableRole(role: AppRole): void {
  if (!ASSIGNABLE_ROLES.includes(role)) {
    throw new Error("That role can't be assigned from the app.");
  }
}

function isOwnerTier(role: AppRole | null): boolean {
  return role === "owner" || role === "admin";
}

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
  entityGrants: EntityGrant[];
  /** When invoked from an entity Access tab — revalidates that page too. */
  fromEntityId?: string;
}): Promise<UserActionResult> {
  await assertAdmin();
  try {
    assertAssignableRole(input.role);
    const me = await getCurrentUser();
    const { tempPassword, reusedExistingLogin } = await createAppUser({
      email: input.email,
      displayName: input.displayName,
      role: input.role,
      entityGrants: input.entityGrants,
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
    assertAssignableRole(role);
    // Owner-tier rows are immutable from the browser in BOTH directions: no
    // action may grant that tier (above) and none may demote it either.
    if (isOwnerTier(await getUserRole(userId))) {
      return { ok: false, error: "The owner account's role can't be changed here." };
    }
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


/** Replace a user's whole per-entity access map with explicit read/write levels. */
export async function setEntityLevelsAction(
  userId: string,
  grants: EntityGrant[]
): Promise<UserActionResult> {
  await assertAdmin();
  try {
    await setUserEntityLevels(userId, grants);
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
  entityId: string,
  accessLevel: EntityAccessLevel = "read"
): Promise<UserActionResult> {
  await assertAdmin();
  try {
    await grantEntity(email, entityId, accessLevel);
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
