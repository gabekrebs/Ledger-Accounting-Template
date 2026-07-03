import Link from "next/link";
import { SyncButton } from "./sync-button";
import { ReviewList, type ReviewListRow } from "./review-list";
import { AutoPostedRow } from "./auto-posted-row";
import { mapAccount } from "./actions";
import {
  listItems,
  listPendingTransactions,
  listMappableAccounts,
  listPostableAccounts,
  listRecentAutoPosted,
  getBookedBankLines,
  matchBooked,
  countAlreadyBooked,
  listKnownPayees,
} from "@/lib/plaid/data";
import { readPersistedSuggestions } from "@/lib/plaid/suggest-categories";
import { loadRules, selectRule } from "@/lib/rules/engine";
import { extractFacts } from "@/lib/rules/facts";
import { db, schema } from "@/lib/db/client";
import { eq } from "drizzle-orm";
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
  const [
    items,
    pending,
    mappable,
    postable,
    autoPosted,
    persistedSugg,
    knownPayees,
  ] = await Promise.all([
    listItems(entityId),
    listPendingTransactions(entityId),
    listMappableAccounts(entityId),
    listPostableAccounts(entityId),
    listRecentAutoPosted(entityId),
    readPersistedSuggestions(entityId),
    listKnownPayees(entityId),
  ]);
  // Persisted suggestions (from the button or the batch job) pre-fill on load.
  const initialSuggestions = Array.from(persistedSugg.values());

  const hasItems = items.length > 0;

  // plaid account → mapped ledger account (the bank side of each posting).
  const mapByPlaidAcct = new Map<string, string | null>();
  const subtypeByPlaidAcct = new Map<string, string | null>();
  for (const it of items)
    for (const a of it.accounts) {
      mapByPlaidAcct.set(a.plaidAccountId, a.mappedAccountId);
      subtypeByPlaidAcct.set(a.plaidAccountId, a.subtype ?? null);
    }
  // The live rule set, so each pending row can show its current match (the
  // persisted matched_rule_id/review_reason are the sweep's record; rules may
  // have changed since, so we recompute in-memory here).
  const rules = await loadRules(entityId);
  const factsCtx = { subtypeByPlaidAcct };
  const bankAccountIds = [
    ...new Set(
      [...mapByPlaidAcct.values()].filter((v): v is string => !!v)
    ),
  ];
  // Imported (QBO/Wave) bank lines + count of exact matches already suppressed,
  // and the imported-books cutoff — the "already booked?" flag only applies to
  // rows dated inside the imported window (owner decision: recurring charges
  // legitimately repeat identical amounts, so proximity is noise after cutoff).
  const [bookedLines, hiddenBooked, [entityRow]] = await Promise.all([
    getBookedBankLines(entityId, bankAccountIds),
    countAlreadyBooked(entityId),
    db
      .select({ importedThrough: schema.bkLedgerEntities.importedThrough })
      .from(schema.bkLedgerEntities)
      .where(eq(schema.bkLedgerEntities.id, entityId)),
  ]);
  const importedThrough = entityRow?.importedThrough ?? null;
  const postableOpts = postable.map((a) => ({
    id: a.id,
    label: a.fullyQualifiedName ?? a.name ?? "",
    classification: a.classification,
  }));

  // Per-txn review rows for the client island: flag near-matches to imported
  // QBO/Wave lines (exact ones are already hidden) and whether the bank account
  // is mapped (a precondition for posting).
  const reviewRows: ReviewListRow[] = pending.map((t) => {
    const mappedAcct = mapByPlaidAcct.get(t.plaidAccountId) ?? null;
    const inImportedWindow =
      !!importedThrough && String(t.txnDate).slice(0, 10) <= importedThrough;
    const m =
      mappedAcct && inImportedWindow
        ? matchBooked(bookedLines, mappedAcct, Math.abs(t.amountCents), t.txnDate)
        : null;
    const alreadyBooked = m
      ? {
          source: m.source === "wave_import" ? "Wave" : "QuickBooks",
          daysOff: m.daysOff,
        }
      : null;
    const facts = extractFacts(t, factsCtx);
    const match = selectRule(rules, facts);
    return {
      txn: {
        id: t.id,
        txnDate: t.txnDate,
        name: t.name,
        merchantName: t.merchantName,
        amountCents: t.amountCents,
        category:
          (t.plaidCategory as { primary?: string } | null)?.primary ?? null,
        pending: t.pending,
        alreadyBooked,
      },
      mappedReady: !!mappedAcct,
      matchedRule: match
        ? { id: match.id, name: match.name, autoApply: match.autoApply }
        : undefined,
      reviewReason: t.reviewReason,
      merchantKey: facts.merchant,
    };
  });

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-serif text-xl font-medium">Bank feed</h2>
          <p className="text-sm text-muted-foreground">
            Transactions pulled directly from the bank via Plaid.
          </p>
        </div>
        <div className="flex gap-2">
          {hasItems && <SyncButton entityId={entityId} />}
          <Link
            href="/ledger/connections"
            className={buttonVariants({ variant: "outline" })}
          >
            Bank connections →
          </Link>
        </div>
      </div>

      {!hasItems ? (
        <div className="rounded-lg border border-dashed border-hair px-6 py-12 text-center">
          <p className="text-sm text-muted-foreground">
            No bank accounts assigned to this entity yet. Link a bank and assign
            its accounts on{" "}
            <Link
              href="/ledger/connections"
              className="font-medium text-foreground underline"
            >
              Bank connections
            </Link>
            .
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
            pending.length === 200 ? "first 200" : `${pending.length} pending`
          }
          hiddenBooked={hiddenBooked}
          initialSuggestions={initialSuggestions}
          knownPayees={knownPayees}
        />
      )}

      {autoPosted.length > 0 && (
        <section className="space-y-3">
          <div className="flex items-baseline justify-between">
            <h3 className="text-[11px] font-medium uppercase tracking-[0.06em] text-faint">
              Recently auto-posted
            </h3>
            <span className="text-xs text-faint">
              posted automatically from history — review &amp; undo if wrong
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
                <AutoPostedRow key={t.txnId} entityId={entityId} txn={t} />
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
