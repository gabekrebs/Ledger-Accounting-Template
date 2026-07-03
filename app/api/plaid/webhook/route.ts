import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { and, eq, isNotNull } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { syncItemTransactions } from "@/lib/plaid/sync";
import { autoPostEntity } from "@/lib/plaid/auto-post";
import { isAuthorizedPlaidWebhook } from "@/lib/security/machine-auth";

export const runtime = "nodejs";
export const maxDuration = 120;

const { bkPlaidItems, bkPlaidAccounts } = schema;

/**
 * Best-effort per-entity debounce for the webhook-triggered auto-post. Plaid
 * often fires several transaction webhooks in a burst (INITIAL / HISTORICAL /
 * SYNC_UPDATES_AVAILABLE); the poster is idempotent and FOR-UPDATE-guarded, so
 * concurrent runs are SAFE — this only avoids wasted work within a warm
 * lambda. (Module state doesn't survive cold starts or span instances; that's
 * fine, it's an optimization, not a lock.)
 */
const lastAutoPostAt = new Map<string, number>();
const AUTO_POST_DEBOUNCE_MS = 20_000;
function shouldAutoPost(entityId: string): boolean {
  const now = Date.now();
  if (now - (lastAutoPostAt.get(entityId) ?? 0) < AUTO_POST_DEBOUNCE_MS) return false;
  lastAutoPostAt.set(entityId, now);
  return true;
}

/**
 * Plaid webhook receiver — the real-time trigger that backfills a freshly linked
 * bank the moment Plaid finishes pulling its history.
 *
 * Why this exists: /transactions/sync returns EMPTY for the first minutes after a
 * link (Plaid extracts asynchronously), so the link-time sync pulls nothing and,
 * without this, the staging inbox stays empty until someone clicks "Sync all".
 * Plaid POSTs a TRANSACTIONS / SYNC_UPDATES_AVAILABLE webhook when data is ready
 * (and on every later update); we react by pulling the delta for that Item.
 *
 * Auth: the receiver is gated by the dedicated PLAID_WEBHOOK_SECRET token in
 * the query string (set on the per-Item webhook URL at link time — see
 * plaidWebhookUrl()). Fail-closed: an unset/blank secret rejects every call.
 * The secret is webhook-only — CRON_SECRET authorizes only /api/cron/* and
 * never rides in a URL registered with a third party. Full Plaid JWT
 * verification (Plaid-Verification header + /webhook_verification_key/get) is
 * the recommended follow-up; the blast radius here is small — the endpoint only
 * triggers an idempotent sync of an Item we already own and returns no data.
 *
 * Acks 200 fast; the sync runs in after() so Plaid's delivery doesn't time out
 * (Plaid retries non-2xx, which our idempotent upsert tolerates).
 */
export async function POST(request: NextRequest) {
  if (!isAuthorizedPlaidWebhook(request.nextUrl.searchParams.get("token"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: {
    webhook_type?: string;
    webhook_code?: string;
    item_id?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { webhook_type, webhook_code, item_id } = body;

  // Only transaction updates drive a pull. SYNC_UPDATES_AVAILABLE is the modern
  // /transactions/sync signal; the *_UPDATE codes are the legacy equivalents.
  const TXN_CODES = new Set([
    "SYNC_UPDATES_AVAILABLE",
    "INITIAL_UPDATE",
    "HISTORICAL_UPDATE",
    "DEFAULT_UPDATE",
  ]);
  if (webhook_type !== "TRANSACTIONS" || !webhook_code || !TXN_CODES.has(webhook_code)) {
    // Ack other webhook types (ITEM errors, etc.) so Plaid stops retrying.
    return NextResponse.json({ ok: true, ignored: webhook_type ?? "unknown" });
  }
  if (!item_id) {
    return NextResponse.json({ error: "item_id required" }, { status: 400 });
  }

  // Resolve to one of OUR Items; ignore anything we don't recognize.
  const items = await db
    .select()
    .from(bkPlaidItems)
    .where(eq(bkPlaidItems.plaidItemId, item_id));
  const item = items[0];
  if (!item) {
    return NextResponse.json({ ok: true, ignored: "unknown item_id" });
  }
  if (item.status === "replaced") {
    // Tombstone — the connection was replaced by a fresh link; Plaid-side
    // removal may still flush a late webhook or two.
    return NextResponse.json({ ok: true, ignored: "replaced item" });
  }

  after(async () => {
    try {
      const counts = await syncItemTransactions(item);
      console.log(
        `plaid/webhook: ${webhook_code} item=${item.id} ` +
          `added=${counts.added} modified=${counts.modified} removed=${counts.removed}`
      );
    } catch (e) {
      // syncItemTransactions already records status=error + lastError on the Item.
      console.error(`plaid/webhook: sync failed for item=${item.id}:`, e);
    }

    // H1: real-time categorization (TODO H1 / ADR-011). Run the deterministic
    // auto-poster for each entity this Item's accounts feed, RIGHT AFTER the
    // sync that just delivered their transactions — recognizers + auto_apply
    // rules only, no AI cost (the Batch-API submit stays on the daily cron).
    // Deliberately isolated: an auto-post failure must never affect the ack
    // (already sent) or poison the sync; the daily sweep remains the backstop.
    try {
      const assigned = await db
        .selectDistinct({ entityId: bkPlaidAccounts.entityId })
        .from(bkPlaidAccounts)
        .where(
          and(eq(bkPlaidAccounts.itemId, item.id), isNotNull(bkPlaidAccounts.entityId))
        );
      for (const { entityId } of assigned) {
        if (!entityId || !shouldAutoPost(entityId)) continue;
        const r = await autoPostEntity(entityId);
        if (r.posted || r.errors) {
          console.log(
            `plaid/webhook: auto-post entity=${entityId} posted=${r.posted} ` +
              `skippedDup=${r.skippedDup} errors=${r.errors}`
          );
        }
      }
    } catch (e) {
      console.error(`plaid/webhook: auto-post failed for item=${item.id}:`, e);
    }
  });

  return NextResponse.json({ ok: true, syncing: item.id });
}
