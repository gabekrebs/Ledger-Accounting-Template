import { notFound } from "next/navigation";
import { utilityReport } from "@/lib/ledger/utilities";
import { UtilitiesClient } from "./utilities-client";

export const dynamic = "force-dynamic";

/**
 * Owner-covered utilities per building (owner request 2026-07-30): entities
 * with long-term tenants whose leases don't split utilities track what the
 * owner pays, straight from the Plaid feed — one section per building, one
 * column per utility, payment-month buckets. Config: bk_utility_groups /
 * bk_utility_matchers (seeded per entity; the tab only exists when rows do).
 * Access is enforced by the entity layout, same as every sibling page.
 */
export default async function UtilitiesPage({
  params,
}: {
  params: Promise<{ entityId: string }>;
}) {
  const { entityId } = await params;
  const groups = await utilityReport(entityId);
  if (groups.length === 0) notFound();
  return <UtilitiesClient groups={groups} />;
}
