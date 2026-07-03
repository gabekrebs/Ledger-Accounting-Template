import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/supabase/auth-server";
import { listEntities } from "@/lib/ledger/reports";
import { accessibleEntityIds } from "@/lib/ledger/access";
import { Money } from "@/components/money";

export const dynamic = "force-dynamic";

export default async function TrueUpPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const ids = await accessibleEntityIds(user.email);
  const all = await listEntities();
  const entities = ids === "all" ? all : all.filter((e) => ids.has(e.id));

  const { db, schema } = await import("@/lib/db/client");
  const { eq, and, sql } = await import("drizzle-orm");

  // For each entity, get owner investment/drawings accounts and compare to ownership %
  type OwnerTrueUp = {
    name: string;
    ownershipPct: number;
    actualCents: number;     // what they actually have in the capital account
    expectedCents: number;   // what they should have based on ownership %
    diffCents: number;       // positive = overfunded, negative = underfunded
  };

  type EntityTrueUp = {
    entityId: string;
    entityName: string;
    owners: OwnerTrueUp[];
    totalCapitalCents: number;
  };

  const results: EntityTrueUp[] = [];

  for (const e of entities) {
    if (!e.owners?.length || e.owners.length < 2) continue;

    // Find all owner investment/drawings accounts
    const ownerAccts = await db
      .select({
        id: schema.bkAccounts.id,
        name: schema.bkAccounts.name,
      })
      .from(schema.bkAccounts)
      .where(
        and(
          eq(schema.bkAccounts.entityId, e.id),
          eq(schema.bkAccounts.classification, "equity"),
        )
      );

    // Filter to investment/drawing accounts (not retained earnings, opening balance, etc.)
    const investmentAccts = ownerAccts.filter(
      (a) =>
        /investment|drawing|contribution/i.test(a.name) &&
        !/retained|opening|owner.*equity$/i.test(a.name)
    );

    if (!investmentAccts.length) continue;

    // Get balances for each
    const balances: { name: string; netCents: number }[] = [];
    for (const a of investmentAccts) {
      const [row] = await db
        .select({
          net: sql<number>`COALESCE(SUM(${schema.bkJournalLines.debitCents} - ${schema.bkJournalLines.creditCents}), 0)::bigint`,
        })
        .from(schema.bkJournalLines)
        .where(eq(schema.bkJournalLines.accountId, a.id));
      // Equity is credit-normal, so net investment = -net (credit balance is positive investment)
      balances.push({ name: a.name, netCents: -Number(row?.net ?? 0) });
    }

    const totalCapitalCents = balances.reduce((s, b) => s + b.netCents, 0);

    // Match each owner to their account and compute true-up
    const owners: OwnerTrueUp[] = (e.owners as { name: string; pct: number }[]).map((o) => {
      const ownerFirst = o.name.toLowerCase().split(/\s+/)[0];
      const matchedAcct = balances.find((b) => {
        const acctFirst = b.name.toLowerCase().split(/\s*[-–—\s]/)[0];
        return acctFirst === ownerFirst;
      });
      // Also check for "Joint" accounts — skip those (they're temporary)
      const actualCents = matchedAcct?.netCents ?? 0;
      const expectedCents = Math.round(totalCapitalCents * o.pct / 100);
      return {
        name: o.name,
        ownershipPct: o.pct,
        actualCents,
        expectedCents,
        diffCents: actualCents - expectedCents,
      };
    });

    results.push({
      entityId: e.id,
      entityName: e.name ?? "Unknown",
      owners,
      totalCapitalCents,
    });
  }

  return (
    <main className="flex-1 px-6 py-12">
      <div className="mx-auto w-full max-w-4xl">
        <div className="mb-6">
          <Link href="/" className="text-sm text-muted-foreground hover:text-foreground transition-colors">
            ← Home
          </Link>
        </div>

        <div className="mb-8">
          <h1 className="font-serif text-2xl font-medium tracking-tight">
            Capital account true-up
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Compares each partner&apos;s actual capital account balance to their pro-rata share based on ownership percentage.
            Positive = overfunded (owed money back). Negative = underfunded (owes money in).
          </p>
        </div>

        <div className="space-y-8">
          {results.filter((r) => r.owners.some((o) => o.diffCents !== 0)).map((r) => (
            <div key={r.entityId} className="rounded-xl border border-border overflow-hidden">
              <div className="border-b border-border bg-muted/40 px-4 py-3">
                <Link
                  href={`/ledger/${r.entityId}`}
                  className="text-sm font-medium hover:text-evergreen hover:underline"
                >
                  {r.entityName}
                </Link>
                <span className="ml-3 text-xs text-muted-foreground">
                  Total capital: <Money cents={r.totalCapitalCents} />
                </span>
              </div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-[11px] font-medium uppercase tracking-[0.06em] text-faint">
                    <th className="py-2 pl-4 text-left">Partner</th>
                    <th className="py-2 text-right">Ownership</th>
                    <th className="py-2 text-right">Actual</th>
                    <th className="py-2 text-right">Pro-rata</th>
                    <th className="py-2 pr-4 text-right">Over/(Under)</th>
                  </tr>
                </thead>
                <tbody>
                  {r.owners.map((o) => (
                    <tr key={o.name} className="border-b border-border/60 last:border-0">
                      <td className="py-2.5 pl-4 font-medium">{o.name}</td>
                      <td className="py-2.5 text-right font-mono text-xs tabular-nums text-muted-foreground">
                        {o.ownershipPct}%
                      </td>
                      <td className="py-2.5 text-right">
                        <Money cents={o.actualCents} />
                      </td>
                      <td className="py-2.5 text-right text-muted-foreground">
                        <Money cents={o.expectedCents} />
                      </td>
                      <td className="py-2.5 pr-4 text-right font-medium">
                        <Money cents={o.diffCents} tone="auto" />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}

          {results.every((r) => r.owners.every((o) => o.diffCents === 0)) && (
            <p className="py-8 text-center text-sm text-muted-foreground">
              All capital accounts are in balance with ownership percentages.
            </p>
          )}
        </div>
      </div>
    </main>
  );
}
