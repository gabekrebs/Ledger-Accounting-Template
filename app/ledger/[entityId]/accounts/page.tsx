import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { accountBalances } from "@/lib/ledger/reports";
import { AccountsTable } from "./accounts-table";

export const dynamic = "force-dynamic";

const { bkAccounts } = schema;

export default async function AccountsPage({
  params,
}: {
  params: Promise<{ entityId: string }>;
}) {
  const { entityId } = await params;
  const [balsAll, acctRows] = await Promise.all([
    accountBalances(entityId),
    db
      .select({ id: bkAccounts.id, qboAccountId: bkAccounts.qboAccountId })
      .from(bkAccounts)
      .where(eq(bkAccounts.entityId, entityId)),
  ]);
  const idByQbo = new Map(acctRows.map((a) => [a.qboAccountId, a.id]));

  // Inactive accounts only show if they still hold a balance (standard chart hygiene —
  // a deactivated, zeroed transitional account drops off; money can never be hidden).
  const bals = balsAll.filter((a) => a.active || a.netCents !== 0);

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

  return <AccountsTable entityId={entityId} accounts={accounts} parents={parents} />;
}
