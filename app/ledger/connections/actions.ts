"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { getPlaid } from "@/lib/plaid/client";
import { decryptToken } from "@/lib/plaid/crypto";
import {
  assignPlaidAccount,
  parseAssignmentValue,
  settleAssignedEntity,
} from "@/lib/plaid/assign";
import { assertAdmin } from "@/lib/ledger/access";
import { suggestAccountMappings, type SuggestResult } from "@/lib/plaid/suggest";

const { bkPlaidItems, bkPlaidAccounts, bkPlaidTransactions } = schema;

function revalidateAssignment(entityId: string | null) {
  revalidatePath("/ledger/connections");
  if (entityId) revalidatePath(`/ledger/${entityId}/bank`);
}

/**
 * Assign (or unassign) one Plaid bank account to an entity + a ledger account,
 * in a single step. The form value is "" (unassign) or "<entityId>:<ledgerId>"
 * — selecting it sets both the account's entity AND the ledger account it posts
 * to. Parsing and the entity↔account pairing validation live in
 * lib/plaid/assign.ts (tested); malformed values throw instead of unassigning.
 */
export async function assignAccount(formData: FormData) {
  await assertAdmin();
  const plaidAccountRowId = String(formData.get("plaidAccountRowId"));
  const { entityId, mappedAccountId } = parseAssignmentValue(
    String(formData.get("assignment") ?? "")
  );
  await assignPlaidAccount(plaidAccountRowId, entityId, mappedAccountId);
  // Reconcile + auto-post AFTER the response — a first sync's ~400 pending
  // txns took longer than the action timeout when run inline.
  if (entityId) after(() => settleAssignedEntity(entityId));
  revalidateAssignment(entityId);
}

/**
 * Ask Opus 4.8 to propose entity + ledger-account mappings for every currently
 * unassigned Plaid account. Read-only — writes nothing; the user confirms each
 * proposal via applySuggestion.
 */
export async function suggestMappings(): Promise<SuggestResult> {
  await assertAdmin();
  return suggestAccountMappings();
}

/**
 * Confirm one AI suggestion: route the Plaid account to the suggested entity +
 * ledger account. Same write path as the manual dropdown.
 */
export async function applySuggestion(
  plaidAccountRowId: string,
  entityId: string,
  accountId: string
) {
  await assertAdmin();
  if (!plaidAccountRowId || !entityId || !accountId) return;
  await assignPlaidAccount(plaidAccountRowId, entityId, accountId);
  after(() => settleAssignedEntity(entityId));
  revalidateAssignment(entityId);
}

/**
 * Disconnect a linked bank (Plaid Item) — e.g. the wrong login was connected.
 * Tells Plaid to remove the Item (stops the ~$0.30/account/mo billing and
 * invalidates the access token), then deletes the Item locally. Its accounts
 * cascade-delete (FK onDelete: cascade) and we explicitly clear the staged
 * transactions those accounts left in the review inbox.
 *
 * Guard: refuses if any of the Item's transactions have already been POSTED to
 * a journal — those are real books. The admin must un-post them first, so we
 * never silently orphan a journal entry. (The wrong-login case has nothing
 * posted, so it disconnects cleanly.)
 */
export async function removeConnection(
  itemId: string
): Promise<{ ok: boolean; error?: string }> {
  await assertAdmin();
  if (!itemId) return { ok: false, error: "Missing connection id" };

  const [item] = await db
    .select()
    .from(bkPlaidItems)
    .where(eq(bkPlaidItems.id, itemId));
  if (!item) return { ok: false, error: "Connection not found" };

  const accounts = await db
    .select({ plaidAccountId: bkPlaidAccounts.plaidAccountId })
    .from(bkPlaidAccounts)
    .where(eq(bkPlaidAccounts.itemId, itemId));
  const plaidAccountIds = accounts.map((a) => a.plaidAccountId);

  // Don't destroy books: block if any txn from this Item is already posted.
  if (plaidAccountIds.length) {
    const posted = await db
      .select({ id: bkPlaidTransactions.id })
      .from(bkPlaidTransactions)
      .where(
        and(
          inArray(bkPlaidTransactions.plaidAccountId, plaidAccountIds),
          eq(bkPlaidTransactions.status, "posted")
        )
      )
      .limit(1);
    if (posted.length) {
      return {
        ok: false,
        error:
          "This bank has transactions already posted to a journal. Un-post them on the entity's Bank tab before disconnecting.",
      };
    }
  }

  // Best-effort: tell Plaid to drop the Item (stops billing). Tolerate failure
  // (already removed, transient) — we still clean up our side either way.
  try {
    await getPlaid().itemRemove({
      access_token: decryptToken(item.accessToken),
    });
  } catch {
    // Swallow — the local delete below is what the user sees, and a stale Item
    // on Plaid's side stops billing once we never call it again.
  }

  // Clear staged inbox rows for these accounts (no FK to cascade them), then
  // delete the Item — bk_plaid_accounts cascade-delete with it.
  if (plaidAccountIds.length) {
    await db
      .delete(bkPlaidTransactions)
      .where(inArray(bkPlaidTransactions.plaidAccountId, plaidAccountIds));
  }
  await db.delete(bkPlaidItems).where(eq(bkPlaidItems.id, itemId));

  revalidatePath("/ledger/connections");
  return { ok: true };
}

/**
 * Retire a connection so the SAME bank can be re-linked with full 24-month
 * history. Plaid locks days_requested once Transactions initializes on an Item,
 * so deepening history requires a NEW Item — this tombstones the old one
 * (assignments kept as the migration map, posted rows kept for provenance,
 * Plaid-side Item removed) and the next fresh link of the same institution
 * auto-restores every account assignment. See lib/plaid/replace.ts.
 */
export async function replaceConnection(
  itemId: string
): Promise<{ ok: boolean; error?: string }> {
  await assertAdmin();
  if (!itemId) return { ok: false, error: "Missing connection id" };
  const { markItemReplaced } = await import("@/lib/plaid/replace");
  const res = await markItemReplaced(itemId);
  revalidatePath("/ledger/connections");
  return res;
}

