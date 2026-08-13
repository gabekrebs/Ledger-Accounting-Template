import crypto from "crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { bkAppUsers, bkEntityAccess, bkLedgerEntities } from "@/lib/db/schema";
import { getServerSupabase } from "@/lib/supabase/server";
import { isEnvAdmin } from "@/lib/ledger/access";

/**
 * In-product user management (the data layer behind /ledger/users and the
 * per-entity Access tab). A "user" is one `bk_app_users` row + a Supabase auth
 * account (admin-provisioned email+password — no SMTP, no invite email; temp
 * passwords are returned ONCE to the admin who created them and never stored).
 *
 * The shared Supabase project's `auth.users` spans other apps on the shared Supabase project, so an email
 * may already have a login from another app — in that case we reuse it (no
 * password is generated) and removal here never deletes the auth account.
 */

// 'owner' is the admin/account owner; 'accountant' and 'business_partner' are
// the per-entity collaborator classifications. 'admin'/'member' are legacy
// values kept valid for back-compat (owner ≡ admin for capability).
export type AppRole =
  | "owner"
  | "accountant"
  | "business_partner"
  | "admin"
  | "member";

/** Per-entity capability granted to a collaborator. */
export type EntityAccessLevel = "read" | "write";

export type AppUserWithGrants = {
  id: string;
  email: string;
  displayName: string | null;
  role: AppRole;
  active: boolean;
  createdAt: Date | null;
  createdBy: string | null;
  entities: { id: string; name: string | null; accessLevel: EntityAccessLevel }[];
};

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function tempPassword(): string {
  // 18 url-safe chars — strong, easy to copy. Same shape as provision-users.mts.
  return crypto.randomBytes(14).toString("base64url");
}

/** Every managed user with their entity grants resolved to names. */
export async function listAppUsers(): Promise<AppUserWithGrants[]> {
  const [users, grants, entities] = await Promise.all([
    db.select().from(bkAppUsers).orderBy(asc(bkAppUsers.createdAt)),
    db.select().from(bkEntityAccess),
    db
      .select({ id: bkLedgerEntities.id, name: bkLedgerEntities.name })
      .from(bkLedgerEntities),
  ]);
  const entityById = new Map(entities.map((e) => [e.id, e]));
  return users.map((u) => ({
    id: u.id,
    email: u.email,
    displayName: u.displayName,
    role: (u.role ?? "business_partner") as AppRole,
    active: u.active,
    createdAt: u.createdAt,
    createdBy: u.createdBy,
    entities: grants
      .filter((g) => g.userEmail === u.email)
      .map((g) => {
        const e = entityById.get(g.entityId);
        return e
          ? {
              id: e.id,
              name: e.name,
              accessLevel: (g.accessLevel === "write" ? "write" : "read") as EntityAccessLevel,
            }
          : null;
      })
      .filter((e): e is { id: string; name: string | null; accessLevel: EntityAccessLevel } => !!e)
      .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "")),
  }));
}

/** Emails granted access to one entity (managed members only — admins are implicit). */
export async function listEntityGrants(
  entityId: string
): Promise<{ email: string; displayName: string | null; active: boolean }[]> {
  const rows = await db
    .select({ email: bkEntityAccess.userEmail })
    .from(bkEntityAccess)
    .where(eq(bkEntityAccess.entityId, entityId));
  if (rows.length === 0) return [];
  const users = await db
    .select()
    .from(bkAppUsers)
    .where(inArray(bkAppUsers.email, rows.map((r) => r.email)));
  const byEmail = new Map(users.map((u) => [u.email, u]));
  return rows
    .map((r) => ({
      email: r.email,
      displayName: byEmail.get(r.email)?.displayName ?? null,
      active: byEmail.get(r.email)?.active ?? true, // legacy env-era grants have no row
    }))
    .sort((a, b) => a.email.localeCompare(b.email));
}

