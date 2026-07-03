import { NextRequest, NextResponse } from "next/server";
import { syncEntityTransactions, syncAllItems } from "@/lib/plaid/sync";
import { canAccessEntity, currentUserIsAdmin } from "@/lib/ledger/access";
import { getCurrentUser } from "@/lib/supabase/auth-server";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * Pull the latest bank transactions into the staging inbox.
 * POST /api/plaid/sync  { entityId? }
 *
 * With entityId → sync the connections holding any account assigned to that
 * entity (the per-entity Bank tab). Without → sync every connection (the global
 * Bank connections "Sync now"). The nightly ledger cron can call syncAllItems()
 * directly once we trust the feed.
 */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const entityId: string | undefined = body?.entityId;
  // Per-entity sync: must have access to that entity. Global sync: admin only.
  if (entityId) {
    const user = await getCurrentUser();
    if (!(await canAccessEntity(user?.email, entityId))) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  } else if (!(await currentUserIsAdmin())) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
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
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
