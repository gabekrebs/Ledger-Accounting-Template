import Link from "next/link";
import { notFound } from "next/navigation";
import { Money } from "@/components/money";
import {
  getReconcilableAccount,
  getReconciliationWorkspace,
  listReconciliations,
} from "@/lib/ledger/reconcile";
import { StartReconciliation, UndoLastReconciliation } from "./start";
import { RecWorkspaceView } from "./workspace";

export const dynamic = "force-dynamic";

/**
 * Bank reconciliation for one account (route key = qboAccountId, same as the
 * GL). Three states: an OPEN reconciliation shows the check-off workspace; no
 * open rec shows the start form; either way the statement history sits below.
 */
export default async function ReconcilePage({
  params,
}: {
  params: Promise<{ entityId: string; accountId: string }>;
}) {
  const { entityId, accountId } = await params;
  const account = await getReconcilableAccount(entityId, accountId);
  if (!account) notFound();

  const recs = await listReconciliations(entityId, account.id);
  const open = recs.find((r) => r.status === "in_progress");
  const workspace = open
    ? await getReconciliationWorkspace(entityId, open.id)
    : null;
  const completed = recs.filter((r) => r.status === "completed");

  return (
    <div className="space-y-6">
      <div>
        <Link
          href={`/ledger/${entityId}/gl/${account.qboAccountId}`}
          className="text-sm text-faint hover:text-muted-foreground"
        >
          ← {account.fullyQualifiedName ?? account.name}
        </Link>
        <h2 className="mt-1 font-serif text-xl font-medium tracking-tight">
          Reconcile
        </h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Tie this account to its bank statement: enter the statement&apos;s ending
          balance, check off the lines on it, and finish when the difference is
          $0.00.
        </p>
      </div>

      {workspace ? (
        <RecWorkspaceView entityId={entityId} initial={workspace} />
      ) : (
        <StartReconciliation
          entityId={entityId}
          accountId={account.id}
          normalBalance={account.normalBalance}
          lastStatement={completed[0] ?? null}
        />
      )}

      {completed.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-[11px] font-medium uppercase tracking-[0.06em] text-faint">
            Reconciled statements
          </h3>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-hair text-[11px] font-medium uppercase tracking-[0.06em] text-faint">
                <th className="py-2 text-left font-medium">Statement date</th>
                <th className="py-2 text-right font-medium">Statement balance</th>
                <th className="py-2 text-right font-medium">Lines</th>
                <th className="py-2 text-left font-medium">Reconciled by</th>
                <th className="py-2 text-right font-medium" />
              </tr>
            </thead>
            <tbody>
              {completed.map((r, i) => (
                <tr key={r.id} className="border-b border-hair/60">
                  <td className="py-2.5 font-mono tabular-nums text-muted-foreground">
                    {r.statementDate}
                  </td>
                  <td className="py-2.5 text-right">
                    <Money cents={r.statementBalanceCents} />
                  </td>
                  <td className="py-2.5 text-right tabular-nums text-muted-foreground">
                    {r.lineCount}
                  </td>
                  <td className="py-2.5 text-xs text-faint">
                    {r.createdBy ?? "—"}
                    {r.completedAt ? ` · ${r.completedAt.slice(0, 10)}` : ""}
                  </td>
                  <td className="py-2.5 text-right">
                    {/* Only the latest statement can be undone — releasing an
                        older one would orphan everything reconciled after it. */}
                    {i === 0 && !open && (
                      <UndoLastReconciliation
                        entityId={entityId}
                        accountId={account.id}
                      />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
