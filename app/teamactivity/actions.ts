"use server";

import { revalidatePath } from "next/cache";
import { assertAdmin } from "@/lib/ledger/access";
import { getCurrentUser } from "@/lib/supabase/auth-server";
import { markReviewed, markEntityReviewed } from "@/lib/ledger/audit-review";

/** Toggle a single audit-log row's reviewed flag. Admin-only. */
export async function markReviewedAction(id: string, reviewed: boolean) {
  await assertAdmin();
  const me = await getCurrentUser();
  await markReviewed(id, me?.email?.toLowerCase() ?? null, reviewed);
  revalidatePath("/teamactivity");
  revalidatePath("/");
}

/** Mark every unreviewed row for one entity reviewed. Admin-only. */
export async function markEntityReviewedAction(entityId: string) {
  await assertAdmin();
  const me = await getCurrentUser();
  await markEntityReviewed(entityId, me?.email?.toLowerCase() ?? null);
  revalidatePath("/teamactivity");
  revalidatePath("/");
}
