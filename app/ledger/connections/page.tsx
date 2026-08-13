import Link from "next/link";
import { ConnectBankButton } from "./connect-bank-button";
import { SyncAllButton } from "./sync-all-button";
import { DisconnectButton } from "./disconnect-button";
import { UpdateLinkButton } from "./update-link-button";
import { ReplaceButton } from "./replace-button";
import { SuggestMatches } from "./suggest-matches";
import { assignAccount } from "./actions";
import { listConnections, listAssignTargets } from "@/lib/plaid/data";
import { assertOwner } from "@/lib/ledger/access";
import { Button } from "@/components/ui/button";

export const dynamic = "force-dynamic";
// Assignment server actions defer reconcile + auto-post to after() — a first
// sync can carry ~400 pending txns, so the function needs room to finish that
// work post-response instead of being cut at the default duration.
export const maxDuration = 300;

function fmtSynced(d: Date | null): string {
  if (!d) return "never";
  return new Date(d).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default async function ConnectionsPage() {
  await assertOwner(); // bank-connection management is a system surface — owner only
  const [connections, targets] = await Promise.all([
    listConnections(),
    listAssignTargets(),
  ]);
  const hasConnections = connections.length > 0;
  const hasUnassigned = connections.some((c) =>
    c.accounts.some((a) => !a.entityId)
  );

  return (
    <main className="flex-1 px-6 py-12">
      <div className="mx-auto w-full max-w-page space-y-8">
        <div className="flex items-start justify-between">
          <div>
            <Link
              href="/"
              className="text-sm text-faint hover:text-muted-foreground"
            >
              ← All entities
            </Link>
            <h1 className="mt-1 font-serif text-3xl font-medium tracking-tight">
              Bank connections
            </h1>
            <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
              Link a bank login once. Each account it returns can be routed to
              any business and ledger account below — one login fans out to as
              many entities as it has accounts, with no limit. Plaid bills
              ~$0.30 per connected account / month.
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            {hasConnections && <SyncAllButton />}
            <ConnectBankButton />
          </div>
        </div>

        {hasConnections && (
          <div className="max-w-2xl">
            <ConnectBankButton force />
          </div>
        )}

        {!hasConnections ? (
          <div className="rounded-lg border border-dashed border-hair px-6 py-12 text-center">
            <p className="text-sm text-muted-foreground">
              No bank connected yet. Click{" "}
              <span className="font-medium text-foreground">Connect a bank</span>{" "}
              to link one — log in once, then assign its accounts to businesses.
            </p>
            <p className="mt-2 text-xs text-faint">
              Sandbox: pick any institution, log in with{" "}
              <code className="rounded bg-paper px-1">user_good</code> /{" "}
              <code className="rounded bg-paper px-1">pass_good</code>.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            <SuggestMatches hasUnassigned={hasUnassigned} />
            {connections.map((c) => (
              <div key={c.id} className="rounded-lg border border-hair p-4">
                <div className="flex items-center justify-between">
                  <div className="font-medium">{c.institutionName ?? "Bank"}</div>
                  <div className="flex items-center gap-3">
                    <div className="text-xs text-faint">
                      {c.status === "active" ? (
                        <>synced {fmtSynced(c.lastSyncedAt)}</>
                      ) : (
                        <span className="text-oxblood">
                          {c.status}
                          {c.lastError ? ` — ${c.lastError}` : ""}
                        </span>
                      )}
                    </div>
                    <ReplaceButton
                      itemId={c.id}
                      institutionName={c.institutionName ?? "Bank"}
                    />
                    <UpdateLinkButton
                      itemId={c.id}
                      institutionName={c.institutionName ?? "Bank"}
                    />
                    <DisconnectButton
                      itemId={c.id}
                      institutionName={c.institutionName ?? "Bank"}
                    />
                  </div>
                </div>

                <div className="mt-3 divide-y divide-hair/60">
                  {c.accounts.map((a) => {
                    const current =
                      a.entityId && a.mappedAccountId
                        ? `${a.entityId}:${a.mappedAccountId}`
                        : "";
                    return (
                      <form
                        key={a.id}
                        action={assignAccount}
                        className="flex items-center justify-between gap-3 py-2 text-sm"
                      >
                        <input
                          type="hidden"
                          name="plaidAccountRowId"
                          value={a.id}
                        />
                        <div className="min-w-0">
                          <span className="font-medium">
                            {a.name ?? "Account"}
                          </span>
                          {a.mask && (
                            <span className="ml-1 text-faint">··{a.mask}</span>
                          )}
                          <span className="ml-2 text-xs text-faint">
                            {a.subtype ?? a.type ?? ""}
                          </span>
                          <div className="text-xs text-faint">
                            {a.entityName ? (
                              <>
                                → {a.entityName}
                                {a.mappedAccountName
                                  ? ` · ${a.mappedAccountName}`
                                  : ""}
                              </>
                            ) : (
                              <span className="text-oxblood">unassigned</span>
                            )}
                          </div>
                          {a.duplicateWarning && (
                            <div className="text-[10px] text-oxblood">
                              ⚠ also connected under another bank link — leave
                              one side unassigned to avoid double-counting
                            </div>
                          )}
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          <select
                            name="assignment"
                            defaultValue={current}
                            className="max-w-[18rem] rounded border border-hair bg-transparent px-2 py-1 text-xs"
                          >
                            <option value="">— unassigned —</option>
                            {targets.map((t) => (
                              <optgroup
                                key={t.entityId}
                                label={t.entityName ?? "Entity"}
                              >
                                {t.accounts.map((opt) => (
                                  <option
                                    key={opt.id}
                                    value={`${t.entityId}:${opt.id}`}
                                  >
                                    {t.entityName} · {opt.label}
                                  </option>
                                ))}
                              </optgroup>
                            ))}
                          </select>
                          <Button type="submit" variant="outline" size="sm">
                            Save
                          </Button>
                        </div>
                      </form>
                    );
                  })}
                </div>
              </div>
            ))}
            <p className="text-xs text-faint">
              Assigning an account routes its future and pending transactions to
              that business&apos;s review inbox (under its Bank tab). Already-posted
              entries stay where they are.
            </p>
          </div>
        )}
      </div>
    </main>
  );
}
