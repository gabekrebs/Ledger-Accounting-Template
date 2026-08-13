import { searchTransactions, ledgerStats } from "@/lib/ledger/reports";
import { TransactionsTable } from "./transactions-table";
import { NewEntryButton } from "./new-entry";
import { NewExpenseButton } from "./new-expense";

export const dynamic = "force-dynamic";

// Load a generous working set so search / sort / filters are all instant on the
// client. Covers every current entity in full; the table flags the cap honestly
// if an entity ever exceeds it (and date filters reach the rest server-side).
const LOAD_CAP = 5000;

export default async function TransactionsPage({
  params,
}: {
  params: Promise<{ entityId: string }>;
}) {
  const { entityId } = await params;
  const [rows, stats] = await Promise.all([
    searchTransactions(entityId, { limit: LOAD_CAP }),
    ledgerStats(entityId),
  ]);

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Every journal entry for this entity. Search, filter by type or period,
          and sort any column — click an account to open its ledger.
        </p>
        <div className="flex shrink-0 gap-2">
          <NewExpenseButton entityId={entityId} />
          <NewEntryButton entityId={entityId} />
        </div>
      </div>
      <TransactionsTable
        entityId={entityId}
        rows={rows}
        totalCount={stats.entryCount}
      />
    </div>
  );
}
