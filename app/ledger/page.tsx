import Link from "next/link";
import {
  listEntities,
  ownerPctForFirstName,
  ownerPctForFirstNameAsOf,
  ownerProfitShareCents,
} from "@/lib/ledger/reports";
import { accessibleEntityIds, getAppUser, isAdmin, isEntityCreator } from "@/lib/ledger/access";
import { getCurrentUser } from "@/lib/supabase/auth-server";
import { Button } from "@/components/ui/button";
import { EntitySearchList } from "./entity-search-list";
import { PortfolioComparison } from "./portfolio-comparison";

export const dynamic = "force-dynamic";

export default async function LedgerHome() {
  const user = await getCurrentUser();
  const admin = await isAdmin(user?.email);
  // Owner-only (identity, not role) — see assertEntityCreator in access.ts.
  const creator = isEntityCreator(user?.email);
  const ids = await accessibleEntityIds(user?.email);
  const all = await listEntities();
  const entities = ids === "all" ? all : all.filter((e) => ids.has(e.id));

  // Own-share view: the signed-in user's FIRST NAME (from their account, never
  // the email or a hardcode) + role. Accountants → portfolio-wide only; admin +
  // business partners also get their own first-name-matched slice.
  const me = await getAppUser(user?.email);
  const role = me?.role ?? (admin ? "owner" : "business_partner");
  const ownerFirstName = (
    me?.firstName?.trim() ||
    me?.displayName?.trim().split(/\s+/)[0] ||
    ""
  ).toLowerCase();
  const canSeeOwnView = role !== "accountant";

  // Portfolio RE comparison — per-entity parallel queries (faster than one giant cross-join)
  const { db: _db, schema: _schema } = await import("@/lib/db/client");

  const ownerRows = await _db
    .select({ id: _schema.bkLedgerEntities.id, owners: _schema.bkLedgerEntities.owners })
    .from(_schema.bkLedgerEntities);
  const ownersByEntity = new Map(ownerRows.map((r) => [r.id, r.owners]));

  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const d30 = new Date(today); d30.setDate(d30.getDate() - 30);
  const d365 = new Date(today); d365.setFullYear(d365.getFullYear() - 1);
  const lastYear = today.getFullYear() - 1;

  const { plSummary } = await import("@/lib/ledger/reports");

  const periods = {
    "30d": { start: d30.toISOString().slice(0, 10), end: todayStr },
    "365d": { start: d365.toISOString().slice(0, 10), end: todayStr },
    lastYear: { start: `${lastYear}-01-01`, end: `${lastYear}-12-31` },
  };

  const portfolioData = await Promise.all(
    entities.map(async (e) => {
      const [p30, p365, pLY, p30nd, p365nd, pLYnd] = await Promise.all([
        plSummary(e.id, { ...periods["30d"], activity: "Real Estate" }),
        plSummary(e.id, { ...periods["365d"], activity: "Real Estate" }),
        plSummary(e.id, { ...periods.lastYear, activity: "Real Estate" }),
        plSummary(e.id, { ...periods["30d"], activity: "Real Estate", excludeDepreciation: true }),
        plSummary(e.id, { ...periods["365d"], activity: "Real Estate", excludeDepreciation: true }),
        plSummary(e.id, { ...periods.lastYear, activity: "Real Estate", excludeDepreciation: true }),
      ]);
      const owners = ownersByEntity.get(e.id) ?? [];
      // Owner-share profit per period, time-weighted across dated ownership
      // changes (roster `prior` entries) — a period spanning a buyout earns
      // each era its own pct.
      const share = (p: { start: string; end: string }, noDepr: boolean, total: number) =>
        ownerProfitShareCents(
          e.id, owners, ownerFirstName, "legal",
          { ...p, activity: "Real Estate", excludeDepreciation: noDepr || undefined },
          total
        );
      const [o30, o365, oLY, o30nd, o365nd, oLYnd] = await Promise.all([
        share(periods["30d"], false, p30.netProfitCents),
        share(periods["365d"], false, p365.netProfitCents),
        share(periods.lastYear, false, pLY.netProfitCents),
        share(periods["30d"], true, p30nd.netProfitCents),
        share(periods["365d"], true, p365nd.netProfitCents),
        share(periods.lastYear, true, pLYnd.netProfitCents),
      ]);
      return {
        entityId: e.id,
        name: e.name,
        ownPct: ownerPctForFirstName(owners, ownerFirstName),
        ownProfit:
          o30 == null
            ? null
            : {
                "30d": o30, "365d": o365!, lastYear: oLY!,
                "30d_noDepr": o30nd!, "365d_noDepr": o365nd!, lastYear_noDepr: oLYnd!,
              },
        // Badge pct per period: the split in effect at that period's END, so
        // "2025" shows the historic share while current periods show today's.
        ownPctByPeriod: {
          "30d": ownerPctForFirstNameAsOf(owners, ownerFirstName, "legal", periods["30d"].end),
          "365d": ownerPctForFirstNameAsOf(owners, ownerFirstName, "legal", periods["365d"].end),
          lastYear: ownerPctForFirstNameAsOf(owners, ownerFirstName, "legal", periods.lastYear.end),
        },
        "30d": p30,
        "365d": p365,
        lastYear: pLY,
        "30d_noDepr": p30nd,
        "365d_noDepr": p365nd,
        lastYear_noDepr: pLYnd,
      };
    })
  );

  return (
    <main className="flex-1 px-6 py-12">
      <div className="mx-auto w-full max-w-page space-y-6">
        <header className="flex items-start justify-between">
          <div>
            <h1 className="font-serif text-4xl font-medium tracking-tight">
              Ledger
            </h1>
            <p className="mt-2 text-muted-foreground">
              Property-level books for your portfolio.
            </p>
          </div>
          {admin && (
            <div className="flex shrink-0 items-center gap-4">
              {creator && (
                <Link href="/ledger/new">
                  <Button size="sm">+ Add entity</Button>
                </Link>
              )}
              <Link
                href="/ledger/users"
                className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
              >
                Users →
              </Link>
              <Link
                href="/ledger/rules"
                className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
              >
                Global rules →
              </Link>
              <Link
                href="/ledger/connections"
                className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
              >
                Bank connections →
              </Link>
            </div>
          )}
        </header>

        {entities.length === 0 ? (
          <div className="flex flex-col items-center gap-4 rounded-xl border border-dashed border-border px-8 py-16 text-center">
            <div className="space-y-1">
              <p className="font-medium">No entities yet</p>
              <p className="text-sm text-muted-foreground">
                Add your first entity to start tracking its books.
              </p>
            </div>
            {creator && (
              <Link href="/ledger/new">
                <Button>Add your first entity</Button>
              </Link>
            )}
          </div>
        ) : (
          <EntitySearchList
            entities={entities.map((e) => ({
              id: e.id,
              name: e.name,
              legalName: e.legalName,
              taxType: e.taxType,
              importedThrough: e.importedThrough,
              propertyAddress: e.propertyAddress,
            }))}
          />
        )}

        {entities.length > 0 && (
          <PortfolioComparison
            data={portfolioData}
            lastYear={lastYear}
            ownerName={ownerFirstName ? ownerFirstName[0].toUpperCase() + ownerFirstName.slice(1) : "You"}
            canSeeOwnView={canSeeOwnView}
          />
        )}
      </div>
    </main>
  );
}
