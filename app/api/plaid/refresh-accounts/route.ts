import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { getPlaid, safePlaidError } from "@/lib/plaid/client";
import { decryptToken } from "@/lib/plaid/crypto";
import { currentUserIsOwner } from "@/lib/ledger/access";
import { limitRoute } from "@/lib/security/rate-limit";
import { actionIdentity } from "@/lib/security/rate-limit-identity";

export const runtime = "nodejs";

const { bkPlaidItems, bkPlaidAccounts } = schema;

/**
 * Refresh a connection's account list after an Update-Mode re-link — the second
 * half of "add accounts to the EXISTING Item" (one login = one Item). Update mode
 * (link-token with account_selection_enabled) lets the user pick newly-opened
 * accounts; this pulls the Item's current accounts and upserts any new ones into
 * bk_plaid_accounts, then syncs so their history lands in staging.
 *
 * Only INSERTS/updates accounts — never deletes. An account the user deselects in
 * Plaid's UI (or one with posted history) is intentionally kept, so books are
 * never orphaned. New accounts arrive UNASSIGNED (entityId null), exactly like a
 * fresh link, and stay inert until the owner assigns an entity + ledger account.
 * Owner only (bank-connection management never widens past the owner).
 * POST /api/plaid/refresh-accounts  { itemId }
 */
export async function POST(request: NextRequest) {
  if (!(await currentUserIsOwner())) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const limited = await limitRoute("plaidCredential", await actionIdentity());
  if (limited) return limited;
  try {
    const { itemId } = await request.json();
    if (!itemId) {
      return NextResponse.json({ error: "itemId required" }, { status: 400 });
    }
    const [item] = await db
      .select()
      .from(bkPlaidItems)
      .where(eq(bkPlaidItems.id, itemId));
    if (!item) {
      return NextResponse.json({ error: "Unknown item" }, { status: 404 });
    }

    const plaid = getPlaid();
    const accessToken = decryptToken(item.accessToken);
    const accountsResp = await plaid.accountsGet({ access_token: accessToken });

    // Which accounts did we already have, so we can report how many are new.
    const existing = new Set(
      (
        await db
          .select({ plaidAccountId: bkPlaidAccounts.plaidAccountId })
          .from(bkPlaidAccounts)
          .where(eq(bkPlaidAccounts.itemId, item.id))
      ).map((r) => r.plaidAccountId)
    );

    let added = 0;
    for (const a of accountsResp.data.accounts) {
      if (!existing.has(a.account_id)) added++;
      await db
        .insert(bkPlaidAccounts)
        .values({
          itemId: item.id,
          // entityId left null — new accounts are unassigned/inert until routed.
          // onConflict does NOT touch entityId/mappedAccountId, so existing
          // assignments are preserved.
          plaidAccountId: a.account_id,
          name: a.name ?? null,
          officialName: a.official_name ?? null,
          mask: a.mask ?? null,
          type: a.type ?? null,
          subtype: a.subtype ?? null,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: bkPlaidAccounts.plaidAccountId,
          set: {
            name: a.name ?? null,
            officialName: a.official_name ?? null,
            mask: a.mask ?? null,
            type: a.type ?? null,
            subtype: a.subtype ?? null,
            updatedAt: new Date(),
          },
        });
    }

    // Pull transactions so a newly-added account's history reaches staging.
    let synced: { added: number; modified: number; removed: number } | null =
      null;
    try {
      const { syncItemTransactions } = await import("@/lib/plaid/sync");
      const [fresh] = await db
        .select()
        .from(bkPlaidItems)
        .where(eq(bkPlaidItems.id, item.id));
      if (fresh) synced = await syncItemTransactions(fresh);
    } catch (e) {
      console.error("plaid/refresh-accounts sync:", safePlaidError(e));
      // non-fatal — the manual Sync button will pull them
    }

    return NextResponse.json({
      ok: true,
      accounts: accountsResp.data.accounts.length,
      added,
      synced,
    });
  } catch (err) {
    console.error("plaid/refresh-accounts:", safePlaidError(err));
    return NextResponse.json(
      { error: "Could not refresh accounts" },
      { status: 500 }
    );
  }
}
