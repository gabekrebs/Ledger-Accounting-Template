"use server";

import { revalidatePath } from "next/cache";
import { and, asc, eq, isNotNull } from "drizzle-orm";
import { assertEntityAccess } from "@/lib/ledger/access";
import { getCurrentUser } from "@/lib/supabase/auth-server";
import { db, schema } from "@/lib/db/client";

const { bkJournalEntries, bkJournalLines } = schema;
import {
  createManualEntry,
  deleteManualEntry,
  type ManualLineInput,
} from "@/lib/ledger/manual-entry";
import { listPostableAccounts } from "@/lib/plaid/data";
import type { CategoryOption } from "../actions";

/**
 * Server actions for the manual journal-entry composer (New entry on the
 * Transactions tab) and manual-entry deletion (offered inside the edit panel).
 */

export interface ManualEntryFormData {
  accounts: CategoryOption[];
  /** Locations already in use on this entity's lines — powers the By Address datalist. */
  locations: string[];
}

/** Accounts + in-use locations for the composer, loaded lazily on open. */
export async function loadManualEntryForm(
  entityId: string
): Promise<ManualEntryFormData> {
  await assertEntityAccess(entityId);
  const [accounts, locRows] = await Promise.all([
    listPostableAccounts(entityId),
    db
      .selectDistinct({ location: bkJournalLines.location })
      .from(bkJournalLines)
      .innerJoin(bkJournalEntries, eq(bkJournalEntries.id, bkJournalLines.entryId))
      .where(
        and(
          eq(bkJournalEntries.entityId, entityId),
          isNotNull(bkJournalLines.location)
        )
      )
      .orderBy(asc(bkJournalLines.location)),
  ]);
  return {
    accounts: accounts.map((a) => ({
      id: a.id,
      label: a.fullyQualifiedName ?? a.name ?? "",
      classification: a.classification,
    })),
    locations: locRows.flatMap((r) => (r.location ? [r.location] : [])),
  };
}

export async function createManualEntryAction(input: {
  entityId: string;
  txnDate: string;
  name?: string | null;
  memo?: string | null;
  docNum?: string | null;
  lines: ManualLineInput[];
}): Promise<{ ok: boolean; entryId?: string; error?: string }> {
  await assertEntityAccess(input.entityId);
  const user = await getCurrentUser();
  try {
    const { entryId } = await createManualEntry({
      ...input,
      createdBy: user?.email ?? null,
    });
    revalidateEntity(input.entityId);
    return { ok: true, entryId };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function deleteManualEntryAction(input: {
  entityId: string;
  entryId: string;
}): Promise<{ ok: boolean; error?: string }> {
  await assertEntityAccess(input.entityId);
  try {
    await deleteManualEntry(input.entityId, input.entryId);
    revalidateEntity(input.entityId);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Refresh every ledger view a journal write can move. */
function revalidateEntity(entityId: string) {
  const base = `/ledger/${entityId}`;
  for (const p of ["", "/pl", "/pl/detail", "/transactions", "/bs", "/by-address", "/accounts"]) {
    revalidatePath(`${base}${p}`);
  }
  revalidatePath(`${base}/gl/[accountId]`, "page");
}
