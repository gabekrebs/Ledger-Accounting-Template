import { NextRequest, NextResponse } from "next/server";
import { and, eq, ne } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { getPlaid, PLAID_COUNTRY_CODES } from "@/lib/plaid/client";
import { encryptToken } from "@/lib/plaid/crypto";
import { currentUserIsAdmin } from "@/lib/ledger/access";

export const runtime = "nodejs";

const { bkPlaidItems, bkPlaidAccounts } = schema;

/**
 * Exchange a Link public_token for a permanent access_token, persist the Item +
 * its accounts, and run an initial transaction sync.
 * POST /api/plaid/exchange  { public_token, entityId? }
 *
 * The accounts come back UNASSIGNED (entityId stays null) — a single login can
 * fan out to many businesses, so routing each account to an entity is a separate
 * step on the Bank connections screen. entityId, if passed, is recorded on the
 * Item only as provenance (which entity initiated the link); it does NOT assign
 * the accounts.
 */
export async function POST(request: NextRequest) {
  // Persisting a bank connection is connection management — admins only.
  if (!(await currentUserIsAdmin())) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  try {
    // `force` (admin-only, NOT exposed in the normal UI) bypasses the duplicate-
    // Item block below for the rare case of a genuinely separate second login at
    // the same institution.
    const { public_token, entityId, force } = await request.json();
    if (!public_token) {
      return NextResponse.json(
        { error: "public_token required" },
        { status: 400 }
      );
    }
    const plaid = getPlaid();

    const exchange = await plaid.itemPublicTokenExchange({ public_token });
    const accessToken = exchange.data.access_token; // plaintext, used locally only
    const encryptedToken = encryptToken(accessToken); // what we persist
    const plaidItemId = exchange.data.item_id;

    // Institution name (best-effort).
    let institutionId: string | null = null;
    let institutionName: string | null = null;
    try {
      const itemResp = await plaid.itemGet({ access_token: accessToken });
      institutionId = itemResp.data.item.institution_id ?? null;
      if (institutionId) {
        const inst = await plaid.institutionsGetById({
          institution_id: institutionId,
          country_codes: PLAID_COUNTRY_CODES,
        });
        institutionName = inst.data.institution.name ?? null;
      }
    } catch {
      // non-fatal — institution metadata is cosmetic
    }

    // Duplicate-Item HARD BLOCK: one bank login = one Plaid Item. If an ACTIVE
    // (non-replaced) Item already exists for this institution, refuse to create a
    // second one — a re-link with a different account selection would otherwise
    // spawn a duplicate Item for the same login, and some banks (e.g. Chase)
    // invalidate the prior Item when re-linked. The admin is steered to Update
    // Mode ("Update / add accounts") on the existing connection instead. The
    // replace flow is exempt: it tombstones the old Item to status 'replaced'
    // BEFORE re-linking, so it isn't counted here.
    if (institutionId && !force) {
      const sameInstitution = await db
        .select({
          id: bkPlaidItems.id,
          plaidItemId: bkPlaidItems.plaidItemId,
        })
        .from(bkPlaidItems)
        .where(
          and(
            eq(bkPlaidItems.institutionId, institutionId),
            ne(bkPlaidItems.status, "replaced")
          )
        );
      // Exclude the same Item re-linked (same plaidItemId → onConflict updates it
      // in place; that's not a duplicate).
      const other = sameInstitution.find((e) => e.plaidItemId !== plaidItemId);
      if (other) {
        // Don't persist this Item; drop the freshly-minted token so it doesn't
        // linger as an orphan (or bill) on the Plaid side.
        try {
          await plaid.itemRemove({ access_token: accessToken });
        } catch {
          // best-effort — token is unused/unpersisted regardless
        }
        return NextResponse.json(
          {
            error: "duplicate_item",
            message: `A ${
              institutionName ?? "bank"
            } connection already exists. To add or refresh accounts, use "Update / add accounts" on that connection — this keeps one Plaid Item per login.`,
            existingItemId: other.id,
          },
          { status: 409 }
        );
      }
    }

    // Upsert the Item. entityId is provenance only (nullable); never routing.
    const [item] = await db
      .insert(bkPlaidItems)
      .values({
        entityId: entityId ?? null,
        plaidItemId,
        accessToken: encryptedToken,
        institutionId,
        institutionName,
        status: "active",
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: bkPlaidItems.plaidItemId,
        set: {
          accessToken: encryptedToken,
          institutionId,
          institutionName,
          status: "active",
          lastError: null,
          updatedAt: new Date(),
        },
      })
      .returning();

    // Upsert the accounts.
    const accountsResp = await plaid.accountsGet({ access_token: accessToken });
    for (const a of accountsResp.data.accounts) {
      await db
        .insert(bkPlaidAccounts)
        .values({
          itemId: item.id,
          // entityId left null — assigned later on the Bank connections screen.
          // (On re-link, onConflict does NOT touch entityId, preserving any
          // existing assignment.)
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

    // If this institution was just "replaced" (the deepen-history flow), copy
    // the retired connection's account assignments onto the fresh accounts by
    // mask+name — BEFORE the initial sync, so incoming txns are stamped with
    // the right entities from the first row.
    const { migrateReplacedAssignments, reconcileEntitiesAfterReplace } =
      await import("@/lib/plaid/replace");
    const migration = await migrateReplacedAssignments(item.id);

    // Duplicate-account guard: is any of these accounts already connected under
    // a different Item? Linking the same account twice would double-pull its
    // history (different ids → the unique-id guard can't catch it).
    const { detectDuplicateAccounts } = await import("@/lib/plaid/data");
    const duplicateAccounts = await detectDuplicateAccounts(
      institutionId,
      accountsResp.data.accounts,
      item.id
    );

    // Initial sync (best-effort — Link succeeded regardless).
    let synced: { added: number; modified: number; removed: number } | null =
      null;
    try {
      const { syncItemTransactions } = await import("@/lib/plaid/sync");
      const fresh = await db
        .select()
        .from(bkPlaidItems)
        .where(eq(bkPlaidItems.id, item.id));
      if (fresh[0]) synced = await syncItemTransactions(fresh[0]);
    } catch {
      // transactions may not be ready yet; the Sync button will pull them
    }

    // Whatever the initial sync re-delivered of the replaced connection's
    // already-posted window, hide it now (later syncs reconcile via the cron
    // and the auto-poster's own leading reconcile pass).
    if (migration.entityIds.length) {
      await reconcileEntitiesAfterReplace(migration.entityIds);
    }

    return NextResponse.json({
      ok: true,
      itemId: item.id,
      institutionName,
      accounts: accountsResp.data.accounts.length,
      duplicateAccounts, // [] unless this bank/account is already connected
      restoredAssignments: migration.migrated, // >0 on a replace re-link
      synced,
    });
  } catch (err) {
    console.error("plaid/exchange:", err);
    return NextResponse.json(
      { error: "Could not link bank connection" },
      { status: 500 }
    );
  }
}
