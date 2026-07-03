import { assertAdmin } from "@/lib/ledger/access";
import { listAppUsers, listEntityGrants } from "@/lib/ledger/users";
import { EntityAccessClient } from "./entity-access-client";

export const dynamic = "force-dynamic";

function envEmails(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Who can see THIS entity. Admin-only (the parent layout already verified the
 * entity itself). Grants here are the same `bk_entity_access` rows the global
 * /ledger/users page manages — just scoped to one entity.
 */
export default async function EntityAccessPage({
  params,
}: {
  params: Promise<{ entityId: string }>;
}) {
  await assertAdmin();
  const { entityId } = await params;

  const [grants, users] = await Promise.all([
    listEntityGrants(entityId),
    listAppUsers(),
  ]);

  const managedAdmins = users
    .filter((u) => u.role === "admin" && u.active)
    .map((u) => u.email);
  const admins = [...new Set([...envEmails("AUTH_ADMIN_EMAILS"), ...managedAdmins])];

  // Members who exist but don't have this entity yet — offered as quick grants.
  const granted = new Set(grants.map((g) => g.email));
  const grantable = users
    .filter((u) => u.role === "member" && !granted.has(u.email))
    .map((u) => ({ email: u.email, displayName: u.displayName }));

  return (
    <EntityAccessClient
      entityId={entityId}
      grants={grants}
      admins={admins}
      grantable={grantable}
    />
  );
}
