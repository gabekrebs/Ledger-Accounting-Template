import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import {
  getPlaid,
  PLAID_PRODUCTS,
  PLAID_COUNTRY_CODES,
  plaidWebhookUrl,
  plaidRedirectUri,
} from "@/lib/plaid/client";
import { decryptToken } from "@/lib/plaid/crypto";
import { currentUserIsAdmin } from "@/lib/ledger/access";

export const runtime = "nodejs";

/**
 * Create a short-lived Plaid Link token for the browser to open Link with.
 * POST /api/plaid/link-token  { entityId? }            — fresh link
 * POST /api/plaid/link-token  { itemId }               — update-mode re-link
 *
 * Linking is GLOBAL — one bank auth is not bound to one business; the accounts
 * it returns are routed to entities afterward on the Bank connections screen, so
 * entityId is optional and the Link user is a stable app-level id, not an
 * entity. No CRON_SECRET (the link token itself is the capability and expires
 * quickly); it grants nothing without the user then completing Link in their own
 * browser.
 *
 * Update mode (itemId = our bk_plaid_items row id): the token carries the Item's
 * access_token, so Link reopens the EXISTING connection instead of creating a new
 * one — same Item, same transaction ids, no duplicate staging rows. Repairs a
 * broken login (ITEM_LOGIN_REQUIRED / expired OAuth consent). It can NOT deepen
 * history: per Plaid, "Once Transactions has been added to an Item,
 * [days_requested] cannot be updated" — deepening requires the replace flow
 * (lib/plaid/replace.ts): retire the Item and link the institution fresh. Plaid
 * rejects `products` in update mode, so it's only sent on fresh links.
 */
export async function POST(request: NextRequest) {
  // Linking a bank is connection management — admins only.
  if (!(await currentUserIsAdmin())) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  try {
    const body = await request.json().catch(() => ({}));
    const entityId: string | undefined = body?.entityId;
    const itemId: string | undefined = body?.itemId;
    const plaid = getPlaid();

    let accessToken: string | undefined;
    if (itemId) {
      const items = await db
        .select()
        .from(schema.bkPlaidItems)
        .where(eq(schema.bkPlaidItems.id, itemId));
      if (!items[0]) {
        return NextResponse.json({ error: "Unknown item" }, { status: 404 });
      }
      accessToken = decryptToken(items[0].accessToken);
    }

    // Register the transaction-update webhook so the bank's history lands as soon
    // as Plaid finishes its async extraction (the link-time sync runs too early
    // and pulls nothing); null in local dev → link without one. (Update mode
    // keeps the Item's link-time webhook; passing it again is a no-op.)
    const webhook = plaidWebhookUrl();
    // OAuth banks (Chase, etc.) redirect the browser out to the bank and back to
    // this URI; required for them, must be registered in the Plaid dashboard.
    // Null in local dev → omitted, so credential-flow banks still link locally.
    const redirectUri = plaidRedirectUri();
    const resp = await plaid.linkTokenCreate({
      // Stable per-app user; accounts fan out to entities post-link.
      user: { client_user_id: entityId ?? "ledger-accounting-template" },
      client_name: "Ledger Accounting Template",
      ...(accessToken
        ? { access_token: accessToken }
        : { products: PLAID_PRODUCTS }),
      country_codes: PLAID_COUNTRY_CODES,
      language: "en",
      ...(webhook ? { webhook } : {}),
      ...(redirectUri ? { redirect_uri: redirectUri } : {}),
      // Update mode: let the user change the account selection so a newly-opened
      // account can be ADDED to this EXISTING Item (one login = one Item) instead
      // of creating a duplicate Item via a fresh link. No-op on fresh links.
      ...(accessToken ? { update: { account_selection_enabled: true } } : {}),
      // Request the full 24 months of history Plaid allows (default is 90 days),
      // so a newly linked bank backfills closer to the QuickBooks experience.
      // Locked in at link time — harmless but inert on update-mode tokens.
      transactions: { days_requested: 730 },
    });
    return NextResponse.json({ link_token: resp.data.link_token });
  } catch (err) {
    console.error("plaid/link-token:", err);
    return NextResponse.json(
      { error: "Could not create link token" },
      { status: 500 }
    );
  }
}
