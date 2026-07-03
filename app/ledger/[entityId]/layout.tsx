import Link from "next/link";
import { notFound } from "next/navigation";
import { getEntity, entityHasLocations } from "@/lib/ledger/reports";
import { assertEntityAccess, currentUserIsAdmin } from "@/lib/ledger/access";
import { EntityUtilityNav, LedgerNav } from "./ledger-nav";

export const dynamic = "force-dynamic";

export default async function EntityLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ entityId: string }>;
}) {
  const { entityId } = await params;
  // Authorization: 404s unless the current user is an admin or has been granted
  // this entity. Covers every nested per-entity page.
  await assertEntityAccess(entityId);
  const entity = await getEntity(entityId);
  if (!entity) notFound();
  const base = `/ledger/${entityId}`;
  const [hasLocations, admin] = await Promise.all([
    entityHasLocations(entityId),
    currentUserIsAdmin(),
  ]);

  return (
    <main className="flex-1 px-6 py-8">
      <div className="mx-auto w-full max-w-5xl space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <Link
              href="/"
              className="text-sm text-faint hover:text-muted-foreground"
            >
              ← All entities
            </Link>
            <h1 className="mt-1 font-serif text-3xl font-medium tracking-tight">
              {entity.name}
            </h1>
          </div>
          <EntityUtilityNav base={base} showAccess={admin} />
        </div>
        <LedgerNav base={base} showByAddress={hasLocations} />
        <div className="pt-2">{children}</div>
      </div>
    </main>
  );
}
