import { NextRequest, NextResponse } from "next/server";
import { syncEntityTransactions, syncAllItems } from "@/lib/plaid/sync";
import { safePlaidError } from "@/lib/plaid/client";
import { currentUserIsOwner } from "@/lib/ledger/access";
import { limitRoute } from "@/lib/security/rate-limit";
import { actionIdentity } from "@/lib/security/rate-limit-identity";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * Pull the latest bank transactions into the staging inbox.
 * POST /api/plaid/sync  { entityId? }
 *
 * With entityId → sync the connections holding any account assigned to that
 * entity (the per-entity Bank tab). Without → sync every connection (the global
 * Bank connections "Sync now").
 *
 * OWNER-ONLY either way: manual sync is a system operation against shared bank
 * connections (Plaid API cost, cross-entity side effects), not bookkeeping —
 * accountants and partners review/categorize but never trigger the feed. The
 * webhook + daily cron keep data fresh without anyone clicking.
 */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const entityId: string | undefined = body?.entityId;
  if (!(await currentUserIsOwner())) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const limited = await limitRoute("manualSync", await actionIdentity());
  if (limited) return limited;
  try {
    const results = entityId
      ? await syncEntityTransactions(entityId)
      : await syncAllItems();
    const totals = results.reduce(
      (acc, r) => ({
        added: acc.added + r.added,
        modified: acc.modified + r.modified,
        removed: acc.removed + r.removed,
      }),
      { added: 0, modified: 0, removed: 0 }
    );
    return NextResponse.json({ ok: true, items: results.length, totals });
  } catch (err) {
    // Redacted summary only — a raw Plaid AxiosError carries the API secret.
    const message = safePlaidError(err);
    console.error("plaid/sync:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
