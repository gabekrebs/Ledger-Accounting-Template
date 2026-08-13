import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { bkAuditLog, bkLedgerEntities } from "@/lib/db/schema";

/**
 * Read + review side of the admin review log (write side is lib/ledger/audit.ts).
 * All callers must be admin-gated (assertAdmin) — these functions do NOT check
 * authorization themselves.
 */

export interface AuditRow {
  id: string;
  actorEmail: string;
  actorRole: string;
  entityId: string;
  entityName: string | null;
  actionType: string;
  objectTable: string | null;
  objectId: string | null;
  description: string;
  affectedLedger: boolean;
  createdAt: Date | null;
  reviewed: boolean;
  reviewedAt: Date | null;
  reviewedBy: string | null;
}

export interface EntityGroup {
  entityId: string;
  entityName: string | null;
  rows: AuditRow[];
}

const COLS = {
  id: bkAuditLog.id,
  actorEmail: bkAuditLog.actorEmail,
  actorRole: bkAuditLog.actorRole,
  entityId: bkAuditLog.entityId,
  entityName: bkLedgerEntities.name,
  actionType: bkAuditLog.actionType,
  objectTable: bkAuditLog.objectTable,
  objectId: bkAuditLog.objectId,
  description: bkAuditLog.description,
  affectedLedger: bkAuditLog.affectedLedger,
  createdAt: bkAuditLog.createdAt,
  reviewed: bkAuditLog.reviewed,
  reviewedAt: bkAuditLog.reviewedAt,
  reviewedBy: bkAuditLog.reviewedBy,
};

/** Count of unreviewed log entries — powers the home-page notification badge. */
export async function unreviewedCount(): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(bkAuditLog)
    .where(eq(bkAuditLog.reviewed, false));
  return row?.n ?? 0;
}

/** Unreviewed entries grouped by entity, newest first within each group. */
export async function unreviewedByEntity(): Promise<EntityGroup[]> {
  const rows = await db
    .select(COLS)
    .from(bkAuditLog)
    .leftJoin(bkLedgerEntities, eq(bkLedgerEntities.id, bkAuditLog.entityId))
    .where(eq(bkAuditLog.reviewed, false))
    .orderBy(desc(bkAuditLog.createdAt));
  return groupByEntity(rows);
}

/** Recently reviewed history (for the "show all" view). */
export async function reviewedHistory(limit = 200): Promise<AuditRow[]> {
  return db
    .select(COLS)
    .from(bkAuditLog)
    .leftJoin(bkLedgerEntities, eq(bkLedgerEntities.id, bkAuditLog.entityId))
    .where(eq(bkAuditLog.reviewed, true))
    .orderBy(desc(bkAuditLog.reviewedAt))
    .limit(limit);
}

function groupByEntity(rows: AuditRow[]): EntityGroup[] {
  const byId = new Map<string, EntityGroup>();
  for (const r of rows) {
    let g = byId.get(r.entityId);
    if (!g) {
      g = { entityId: r.entityId, entityName: r.entityName, rows: [] };
      byId.set(r.entityId, g);
    }
    g.rows.push(r);
  }
  return [...byId.values()].sort((a, b) =>
    (a.entityName ?? "").localeCompare(b.entityName ?? "")
  );
}

/** Mark one log entry reviewed (admin action; caller asserts admin). */
export async function markReviewed(
  id: string,
  reviewedBy: string | null,
  reviewed = true
): Promise<void> {
  await db
    .update(bkAuditLog)
    .set({
      reviewed,
      reviewedAt: reviewed ? new Date() : null,
      reviewedBy: reviewed ? reviewedBy : null,
    })
    .where(eq(bkAuditLog.id, id));
}

/** Mark every currently-unreviewed entry for ONE entity reviewed. */
export async function markEntityReviewed(
  entityId: string,
  reviewedBy: string | null
): Promise<number> {
  const updated = await db
    .update(bkAuditLog)
    .set({ reviewed: true, reviewedAt: new Date(), reviewedBy })
    .where(and(eq(bkAuditLog.entityId, entityId), eq(bkAuditLog.reviewed, false)))
    .returning({ id: bkAuditLog.id });
  return updated.length;
}
