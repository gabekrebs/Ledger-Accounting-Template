import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/supabase/auth-server";
import { listEntities } from "@/lib/ledger/reports";
import { accessibleEntityIds } from "@/lib/ledger/access";
import { Money } from "@/components/money";
import { ownersPctValid, type ParityOwner } from "@/lib/ledger/trueup";
import { Planner } from "./planner";

export const dynamic = "force-dynamic";

export default async function TrueUpPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const ids = await accessibleEntityIds(user.email);
  const all = await listEntities();
  const entities = ids === "all" ? all : all.filter((e) => ids.has(e.id));

  const { db, schema } = await import("@/lib/db/client");
  const { eq, and, sql } = await import("drizzle-orm");

  type EntityTrueUp = {
    entityId: string;
    entityName: string;
    owners: ParityOwner[];
    totalCapitalCents: number;
    // The planner emits actionable dollar figures, so it only renders when the
    // inputs provably reconcile. A failed gate falls back to the read-only
    // table with a visible warning — loud beats silently confident.
    gateFailure: string | null;
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
    const roster = e.owners as { name: string; pct: number }[];

    // ── Input-integrity gates ────────────────────────────────────────────
    // The parity solver is only as good as its inputs. Three invariants:
    //
    //  1. Ownership pcts sum to 100 — otherwise "pro-rata" is meaningless.
    //  2. Every owner matches EXACTLY one account, and no two owners share a
    //     first name (the ownerPctForFirstName invariant: never guess another
    //     owner's slice). One owner with two capital buckets (e.g. "- Initial
    //     Contribution" + "- Capital Calls") also fails here — first-match-
    //     wins would drop one bucket from their row while the total keeps it.
    //  3. Σ owner balances === entity total. Catches both the multi-bucket
    //     bug above and any unassigned residual sitting in a generic capital
    //     account — either way, parity is unsolvable as displayed.
    let gateFailure: string | null = null;

    if (!ownersPctValid(roster)) {
      gateFailure = "ownership percentages don't sum to 100";
    }

    const firstNames = roster.map((o) => o.name.toLowerCase().split(/\s+/)[0]);
    if (!gateFailure && new Set(firstNames).size !== firstNames.length) {
      gateFailure = "two owners share a first name — matching is ambiguous";
    }

    const owners: ParityOwner[] = [];
    if (!gateFailure) {
      for (const o of roster) {
        const ownerFirst = o.name.toLowerCase().split(/\s+/)[0];
        const matches = balances.filter((b) => {
          const acctFirst = b.name.toLowerCase().split(/\s*[-–—\s]/)[0];
          return acctFirst === ownerFirst;
        });
        if (matches.length !== 1) {
          gateFailure =
            matches.length === 0
              ? `no capital account matched for ${o.name}`
              : `${o.name} matches ${matches.length} capital accounts`;
          break;
        }
        owners.push({ name: o.name, pct: o.pct, actualCents: matches[0].netCents });
      }
    }

    if (!gateFailure) {
      const ownerSum = owners.reduce((s, o) => s + o.actualCents, 0);
      if (ownerSum !== totalCapitalCents) {
        gateFailure = "owner balances don't sum to the entity total — unassigned capital exists";
      }
    }

    results.push({
      entityId: e.id,
      entityName: e.name ?? "Unknown",
      owners: gateFailure
        ? roster.map((o) => {
            const ownerFirst = o.name.toLowerCase().split(/\s+/)[0];
            const m = balances.find(
              (b) => b.name.toLowerCase().split(/\s*[-–—\s]/)[0] === ownerFirst
            );
            return { name: o.name, pct: o.pct, actualCents: m?.netCents ?? 0 };
          })
        : owners,
      totalCapitalCents,
      gateFailure,
    });
  }

  return (
    <main className="flex-1 px-6 py-12">
      <div className="mx-auto w-full max-w-2xl">
        <div className="mb-6">
          <Link href="/" className="text-sm text-muted-foreground hover:text-foreground transition-colors">
            ← Home
          </Link>
        </div>

        <div className="mb-8">
          <h1 className="font-serif text-2xl font-medium tracking-tight">
            Capital account true-up
          </h1>
        </div>

        <div className="space-y-8">
          {results.map((r) =>
            r.gateFailure ? (
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
                <p className="border-b border-border bg-oxblood/5 px-4 py-2 text-xs text-oxblood">
                  Can&apos;t compute a distribution — {r.gateFailure}. The figures
                  below may not reconcile; fix the capital accounts first.
                </p>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-[11px] font-medium uppercase tracking-[0.06em] text-faint">
                      <th className="py-2 pl-4 text-left">Partner</th>
                      <th className="py-2 text-right">Ownership</th>
                      <th className="py-2 text-right">Actual</th>
                      <th className="py-2 pr-4 text-right">Pro-rata</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.owners.map((o) => (
                      <tr key={o.name} className="border-b border-border/60 last:border-0">
                        <td className="py-2.5 pl-4 font-medium">{o.name}</td>
                        <td className="py-2.5 text-right font-mono text-xs tabular-nums text-muted-foreground">
                          {o.pct}%
                        </td>
                        <td className="py-2.5 text-right">
                          <Money cents={o.actualCents} />
                        </td>
                        <td className="py-2.5 pr-4 text-right text-muted-foreground">
                          <Money cents={Math.round((r.totalCapitalCents * o.pct) / 100)} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Planner
                key={r.entityId}
                entityId={r.entityId}
                entityName={r.entityName}
                owners={r.owners}
              />
            )
          )}

          {results.length === 0 && (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No multi-owner entities with capital accounts to true up.
            </p>
          )}
        </div>
      </div>
    </main>
  );
}
