import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/supabase/auth-server";
import { accessibleEntityIds, isEntityCreator } from "@/lib/ledger/access";
import { Greeting } from "@/components/greeting";

export const dynamic = "force-dynamic";

export default async function Home() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const { db, schema } = await import("@/lib/db/client");
  const { eq, asc } = await import("drizzle-orm");

  const [userRows, allEntities] = await Promise.all([
    db
      .select({ firstName: schema.bkAppUsers.firstName })
      .from(schema.bkAppUsers)
      .where(eq(schema.bkAppUsers.email, user.email ?? ""))
      .limit(1),
    db
      .select({
        id: schema.bkLedgerEntities.id,
        name: schema.bkLedgerEntities.name,
      })
      .from(schema.bkLedgerEntities)
      .orderBy(asc(schema.bkLedgerEntities.name)),
  ]);

  // Filter to accessible entities
  const ids = await accessibleEntityIds(user.email);
  const entityRows = ids === "all" ? allEntities : allEntities.filter((e) => ids.has(e.id));

  const firstName = userRows[0]?.firstName
    ?? user.email?.split("@")[0]?.replace(/[^a-zA-Z]/g, " ").trim().split(" ")[0]
    ?? "cutie";

  return (
    <main className="flex-1 flex flex-col items-center px-6 pt-20 pb-16">
      {/* Outside the max-w-sm column so the heading fits on one line. */}
      <Greeting name={firstName} />
      <div className="mt-8 w-full max-w-sm space-y-8">
        <div className="space-y-1.5">
          {entityRows.map((e) => (
            <Link
              key={e.id}
              href={`/ledger/${e.id}`}
              className="group flex items-center justify-between rounded-lg border border-hair bg-background px-3 py-2.5 transition-all hover:border-evergreen/40 hover:shadow-sm"
            >
              <span className="text-sm font-medium group-hover:text-evergreen transition-colors">
                {e.name}
              </span>
              <span className="shrink-0 text-xs text-faint group-hover:text-evergreen transition-colors">
                →
              </span>
            </Link>
          ))}
        </div>

        {entityRows.length === 0 && (
          <div className="rounded-lg border border-dashed border-hair px-6 py-10 text-center">
            <p className="text-sm text-muted-foreground">No entities yet.</p>
            {isEntityCreator(user.email) && (
              <Link
                href="/ledger/new"
                className="mt-3 inline-block text-sm font-medium text-evergreen hover:underline"
              >
                Add your first entity
              </Link>
            )}
          </div>
        )}

        {entityRows.length > 1 && (
          <Link
            href="/comparison"
            className="group flex items-center gap-3 rounded-lg border border-hair bg-background px-3 py-3 transition-all hover:border-evergreen/40 hover:shadow-sm"
          >
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-evergreen/8 text-evergreen">
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z" />
              </svg>
            </div>
            <div className="min-w-0">
              <span className="text-sm font-medium group-hover:text-evergreen transition-colors">
                Portfolio comparison
              </span>
              <p className="text-xs text-faint">
                Real Estate P&L across all entities
              </p>
            </div>
            <span className="ml-auto shrink-0 text-xs text-faint group-hover:text-evergreen transition-colors">
              →
            </span>
          </Link>
        )}

        {entityRows.length > 1 && (
          <Link
            href="/trueup"
            className="group flex items-center gap-3 rounded-lg border border-hair bg-background px-3 py-3 transition-all hover:border-evergreen/40 hover:shadow-sm"
          >
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-evergreen/8 text-evergreen">
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3v11.25A2.25 2.25 0 006 16.5h2.25M3.75 3h-1.5m1.5 0h16.5m0 0h1.5m-1.5 0v11.25A2.25 2.25 0 0118 16.5h-2.25m-7.5 0h7.5m-7.5 0l-1 3m8.5-3l1 3m0 0l.5 1.5m-.5-1.5h-9.5m0 0l-.5 1.5M9 11.25v1.5M12 9v3.75m3-6v6" />
              </svg>
            </div>
            <div className="min-w-0">
              <span className="text-sm font-medium group-hover:text-evergreen transition-colors">
                Capital account true-up
              </span>
              <p className="text-xs text-faint">
                Compare partner balances to ownership pro-rata
              </p>
            </div>
            <span className="ml-auto shrink-0 text-xs text-faint group-hover:text-evergreen transition-colors">
              →
            </span>
          </Link>
        )}
      </div>
    </main>
  );
}
