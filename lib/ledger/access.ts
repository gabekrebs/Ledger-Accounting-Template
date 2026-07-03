import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { db } from "@/lib/db/client";
import { bkAppUsers, bkEntityAccess } from "@/lib/db/schema";
import { getCurrentUser } from "@/lib/supabase/auth-server";

/**
 * Authorization. Two layers:
 *   1. The login gate (`proxy.ts` + this module's `isEmailAllowed`) answers
 *      "may this email sign in?" — env `AUTH_ALLOWED_EMAILS` ∪ active
 *      `bk_app_users` rows.
 *   2. This layer answers "WHICH entities may they see?":
 *      - Admins (env `AUTH_ADMIN_EMAILS` ∪ active `bk_app_users` role 'admin')
 *        bypass scoping and see every entity.
 *      - Everyone else sees exactly the entities granted in `bk_entity_access`
 *        (none = nothing).
 * Users are managed in-product at /ledger/users; the env vars remain as
 * bootstrap/break-glass (an env-listed admin can never be locked out by DB
 * state). Enforce entity scoping in `app/ledger/[entityId]/layout.tsx` (covers
 * every per-entity page) and at the top of any server action / route that
 * takes an `entityId`.
 */

function envEmails(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

/** Env-var admins only — break-glass list, immune to DB state. */
export function isEnvAdmin(email: string | null | undefined): boolean {
  if (!email) return false;
  return envEmails("AUTH_ADMIN_EMAILS").includes(email.toLowerCase());
}

/** The managed `bk_app_users` row for an email, or null. */
export async function getAppUser(email: string | null | undefined) {
  if (!email) return null;
  const rows = await db
    .select()
    .from(bkAppUsers)
    .where(eq(bkAppUsers.email, email.toLowerCase()))
    .limit(1);
  return rows[0] ?? null;
}

/** Full-access check: env admin, or an ACTIVE managed user with role 'admin'. */
export async function isAdmin(email: string | null | undefined): Promise<boolean> {
  if (!email) return false;
  if (isEnvAdmin(email)) return true;
  const row = await getAppUser(email);
  return !!row && row.active && row.role === "admin";
}

/**
 * Login allowlist: env lists ∪ active managed users. A managed row that has
 * been DEACTIVATED blocks the email even if it lingers in `AUTH_ALLOWED_EMAILS`
 * (deactivation must mean "out now", not "out after a redeploy") — except env
 * ADMINS, which always pass so a bad DB row can't lock an admin out.
 */
export async function isEmailAllowed(
  email: string | null | undefined
): Promise<boolean> {
  if (!email) return false;
  if (isEnvAdmin(email)) return true;
  const row = await getAppUser(email);
  if (row) return row.active;
  return envEmails("AUTH_ALLOWED_EMAILS").includes(email.toLowerCase());
}

/** Entity ids this email may see — `"all"` for admins, else a (possibly empty) Set. */
export async function accessibleEntityIds(
  email: string | null | undefined
): Promise<Set<string> | "all"> {
  if (!email) return new Set();
  if (await isAdmin(email)) return "all";
  const row = await getAppUser(email);
  if (row && !row.active) return new Set();
  const rows = await db
    .select({ entityId: bkEntityAccess.entityId })
    .from(bkEntityAccess)
    .where(eq(bkEntityAccess.userEmail, email.toLowerCase()));
  return new Set(rows.map((r) => r.entityId));
}

export async function canAccessEntity(
  email: string | null | undefined,
  entityId: string
): Promise<boolean> {
  const ids = await accessibleEntityIds(email);
  return ids === "all" || ids.has(entityId);
}

/** True if the current signed-in user is an admin (full ledger access). */
export async function currentUserIsAdmin(): Promise<boolean> {
  const user = await getCurrentUser();
  return isAdmin(user?.email);
}

/**
 * Guard for per-entity pages, server actions, and routes. 404s (not 403) when
 * the current user lacks access, so we don't leak which entity ids exist.
 */
export async function assertEntityAccess(entityId: string): Promise<void> {
  const user = await getCurrentUser();
  if (!(await canAccessEntity(user?.email, entityId))) notFound();
}

/** Admin-only guard (connection management, user management, etc.). 404s for non-admins. */
export async function assertAdmin(): Promise<void> {
  if (!(await currentUserIsAdmin())) notFound();
}

/**
 * The single account allowed to CREATE entities — the portfolio owner.
 * Deliberately an identity check, not a role check: "admin" / all-entity access
 * means "may see and operate everything", never "may create a new business".
 * Creating an entity changes what the portfolio IS, so it stays with the owner
 * alone. A pure email comparison (case-normalized) so the policy is explicit
 * and unit-testable; roles, bk_app_users rows, and env admin lists cannot
 * widen it.
 */
// Configure this in your environment: OWNER_EMAIL=you@example.com
// (the single account permitted to create entities). If unset, entity
// creation is closed to everyone — set it during setup.
function entityCreatorEmail(): string | null {
  const e = process.env.OWNER_EMAIL?.trim().toLowerCase();
  return e && e.length ? e : null;
}

/** Pure policy check — exact (case-insensitive) match on the owner's email. */
export function isEntityCreator(email: string | null | undefined): boolean {
  const owner = entityCreatorEmail();
  return !!owner && !!email && email.trim().toLowerCase() === owner;
}

/** True if the AUTHENTICATED (server-side session) user is the owner. */
export async function currentUserIsEntityCreator(): Promise<boolean> {
  const user = await getCurrentUser();
  return isEntityCreator(user?.email);
}

/**
 * Guard for entity creation (the /ledger/new page and the createEntity server
 * action — the action is the authoritative check; the page guard is UX). 404s
 * (not 403) so non-owners can't distinguish the route from a missing one.
 */
export async function assertEntityCreator(): Promise<void> {
  if (!(await currentUserIsEntityCreator())) notFound();
}
