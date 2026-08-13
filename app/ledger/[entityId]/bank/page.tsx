import Link from "next/link";
import { SyncButton } from "./sync-button";
import { ReviewList } from "./review-list";
import { AutoPostedRow } from "./auto-posted-row";
import { mapAccount } from "./actions";
import {
  listItems,
  listMappableAccounts,
  listRecentAutoPosted,
} from "@/lib/plaid/data";
import { buildEntityReviewData } from "@/lib/plaid/review-data";
import {
  currentUserIsOwner,
  currentUserEntityAccessLevel,
} from "@/lib/ledger/access";
import { Button, buttonVariants } from "@/components/ui/button";

export const dynamic = "force-dynamic";

function fmtSynced(d: Date | null): string {
  if (!d) return "never";
  return new Date(d).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default async function BankPage({
  params,
}: {
  params: Promise<{ entityId: string }>;
}) {
  const { entityId } = await params;
  // Row enrichment (rule matches, suggestions, already-booked flags) lives in
  // the shared builder — the cross-entity /review queue uses the same one.
  const [review, items, mappable, autoPosted, owner, accessLevel] =
    await Promise.all([
      buildEntityReviewData(entityId),
      listItems(entityId),
      listMappableAccounts(entityId),
      listRecentAutoPosted(entityId),
      currentUserIsOwner(),
      currentUserEntityAccessLevel(entityId),
    ]);
  const readOnly = accessLevel !== "write";
  const {
    reviewRows,
    postableOpts,
    initialSuggestions,
    knownPayees,
    pendingCount,
  } = review;
  const hasItems = items.length > 0;

  return (
    <div className="space-y-8">
      <div className="flex justify-end gap-2">
        {/* Plaid sync is owner-only (the route enforces it server-side too). */}
        {hasItems && owner && <SyncButton entityId={entityId} />}
        {owner && (
          <Link
            href="/ledger/connections"
            className={buttonVariants({ variant: "outline" })}
          >
            Bank connections →
          </Link>
        )}
      </div>

      {!hasItems ? (
        <div className="rounded-lg border border-dashed border-hair px-6 py-12 text-center">
          <p className="text-sm text-muted-foreground">
            No bank accounts assigned to this entity yet.
            {owner && (
              <>
                {" "}
                Link a bank and assign its accounts on{" "}
                <Link
                  href="/ledger/connections"
                  className="font-medium text-foreground underline"
                >
                  Bank connections
                </Link>
                .
              </>
            )}
          </p>
          <p className="mt-2 text-xs text-faint">
            One login can fan out to several businesses — assign each account to
            the entity whose books it belongs in.
          </p>
        </div>
      ) : (
        <section className="space-y-4">
          <h3 className="text-[11px] font-medium uppercase tracking-[0.06em] text-faint">
            Connected banks
          </h3>
          {items.map((item) => (
            <div key={item.id} className="rounded-lg border border-hair p-4">
              <div className="flex items-center justify-between">
                <div className="font-medium">
                  {item.institutionName ?? "Bank"}
                </div>
                <div className="text-xs text-faint">
                  {item.status === "active" ? (
                    <>synced {fmtSynced(item.lastSyncedAt)}</>
                  ) : (
                    <span className="text-oxblood">
                      {item.status}
                      {item.lastError ? ` — ${item.lastError}` : ""}
                    </span>
                  )}
                </div>
              </div>
              <div className="mt-3 space-y-2">
                {item.accounts.map((a) => (
                  <form
                    key={a.id}
                    action={mapAccount}
                    className="flex items-center justify-between gap-3 text-sm"
                  >
                    <input type="hidden" name="entityId" value={entityId} />
                    <input
                      type="hidden"
                      name="plaidAccountRowId"
                      value={a.id}
                    />
                    <div className="min-w-0">
                      <span className="font-medium">{a.name ?? "Account"}</span>
                      {a.mask && (
                        <span className="ml-1 text-faint">··{a.mask}</span>
                      )}
                      <span className="ml-2 text-xs text-faint">
                        {a.subtype ?? a.type ?? ""}
                      </span>
                    </div>
                    {readOnly ? (
                      <span className="text-xs text-faint">
                        {mappable.find((m) => m.id === a.mappedAccountId)
                          ?.fullyQualifiedName ??
                          mappable.find((m) => m.id === a.mappedAccountId)
                            ?.name ??
                          "unmapped"}
                      </span>
                    ) : (
                      <div className="flex items-center gap-2">
                        <select
                          name="mappedAccountId"
                          defaultValue={a.mappedAccountId ?? ""}
                          className="rounded border border-hair bg-transparent px-2 py-1 text-xs"
                        >
                          <option value="">— map to ledger account —</option>
                          {mappable.map((m) => (
                            <option key={m.id} value={m.id}>
                              {m.fullyQualifiedName ?? m.name}
                            </option>
                          ))}
                        </select>
                        <Button type="submit" variant="outline" size="sm">
                          Save
                        </Button>
                      </div>
                    )}
                  </form>
                ))}
              </div>
            </div>
          ))}
        </section>
      )}

      {hasItems && (
        <ReviewList
          entityId={entityId}
          rows={reviewRows}
          accounts={postableOpts}
          pendingLabel={
            pendingCount === 200 ? "first 200" : `${pendingCount} pending`
          }
          initialSuggestions={initialSuggestions}
          knownPayees={knownPayees}
          readOnly={readOnly}
          canRunAi={owner}
        />
      )}

      {autoPosted.length > 0 && (
        <section className="space-y-3">
          <div className="flex items-baseline justify-between">
            <h3 className="text-[11px] font-medium uppercase tracking-[0.06em] text-faint">
              Recently auto-posted
            </h3>
            <span className="text-xs text-faint">
              posted automatically by recognizers and rules — review &amp; undo
              if wrong
            </span>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-hair text-[11px] font-medium uppercase tracking-[0.06em] text-faint">
                <th className="py-2 text-left font-medium">Date</th>
                <th className="py-2 text-left font-medium">Description</th>
                <th className="py-2 text-left font-medium">Category</th>
                <th className="py-2 text-right font-medium">Amount</th>
                <th className="py-2 text-right font-medium" />
              </tr>
            </thead>
            <tbody>
              {autoPosted.map((t) => (
                <AutoPostedRow key={t.txnId} entityId={entityId} txn={t} readOnly={readOnly} />
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
