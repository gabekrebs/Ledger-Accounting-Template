import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { and, eq, isNotNull } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { syncItemTransactions } from "@/lib/plaid/sync";
import { autoPostEntity } from "@/lib/plaid/auto-post";
import { isAuthorizedPlaidWebhook } from "@/lib/security/machine-auth";
import { verifyPlaidWebhook, type WebhookVerifyResult } from "@/lib/plaid/webhook-verify";
import { safePlaidError } from "@/lib/plaid/client";
import { limitRoute, clientIp } from "@/lib/security/rate-limit";

export const runtime = "nodejs";
// 300s is the Hobby-plan (fluid compute) ceiling. One Chase login feeds ~20
// entities, and the post-sync auto-post loop below runs INSIDE this budget —
// at 120s it repeatedly died mid-portfolio, leaving the tail entities'
// transactions uncategorized until the next day's cron.
export const maxDuration = 300;

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
 * Auth: three layers, in order below — (1) a per-IP abuse cap, (2) the
 * dedicated PLAID_WEBHOOK_SECRET token in the query string (set on the
 * per-Item webhook URL at link time — see plaidWebhookUrl(); fail-closed: an
 * unset/blank secret rejects every call), and (3) official Plaid JWT
 * verification (Plaid-Verification header + /webhook_verification_key/get),
 * staged via PLAID_WEBHOOK_VERIFY = off | log | enforce. The secret is
 * webhook-only — CRON_SECRET authorizes only /api/cron/* and never rides in a
 * URL registered with a third party. Blast radius is small either way: the
 * endpoint only triggers an idempotent sync of an Item we already own and
 * returns no data.
 *
 * Acks 200 fast; the sync runs in after() so Plaid's delivery doesn't time out
 * (Plaid retries non-2xx, which our idempotent upsert tolerates).
 */
export async function POST(request: NextRequest) {
  // (1) Cheap pre-verification abuse cap on the TRUSTED client IP — never on
  // item_id, which is attacker-controllable before verification. Generous and
  // fail-open, so legitimate Plaid bursts/retries are never throttled.
  const limited = await limitRoute("webhookAbuse", `ip:${clientIp(request.headers)}`);
  if (limited) return limited;

  // (2) Belt-and-braces shared-secret gate (fail-closed; unchanged).
  if (!isAuthorizedPlaidWebhook(request.nextUrl.searchParams.get("token"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Read the RAW body ONCE. The JWT body-hash is over these exact bytes, and we
  // only JSON.parse AFTER verification — no downstream work on unverified input.
  const raw = await request.text();

  // (3) Official Plaid JWT verification, gated by PLAID_WEBHOOK_VERIFY:
  //   off     → skip (default; preserves prior behavior)
  //   log     → verify + record the reason category, but still accept
  //   enforce → reject unverified webhooks with a generic 401
  // Runs BEFORE the DB lookup below. Never logs the JWT/body/secret/claims.
  const mode = (process.env.PLAID_WEBHOOK_VERIFY ?? "off").toLowerCase();
  if (mode === "log" || mode === "enforce") {
    let v: WebhookVerifyResult;
    try {
      v = await verifyPlaidWebhook(request.headers.get("plaid-verification"), raw);
    } catch {
      // The verifier is internally fail-safe, but never let an unexpected error
      // here disrupt delivery — treat it as a failure category, don't crash.
      v = { ok: false, reason: "invalid_signature" };
    }
    if (v.ok) {
      // Positive confirmation so log-mode observation is unambiguous before enforce.
      if (mode === "log") console.log("plaid/webhook: verification passed (log mode)");
    } else {
      console.warn(`plaid/webhook: verification failed reason=${v.reason} mode=${mode}`);
      if (mode === "enforce") {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
    }
  }

  // (4) Parse JSON from the already-read raw body.
  let body: {
    webhook_type?: string;
    webhook_code?: string;
    item_id?: string;
  };
  try {
    body = JSON.parse(raw);
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
      console.error(`plaid/webhook: sync failed for item=${item.id}:`, safePlaidError(e));
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
      // Shuffle: if the function times out mid-loop, a fixed order starves the
      // SAME tail entities on every run. Random order + idempotent poster means
      // repeated webhooks/crons converge on full coverage instead.
      for (let i = assigned.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [assigned[i], assigned[j]] = [assigned[j], assigned[i]];
      }
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
