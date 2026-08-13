import { assertEntityAccess } from "@/lib/ledger/access";
import { reconStatus } from "@/lib/ledger/recon-status";
import { SETTLING_GRACE_DAYS } from "@/lib/ledger/recon-status-shared";
import { ReconRow } from "./recon-row";

export const dynamic = "force-dynamic";

/**
 * Reconciliation — is each account's book balance right, or off? One row per
 * account with a verifiable external balance: Plaid-linked accounts compare the
 * current book balance to the bank's live figure at render; everything else
 * (non-mortgage loans, unlinked bank/CC accounts) compares against the balance
 * the user last entered from the real statement. The pill is the product —
 * everything else on the row is supporting detail. The per-account statement-tie
 * workspace stays at `reconcile/[accountId]` ("Full reconcile" on each row).
 */
export default async function ReconciliationPage({
  params,
}: {
  params: Promise<{ entityId: string }>;
}) {
  const { entityId } = await params;
  await assertEntityAccess(entityId);
  const rows = await reconStatus(entityId);

  return (
    <div className="space-y-4">
      <div>
        <h2 className="font-serif text-xl font-medium tracking-tight">
          Reconciliation
        </h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Book balance vs the real world, per account. Plaid accounts check the
          bank live; the rest compare against the balance you last entered from a
          statement.
        </p>
      </div>

      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No reconcilable accounts — link a bank on Connections or add a
          bank/credit-card account to this entity.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40 text-[11px] font-medium uppercase tracking-[0.06em] text-faint">
                <th className="py-2.5 pl-4 text-left font-medium">Account</th>
                <th className="py-2.5 text-left font-medium">Source</th>
                <th className="py-2.5 text-right font-medium">Book balance</th>
                <th className="py-2.5 text-right font-medium">Actual</th>
                <th className="py-2.5 text-center font-medium">Status</th>
                <th className="py-2.5 text-right font-medium">Checked</th>
                <th className="py-2.5 pr-4" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <ReconRow key={row.qboAccountId} entityId={entityId} row={row} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="max-w-prose text-xs text-faint">
        Plaid rows net out in-flight bank-feed items (pending at the bank, or
        settled but not yet posted) before judging sync — the book intentionally
        runs a day or two behind the bank, and that lag isn&apos;t a variance.
        What little remains stays green as &ldquo;settling&rdquo; while it&apos;s
        young; only a difference that persists past {SETTLING_GRACE_DAYS} days
        flags as off — timing noise self-corrects, genuine problems don&apos;t.
        Mortgages are excluded — escrow expensing and servicer timing make their
        book balance legitimately drift; they true up annually against the 1098.
        Unexplained variances under $1.00 read as in sync.
      </p>
    </div>
  );
}