/** Find the Supabase auth user id for an email (paged scan — small user set). */
async function findAuthUserId(email: string): Promise<string | null> {
  const admin = getServerSupabase();
  for (let page = 1; page <= 10; page++) {
    const { data, error } = await admin.auth.admin.listUsers({
      page,
      perPage: 200,
    });
    if (error) throw new Error(`Could not list auth users: ${error.message}`);
    const hit = data.users.find((u) => u.email?.toLowerCase() === email);
    if (hit) return hit.id;
    if (data.users.length < 200) break;
  }
  return null;
}

/**
 * Create a managed user: bk_app_users row + Supabase auth account + entity
 * grants. Returns the one-time temp password for a NEW auth account; null when
 * the email already had a login (from this app or a sibling app).
 */
export async function createAppUser(input: {
  email: string;
  displayName?: string | null;
  role: AppRole;
  entityGrants: { entityId: string; accessLevel: EntityAccessLevel }[];
  createdBy: string | null;
}): Promise<{ tempPassword: string | null; reusedExistingLogin: boolean }> {
  const email = normalizeEmail(input.email);
  if (!isValidEmail(email)) throw new Error("Enter a valid email address.");

  const existing = await db
    .select({ id: bkAppUsers.id })
    .from(bkAppUsers)
    .where(eq(bkAppUsers.email, email))
    .limit(1);
  if (existing[0]) throw new Error(`${email} is already a user.`);

  // Provision the login first — if Supabase rejects, no orphan row is left.
  const admin = getServerSupabase();
  const password = tempPassword();
  let reusedExistingLogin = false;
  const { error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error) {
    if (/already|exists|registered/i.test(error.message)) {
      reusedExistingLogin = true; // shared auth.users — login exists, leave it be
    } else {
      throw new Error(`Could not create the login: ${error.message}`);
    }
  }

  // Split the entered name so first_name is populated for greetings etc. — the
  // first word is the first name, the remainder the last name. Email is never
  // used as a name source.
  const displayName = input.displayName?.trim() || null;
  const nameParts = displayName ? displayName.split(/\s+/) : [];
  await db.insert(bkAppUsers).values({
    email,
    displayName,
    firstName: nameParts[0] ?? null,
    lastName: nameParts.length > 1 ? nameParts.slice(1).join(" ") : null,
    role: input.role,
    createdBy: input.createdBy,
  });

  // Owner/admin see everything (no per-entity rows); collaborators get exactly
  // the granted entities at their chosen level.
  const isOwnerRole = input.role === "owner" || input.role === "admin";
  if (!isOwnerRole && input.entityGrants.length > 0) {
    await db
      .insert(bkEntityAccess)
      .values(
        input.entityGrants.map((g) => ({
          userEmail: email,
          entityId: g.entityId,
          accessLevel: g.accessLevel,
        }))
      )
      .onConflictDoUpdate({
        target: [bkEntityAccess.userEmail, bkEntityAccess.entityId],
        set: { accessLevel: sql`excluded.access_level` },
      });
  }

  return { tempPassword: reusedExistingLogin ? null : password, reusedExistingLogin };
}

/**
 * Replace a user's ENTIRE set of entity grants with the given levels: entities
 * not in the list are revoked, the rest are upserted at their level. The single
 * write path the Users screen's "Save access" uses.
 */
export async function setUserEntityLevels(
  userId: string,
  grants: { entityId: string; accessLevel: EntityAccessLevel }[]
): Promise<void> {
  const user = await db
    .select({ email: bkAppUsers.email })
    .from(bkAppUsers)
    .where(eq(bkAppUsers.id, userId))
    .limit(1);
  if (!user[0]) throw new Error("User not found.");
  const email = user[0].email;

  const want = new Set(grants.map((g) => g.entityId));
  const current = await db
    .select({ entityId: bkEntityAccess.entityId })
    .from(bkEntityAccess)
    .where(eq(bkEntityAccess.userEmail, email));
  const toRemove = current.map((r) => r.entityId).filter((id) => !want.has(id));

  if (grants.length > 0) {
    await db
      .insert(bkEntityAccess)
      .values(
        grants.map((g) => ({
          userEmail: email,
          entityId: g.entityId,
          accessLevel: g.accessLevel,
        }))
      )
      .onConflictDoUpdate({
        target: [bkEntityAccess.userEmail, bkEntityAccess.entityId],
        set: { accessLevel: sql`excluded.access_level` },
      });
  }
  if (toRemove.length > 0) {
    await db
      .delete(bkEntityAccess)
      .where(
        and(
          eq(bkEntityAccess.userEmail, email),
          inArray(bkEntityAccess.entityId, toRemove)
        )
      );
  }
}

