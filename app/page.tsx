import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/supabase/auth-server";
import { accessibleEntityIds, isAdmin, isEntityCreator } from "@/lib/ledger/access";
import { unreviewedCount } from "@/lib/ledger/audit-review";
import { pendingCountsByEntity } from "@/lib/plaid/review-data";
import { Greeting } from "@/components/greeting";
import { PropertyPicker } from "@/components/property-picker";

export const dynamic = "force-dynamic";

export default async function Home() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const { db, schema } = await import("@/lib/db/client");
  const { eq, asc } = await import("drizzle-orm");

  const [userRows, allEntities, admin] = await Promise.all([
    db
      .select({
        firstName: schema.bkAppUsers.firstName,
        displayName: schema.bkAppUsers.displayName,
      })
      .from(schema.bkAppUsers)
      .where(eq(schema.bkAppUsers.email, user.email ?? ""))
      .limit(1),
    db
      .select({
        id: schema.bkLedgerEntities.id,
        name: schema.bkLedgerEntities.name,
        nickname: schema.bkLedgerEntities.nickname,
      })
      .from(schema.bkLedgerEntities)
      .orderBy(asc(schema.bkLedgerEntities.name)),
    isAdmin(user.email),
  ]);

  // Filter to accessible entities
  const ids = await accessibleEntityIds(user.email);
  const entityRows = ids === "all" ? allEntities : allEntities.filter((e) => ids.has(e.id));

  // Cross-entity review-queue badge — scoped to the same accessible set as
  // everything else on this page. Counts what /review actually SHOWS
  // (excludeQueueHidden drops fresh card-payment halves), so the badge never
  // advertises rows the queue then hides.
  const pendingTotal = [
    ...(
      await pendingCountsByEntity(ids, {
        settledOnly: true,
        excludeQueueHidden: true,
      })
    ).values(),
  ].reduce((s, n) => s + n, 0);

  // Admin-only: how many team-activity items are waiting for review (badge).
  const unreviewed = admin ? await unreviewedCount() : 0;

  // Greet with the name attached to the account: the explicit first_name if set,
  // else the first word of the display name (e.g. "Alice Example" → "Alice").
  // Never derive from the email local-part.
  const account = userRows[0];
  const firstName =
    account?.firstName?.trim() ||
    account?.displayName?.trim().split(/\s+/)[0] ||
    "there";

  return (
    <main className="flex-1 flex flex-col items-center px-6 pt-10 pb-16">
      {/* Outside the content column so the heading fits on one line. */}
      <Greeting name={firstName} />
      {/* max-w-lg keeps the tools row comfortable; the entity cards form a
          narrower shared-width column (w-60 — sized to the Review Queue card's
          natural width) so all three cards read as one deliberate stack. */}
      <div className="mt-10 w-full max-w-lg space-y-8">
        <div className="mx-auto w-60 max-w-full space-y-3">
          {/* The entities live behind a command-style search picker when
              there are several: typing anywhere, "/", or ⌘K opens it (see
              PropertyPicker). A single entity renders as a plain card — a
              picker over one item is ceremony. */}
          {entityRows.length > 1 && (
            <PropertyPicker
              /* The launcher shows (and fuzzy-matches) the NICKNAME when one
                 is set; reports and entity pages keep the full name. */
              properties={entityRows.map((e) => ({ id: e.id, name: e.nickname ?? e.name ?? "Untitled entity" }))}
              commandRHref="/review"
            />
          )}
          {entityRows.length === 1 && entityRows.map((e) => (
            <Link
              key={e.id}
              href={`/ledger/${e.id}`}
              prefetch={false}
              className="group flex w-full items-center justify-between gap-3 rounded-lg border border-hair bg-card px-4 py-3 shadow-[0_1px_2px_rgb(28_27_25/0.04)] transition-all duration-150 hover:border-evergreen/40 hover:shadow-[0_3px_12px_-2px_rgb(28_27_25/0.10)]"
            >
              <span className="text-sm font-medium group-hover:text-evergreen transition-colors">
                {e.nickname ?? e.name}
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

        {/* Only rendered when there is actually something to review — an empty
            queue earns zero pixels (owner request; /review stays reachable
            by URL and ⌘R). */}
        {pendingTotal > 0 && (
          <Link
            href="/review"
            prefetch={false}
            className="group mx-auto flex w-fit items-center gap-3 rounded-lg border border-hair bg-background px-4 py-3 transition-all hover:border-evergreen/40 hover:shadow-sm"
          >
            <div className="relative flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-evergreen/8 text-evergreen">
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 13.5h3.86a2.25 2.25 0 012.012 1.244l.256.512a2.25 2.25 0 002.013 1.244h3.218a2.25 2.25 0 002.013-1.244l.256-.512a2.25 2.25 0 012.013-1.244h3.859m-19.5.338V18a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18v-4.162c0-.224-.034-.447-.1-.661L19.24 5.338a2.25 2.25 0 00-2.15-1.588H6.911a2.25 2.25 0 00-2.15 1.588L2.35 13.177a2.25 2.25 0 00-.1.661z" />
              </svg>
              {pendingTotal > 0 && (
                <span className="absolute -right-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-500 px-1 text-[10px] font-semibold leading-none text-white">
                  {pendingTotal > 99 ? "99+" : pendingTotal}
                </span>
              )}
            </div>
            <span className="text-sm font-medium group-hover:text-evergreen transition-colors">
              Review Queue
            </span>
            <span className="shrink-0 text-xs text-faint group-hover:text-evergreen transition-colors">
              →
            </span>
          </Link>
        )}

        {/* Tools — monthly-or-less destinations. A quiet hairline row instead
            of full cards, so they stay one click away without competing with
            the entities or the Review Queue card above. */}
        {(admin || entityRows.length > 1) && (
          <div className="flex flex-col items-center justify-center gap-y-3 border-t border-hair pt-5 sm:flex-row sm:flex-wrap sm:gap-x-8 sm:gap-y-2">
            {entityRows.length > 1 && (
              <Link
                href="/comparison"
                prefetch={false}
                className="group inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-evergreen"
                title="Real Estate P&L across all entities"
              >
                <svg className="h-3.5 w-3.5 text-faint transition-colors group-hover:text-evergreen" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z" />
                </svg>
                Portfolio comparison
              </Link>
            )}
            {entityRows.length > 1 && (
              <Link
                href="/trueup"
                prefetch={false}
                className="group inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-evergreen"
                title="Compare partner balances to ownership pro-rata"
              >
                <svg className="h-3.5 w-3.5 text-faint transition-colors group-hover:text-evergreen" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3v11.25A2.25 2.25 0 006 16.5h2.25M3.75 3h-1.5m1.5 0h16.5m0 0h1.5m-1.5 0v11.25A2.25 2.25 0 0118 16.5h-2.25m-7.5 0h7.5m-7.5 0l-1 3m8.5-3l1 3m0 0l.5 1.5m-.5-1.5h-9.5m0 0l-.5 1.5M9 11.25v1.5M12 9v3.75m3-6v6" />
                </svg>
                Capital true-up
              </Link>
            )}
            {admin && (
              <Link
                href="/teamactivity"
                prefetch={false}
                className="group inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-evergreen"
                title="Changes made by other users"
              >
                <svg className="h-3.5 w-3.5 text-faint transition-colors group-hover:text-evergreen" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                Team activity
                {unreviewed > 0 && (
                  <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-semibold leading-none text-white">
                    {unreviewed > 99 ? "99+" : unreviewed}
                  </span>
                )}
              </Link>
            )}
          </div>
        )}
      </div>
    </main>
  );
}
