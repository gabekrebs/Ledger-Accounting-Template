import Link from "next/link";
import { notFound } from "next/navigation";
import { generalLedger } from "@/lib/ledger/reports";
import { Money } from "@/components/money";
import { EditTransactionButton } from "../../edit-transaction";

export const dynamic = "force-dynamic";

export default async function GlPage({
  params,
}: {
  params: Promise<{ entityId: string; accountId: string }>;
}) {
  const { entityId, accountId } = await params;
  const { account, rows } = await generalLedger(entityId, accountId);
  if (!account) notFound();

  return (
    <div className="space-y-5">
      <div className="flex items-end justify-between gap-3">
        <div>
          <Link href={`/ledger/${entityId}/accounts`} className="text-sm text-faint hover:text-muted-foreground">
            ← Accounts
          </Link>
          <h2 className="mt-1 font-serif text-xl font-medium tracking-tight">
            {account.fullyQualifiedName ?? account.name}
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {account.accountType} · {rows.length} postings · ending{" "}
            <Money cents={account.netCents} tone="auto" className="text-xs" />
          </p>
        </div>
        {/* Statement-tie workflow exists only for bank/credit card accounts. */}
        {(account.accountType === "Bank" || account.accountType === "Credit Card") && (
          <Link
            href={`/ledger/${entityId}/reconcile/${accountId}`}
            className="rounded-lg border border-hair px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:border-evergreen/40 hover:text-evergreen"
          >
            Reconcile
          </Link>
        )}
      </div>

      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-hair text-[11px] font-medium uppercase tracking-[0.06em] text-faint">
            <th className="py-2 text-left font-medium">Date</th>
            <th className="py-2 text-left font-medium">Type</th>
            <th className="py-2 text-left font-medium">Name / Memo</th>
            <th className="py-2 text-right font-medium">Debit</th>
            <th className="py-2 text-right font-medium">Credit</th>
            <th className="py-2 text-right font-medium">Balance</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={`${r.entryId}-${i}`} className="border-b border-hair/60">
              <td className="whitespace-nowrap py-2.5 font-mono tabular-nums text-muted-foreground">{r.txnDate}</td>
              <td className="whitespace-nowrap py-2.5 text-xs text-faint">
                <Link
                  href={`/ledger/${entityId}/transactions?q=${encodeURIComponent(r.qboTxnId ?? "")}`}
                  className="hover:text-evergreen hover:underline"
                >
                  {r.qboTxnType}
                </Link>
              </td>
              <td className="max-w-md truncate py-2.5 text-muted-foreground">
                {r.name ? <span className="text-foreground">{r.name}</span> : null}
                {r.name && (r.lineMemo || r.memo) ? " · " : null}
                <span className="text-faint">{r.lineMemo || r.memo}</span>
              </td>
              <td className="py-2.5 text-right">{r.debitCents ? <Money cents={r.debitCents} /> : ""}</td>
              <td className="py-2.5 text-right">{r.creditCents ? <Money cents={r.creditCents} /> : ""}</td>
              <td className="py-2.5 text-right text-muted-foreground">
                <span className="inline-flex items-center justify-end gap-1.5">
                  <Money cents={r.runningCents} tone="auto" />
                  <EditTransactionButton
                    entityId={entityId}
                    entryId={r.entryId}
                    edited={!!r.editedAt}
                  />
                </span>
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={6} className="py-8 text-center text-muted-foreground">No postings.</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
