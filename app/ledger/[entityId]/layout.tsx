import Link from "next/link";
import { notFound } from "next/navigation";
import { getEntity } from "@/lib/ledger/reports";
import { entityHasUtilities } from "@/lib/ledger/utilities";
import {
  assertEntityAccess,
  currentUserIsAdmin,
  currentUserEntityAccessLevel,
} from "@/lib/ledger/access";
import { EntityUtilityNav, LedgerNav } from "./ledger-nav";
import { EntityCapabilities } from "./capabilities";

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
  const [hasUtilities, admin, accessLevel] = await Promise.all([
    entityHasUtilities(entityId),
    currentUserIsAdmin(),
    currentUserEntityAccessLevel(entityId),
  ]);
  const readOnly = accessLevel === "read"; // owner/write users → false

  return (
    <main className="flex-1 px-6 py-8">
      <div className="mx-auto w-full max-w-page space-y-4">
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
        <LedgerNav base={base} showUtilities={hasUtilities} />
        {readOnly ? (
          <div className="flex items-center gap-2 rounded-md border border-hair bg-paper px-3 py-2 text-xs text-muted-foreground">
            <svg className="h-3.5 w-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 10.5V6.75a3.75 3.75 0 10-7.5 0v3.75m-.75 0h9a1.5 1.5 0 011.5 1.5v6a1.5 1.5 0 01-1.5 1.5h-9a1.5 1.5 0 011.5-1.5z" />
            </svg>
            You have <span className="font-medium">read-only</span> access to this
            entity. Viewing is available; changes are disabled.
          </div>
        ) : null}
        <div className="pt-2">
          {/* Client write-controls (edit pencil, new entry, …) read this to
              self-hide for read-only users; server actions re-assert anyway. */}
          <EntityCapabilities readOnly={readOnly}>{children}</EntityCapabilities>
        </div>
      </div>
    </main>
  );
}
