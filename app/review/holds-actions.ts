"use server";

import { and, eq, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db, schema } from "@/lib/db/client";
import { assertEntityWrite } from "@/lib/ledger/access";
import { getCurrentUser } from "@/lib/supabase/auth-server";

const { bkReviewHolds } = schema;

/** Server actions for review-queue heads-up holds. Every mutation re-asserts
 * per-entity WRITE access — same authorization story as the queue itself. */

type Result = { ok: boolean; error?: string };
const fail = (e: unknown): Result => ({ ok: false, error: e instanceof Error ? e.message : String(e) });

export async function createHold(input: {
  entityId: string;
  amountCents: number | null;
  amountMaxCents: number | null;
  vendorText: string;
  note: string;
  days: number;
}): Promise<Result> {
  try {
    await assertEntityWrite(input.entityId);
    const user = await getCurrentUser();
    const vendor = input.vendorText.trim();
    if (input.amountCents == null && !vendor) {
      throw new Error("give an amount (or range), a vendor, or both");
    }
    if (input.amountCents != null && (!Number.isInteger(input.amountCents) || input.amountCents <= 0)) {
      throw new Error("amount must be a positive dollar figure");
    }
    if (input.amountMaxCents != null) {
      if (input.amountCents == null) throw new Error("a range needs a lower bound");
      if (!Number.isInteger(input.amountMaxCents) || input.amountMaxCents <= input.amountCents) {
        throw new Error("range max must be greater than the min");
      }
    }
    if (input.days !== 7 && input.days !== 30) {
      throw new Error("watch window is 7 or 30 days");
    }
    await db.insert(bkReviewHolds).values({
      entityId: input.entityId,
      amountCents: input.amountCents,
      amountMaxCents: input.amountMaxCents,
      vendorText: vendor || null,
      note: input.note.trim() || null,
      expiresAt: new Date(Date.now() + input.days * 86_400_000),
      createdBy: user?.email ?? null,
    });
    revalidatePath("/review");
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/** Close a hold — "transaction found" / "resolved". The only way a hold ever
 * leaves the list, so nothing falls through the cracks. */
export async function acknowledgeHold(holdId: string): Promise<Result> {
  try {
    const [hold] = await db
      .select({ entityId: bkReviewHolds.entityId })
      .from(bkReviewHolds)
      .where(and(eq(bkReviewHolds.id, holdId), isNull(bkReviewHolds.acknowledgedAt)));
    if (!hold) throw new Error("hold not found (or already closed)");
    await assertEntityWrite(hold.entityId);
    const user = await getCurrentUser();
    await db
      .update(bkReviewHolds)
      .set({ acknowledgedAt: new Date(), acknowledgedBy: user?.email ?? null })
      .where(eq(bkReviewHolds.id, holdId));
    revalidatePath("/review");
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}
