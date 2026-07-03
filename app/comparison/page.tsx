import Link from "next/link";
import { redirect } from "next/navigation";
import { listEntities, plSummary } from "@/lib/ledger/reports";
import { accessibleEntityIds } from "@/lib/ledger/access";
import { getCurrentUser } from "@/lib/supabase/auth-server";
import { PortfolioComparison } from "@/app/ledger/portfolio-comparison";

export const dynamic = "force-dynamic";

export default async function ComparisonPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const ids = await accessibleEntityIds(user.email);
  const all = await listEntities();
  const entities = ids === "all" ? all : all.filter((e) => ids.has(e.id));

  if (entities.length === 0) redirect("/");

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
      // The "Owner" pro-rata view keys off a partner whose name contains
      // OWNER_NAME (env). Unset → ownerPct null → the view shows a dash.
      const owners = ownersByEntity.get(e.id) ?? [];
      const ownerName = (process.env.OWNER_NAME ?? "").trim().toLowerCase();
      const ownerRow = ownerName
        ? owners?.find((o: { name: string; pct: number }) => o.name.toLowerCase().includes(ownerName))
        : null;

      // Get market value (from valuation components) and total liabilities for equity
      const components = await getValuationComponents(e.id);
      const valueCents = sumComponents(components) || (e.marketValueCents ?? 0);
      const cap = await capitalStructure(e.id, todayStr);

      return {
        entityId: e.id,
        name: e.name,
        ownerPct: ownerRow?.pct ?? null,
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
      <div className="mx-auto w-full max-w-4xl">
        <div className="mb-6">
          <Link href="/" className="text-sm text-muted-foreground hover:text-foreground transition-colors">
            ← Home
          </Link>
        </div>
        <PortfolioComparison data={portfolioData} lastYear={lastYear} />
      </div>
    </main>
  );
}
