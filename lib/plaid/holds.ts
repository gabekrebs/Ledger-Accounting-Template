import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";

const { bkReviewHolds } = schema;

/**
 * Owner heads-up holds — the "I know an anomaly is coming" flag. Matching is
 * PURE and deterministic (no AI, no credits): exact |amount| equality and/or
 * case-insensitive vendor substring against the descriptor + merchant name.
 * All provided criteria must match. The auto-poster checks holds FIRST, so a
 * matched transaction skips recognizers, rules, and AI and waits in review.
 */

export interface HoldCriteria {
  /** Exact |amount| when amountMaxCents is null; else inclusive lower bound. */
  amountCents: number | null;
  amountMaxCents: number | null;
  vendorText: string | null;
}

export function holdMatches(
  h: HoldCriteria,
  t: { name: string | null; merchantName: string | null; amountCents: number }
): boolean {
  if (h.amountCents == null && !h.vendorText?.trim()) return false; // never match a criterion-less hold
  if (h.amountCents != null) {
    const amt = Math.abs(t.amountCents);
    if (h.amountMaxCents != null) {
      if (amt < Math.abs(h.amountCents) || amt > Math.abs(h.amountMaxCents)) return false;
    } else if (amt !== Math.abs(h.amountCents)) {
      return false;
    }
  }
  if (h.vendorText?.trim()) {
    const hay = `${t.name ?? ""} ${t.merchantName ?? ""}`.toLowerCase();
    if (!hay.includes(h.vendorText.trim().toLowerCase())) return false;
  }
  return true;
}

export type InterceptingHold = typeof bkReviewHolds.$inferSelect;

/** Holds still intercepting for an entity: unacknowledged and inside their
 * window. (Expired-unacknowledged holds stay visible in the UI but stop
 * intercepting — expiry is a time limit on automation override, not on the
 * owner's follow-up.) */
export async function loadInterceptingHolds(entityId: string): Promise<InterceptingHold[]> {
  return db
    .select()
    .from(bkReviewHolds)
    .where(
      and(
        eq(bkReviewHolds.entityId, entityId),
        isNull(bkReviewHolds.acknowledgedAt),
        gt(bkReviewHolds.expiresAt, new Date())
      )
    );
}

/** Stamp a match. The sweep re-examines pending rows every pass, so the same
 * txn re-matching must not inflate the count — only a NEW txn increments. */
export async function recordHoldMatch(holdId: string, txnId: string): Promise<void> {
  await db
    .update(bkReviewHolds)
    .set({
      matchCount: sql`CASE WHEN ${bkReviewHolds.lastMatchedTxnId} IS NOT DISTINCT FROM ${txnId} THEN ${bkReviewHolds.matchCount} ELSE ${bkReviewHolds.matchCount} + 1 END`,
      lastMatchedTxnId: txnId,
      lastMatchedAt: new Date(),
    })
    .where(eq(bkReviewHolds.id, holdId));
}
