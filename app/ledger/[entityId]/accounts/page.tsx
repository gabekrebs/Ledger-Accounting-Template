import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { accountBalances } from "@/lib/ledger/reports";
import { entityYears } from "@/lib/ledger/trial-balance";
import { AccountsTable } from "./accounts-table";
import { TbExport } from "./tb-export";

export const dynamic = "force-dynamic";

const { bkAccounts } = schema;

export default async function AccountsPage({
  params,
}: {
  params: Promise<{ entityId: string }>;
}) {
  const { entityId } = await params;
  const [balsAll, acctRows, years] = await Promise.all([
    accountBalances(entityId),
    db
      .select({ id: bkAccounts.id, qboAccountId: bkAccounts.qboAccountId })
      .from(bkAccounts)
      .where(eq(bkAccounts.entityId, entityId)),
    entityYears(entityId),
  ]);
  const idByQbo = new Map(acctRows.map((a) => [a.qboAccountId, a.id]));

  // Pass every account through — the client table hides ARCHIVED + $0 accounts by
  // default behind a "Show archived (N)" toggle, and always shows an archived
  // account that still holds a balance (money is never hidden). Filtering them out
  // here would make the toggle count zero and hide the archive UI entirely.
  const bals = balsAll;

  const accounts = bals.map((a) => ({
    id: idByQbo.get(a.qboAccountId) ?? null,
    qboAccountId: a.qboAccountId,
    name: a.name,
    fullyQualifiedName: a.fullyQualifiedName,
    accountType: a.accountType,
    classification: a.classification,
    active: a.active,
    activity: a.activity,
    netCents: a.netCents,
  }));

  // Parent options for new sub-accounts: active accounts with their bk id.
  const parents = bals
    .filter((a) => a.active && idByQbo.has(a.qboAccountId))
    .map((a) => ({
      id: idByQbo.get(a.qboAccountId)!,
      label: a.fullyQualifiedName ?? a.name,
      classification: a.classification,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));

  return (
    <div className="space-y-6">
      <AccountsTable entityId={entityId} accounts={accounts} parents={parents} />
      <TbExport entityId={entityId} years={years} />
    </div>
  );
}