/** The target user's CURRENT role — lets the action layer refuse touching owner-tier rows. */
export async function getUserRole(userId: string): Promise<AppRole | null> {
  const [row] = await db
    .select({ role: bkAppUsers.role })
    .from(bkAppUsers)
    .where(eq(bkAppUsers.id, userId))
    .limit(1);
  return (row?.role as AppRole) ?? null;
}

export async function setUserRole(userId: string, role: AppRole): Promise<void> {
  await db.update(bkAppUsers).set({ role }).where(eq(bkAppUsers.id, userId));
}

export async function setUserActive(
  userId: string,
  active: boolean
): Promise<void> {
  await db.update(bkAppUsers).set({ active }).where(eq(bkAppUsers.id, userId));
}


/**
 * Grant one entity to an email at a given access level (read | write). Upserts:
 * re-granting an existing entity UPDATES the level, so the Access tab can promote
 * read → write (or demote) without a revoke/re-grant round-trip.
 */
export async function grantEntity(
  email: string,
  entityId: string,
  accessLevel: EntityAccessLevel = "read"
): Promise<void> {
  await db
    .insert(bkEntityAccess)
    .values({ userEmail: normalizeEmail(email), entityId, accessLevel })
    .onConflictDoUpdate({
      target: [bkEntityAccess.userEmail, bkEntityAccess.entityId],
      set: { accessLevel },
    });
}

/** Revoke one entity from an email. */
export async function revokeEntity(
  email: string,
  entityId: string
): Promise<void> {
  await db
    .delete(bkEntityAccess)
    .where(
      and(
        eq(bkEntityAccess.userEmail, normalizeEmail(email)),
        eq(bkEntityAccess.entityId, entityId)
      )
    );
}

/** Issue a fresh temp password (returned once, never stored). */
export async function resetUserPassword(userId: string): Promise<string> {
  const user = await db
    .select({ email: bkAppUsers.email })
    .from(bkAppUsers)
    .where(eq(bkAppUsers.id, userId))
    .limit(1);
  if (!user[0]) throw new Error("User not found.");
  const authId = await findAuthUserId(user[0].email);
  if (!authId) throw new Error("No login exists for this email.");
  const password = tempPassword();
  const admin = getServerSupabase();
  const { error } = await admin.auth.admin.updateUserById(authId, { password });
  if (error) throw new Error(`Could not reset the password: ${error.message}`);
  return password;
}

/**
 * Remove a managed user: deletes the row + all entity grants. The Supabase
 * auth account is left alone (shared across apps) — without an allowlist
 * entry it can no longer sign in here. Env-listed admins can't be removed.
 */
export async function removeUser(userId: string): Promise<void> {
  const user = await db
    .select({ email: bkAppUsers.email })
    .from(bkAppUsers)
    .where(eq(bkAppUsers.id, userId))
    .limit(1);
  if (!user[0]) return;
  if (isEnvAdmin(user[0].email)) {
    throw new Error(
      "This email is an environment-configured admin — remove it from AUTH_ADMIN_EMAILS instead."
    );
  }
  await db
    .delete(bkEntityAccess)
    .where(eq(bkEntityAccess.userEmail, user[0].email));
  await db.delete(bkAppUsers).where(eq(bkAppUsers.id, userId));
}
