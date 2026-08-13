import Link from "next/link";
import { redirect } from "next/navigation";
import {
  listEntities,
  plSummary,
  ownerPctForFirstName,
  ownerPctForFirstNameAsOf,
  ownerProfitShareCents,
} from "@/lib/ledger/reports";
import { accessibleEntityIds, getAppUser, isAdmin } from "@/lib/ledger/access";
import { getCurrentUser } from "@/lib/supabase/auth-server";
import { PortfolioComparison } from "@/app/ledger/portfolio-comparison";

export const dynamic = "force-dynamic";

export default async function ComparisonPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const ids = await accessibleEntityIds(user.email);
  const all = await listEntities();
  // Mirrored partner entities are excluded from portfolio-wide rollups (owner
  // decision): partial ownership + the partner's own accounting conventions.
  // Their per-entity pages remain fully viewable.
  const entities = ids === "all" ? all : all.filter((e) => ids.has(e.id));

  if (entities.length === 0) redirect("/");

  // Whose "own share" view is this? Derive the signed-in user's FIRST NAME from
  // their account (never the email, never hardcoded) and their role. Accountants
  // have no ownership, so they only get the portfolio-wide view; everyone else
  // (admin + business partners) also gets their own first-name-matched slice.
  const me = await getAppUser(user.email);
  const role = me?.role ?? ((await isAdmin(user.email)) ? "owner" : "business_partner");
  const ownerFirstName = (
    me?.firstName?.trim() ||
    me?.displayName?.trim().split(/\s+/)[0] ||
    ""
  ).toLowerCase();
  const canSeeOwnView = role !== "accountant";

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

  const periods = {
    "30d": { start: d30.toISOString().slice(0, 10), end: todayStr },
    "365d": { start: d365.toISOString().slice(0, 10), end: todayStr },
    lastYear: { start: `${lastYear}-01-01`, end: `${lastYear}-12-31` },
  };

  const { capitalStructure } = await import("@/lib/ledger/reports");
  const { getValuationComponents, sumComponents } = await import("@/lib/ledger/valuation");

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

      // Get market value (from valuation components) and total liabilities for equity
      const components = await getValuationComponents(e.id);
      const valueCents = sumComponents(components) || (e.marketValueCents ?? 0);
      const cap = await capitalStructure(e.id, todayStr);

      // Owner-share profit per period, time-weighted across dated ownership
      // changes (roster `prior` entries) — a period spanning a buyout earns
      // each era its own pct.
      const share = (p: { start: string; end: string }, noDepr: boolean, total: number) =>
        ownerProfitShareCents(
          e.id, owners, ownerFirstName, "reporting",
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
        // Economic basis: the viewer's real share for personal reporting, which
        // can differ from the legal roster (reportingPct ?? pct per owner).
        ownPct: ownerPctForFirstName(owners, ownerFirstName, "reporting"),
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
          "30d": ownerPctForFirstNameAsOf(owners, ownerFirstName, "reporting", periods["30d"].end),
          "365d": ownerPctForFirstNameAsOf(owners, ownerFirstName, "reporting", periods["365d"].end),
          lastYear: ownerPctForFirstNameAsOf(owners, ownerFirstName, "reporting", periods.lastYear.end),
        },
        marketValueCents: valueCents,
        totalDebtCents: cap.totalLiabilitiesCents,
        equityCents: valueCents - cap.totalLiabilitiesCents,
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
      <div className="mx-auto w-full max-w-page">
        <div className="mb-6">
          <Link href="/" className="text-sm text-muted-foreground hover:text-foreground transition-colors">
            ← Home
          </Link>
        </div>
        <PortfolioComparison
          data={portfolioData}
          lastYear={lastYear}
          ownerName={ownerFirstName ? ownerFirstName[0].toUpperCase() + ownerFirstName.slice(1) : "You"}
          canSeeOwnView={canSeeOwnView}
        />
      </div>
    </main>
  );
}
