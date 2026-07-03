/**
 * Routing a Plaid bank account to an entity + ledger account — the validated
 * write path behind the connections dropdown (assignAccount) and the AI
 * confirm (applySuggestion). Lives in lib (not the server-action module) so
 * the pairing rules are directly unit/regression-testable.
 */
import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { restampPendingForAccount } from "@/lib/plaid/sync";
import { reconcileBookedExactMatches } from "@/lib/plaid/reconcile";
import { autoPostEntity } from "@/lib/plaid/auto-post";

const { bkPlaidAccounts, bkAccounts } = schema;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Parse the dropdown's combined form value. "" (or null) = explicit unassign;
 * otherwise it MUST be "<entityId>:<ledgerId>" — anything else throws rather
 * than being silently treated as an unassign.
 */
export function parseAssignmentValue(
  combined: string | null
): { entityId: string | null; mappedAccountId: string | null } {
  if (!combined) return { entityId: null, mappedAccountId: null };
  const idx = combined.indexOf(":");
  if (idx <= 0 || idx === combined.length - 1) {
    throw new Error("invalid assignment");
  }
  return {
    entityId: combined.slice(0, idx),
    mappedAccountId: combined.slice(idx + 1),
  };
}

/**
 * Route (or unroute) one Plaid bank account. Both ids null = unassign;
 * otherwise the pair is validated TOGETHER, atomically with the write: the
 * mapped ledger account must exist, be active, belong to exactly the selected
 * entity, and be asset/liability classified (mirroring listAssignTargets — a
 * submitted value the dropdown could never produce is rejected, not written).
 * Re-stamps the account's pending txns onto the new entity, hides
 * QBO/Wave-already-booked lines, and stops the nightly QB import for that
 * entity (Plaid now owns going-forward txns). Posted history is untouched.
 */
export async function assignPlaidAccount(
  plaidAccountRowId: string,
  entityId: string | null,
  mappedAccountId: string | null
): Promise<void> {
  // Assignment is all-or-nothing: entity and ledger account come as a pair.
  if ((entityId === null) !== (mappedAccountId === null)) {
    throw new Error("invalid assignment");
  }
  if (!UUID_RE.test(plaidAccountRowId)) throw new Error("invalid assignment");
  if (entityId !== null && (!UUID_RE.test(entityId) || !UUID_RE.test(mappedAccountId!))) {
    throw new Error("invalid assignment");
  }

  // Validate + write in ONE transaction so the pairing check and the update
  // can't interleave with a concurrent re-assignment.
  const acct = await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ plaidAccountId: bkPlaidAccounts.plaidAccountId })
      .from(bkPlaidAccounts)
      .where(eq(bkPlaidAccounts.id, plaidAccountRowId))
      .for("update");
    if (!row) throw new Error("bank account not found");

    if (entityId !== null && mappedAccountId !== null) {
      const [ledger] = await tx
        .select({ id: bkAccounts.id })
        .from(bkAccounts)
        .where(
          and(
            eq(bkAccounts.id, mappedAccountId),
            eq(bkAccounts.entityId, entityId), // the account must be THIS entity's
            eq(bkAccounts.active, true),
            inArray(bkAccounts.classification, ["asset", "liability"])
          )
        );
      // Generic message — doesn't reveal whether the id exists on another entity.
      if (!ledger) throw new Error("ledger account not found for that entity");
    }

    await tx
      .update(bkPlaidAccounts)
      .set({ entityId, mappedAccountId, updatedAt: new Date() })
      .where(eq(bkPlaidAccounts.id, plaidAccountRowId));
    return row;
  });

  await restampPendingForAccount(acct.plaidAccountId, entityId);
  // The slow follow-up (reconcile + auto-post) is deliberately NOT run here:
  // a first sync delivers hundreds of pending transactions, and doing that
  // work inline made the assignment server action exceed its timeout — the
  // UI's Confirm button hung at "Linking…" forever. Callers run
  // settleAssignedEntity() in after() so the response returns immediately.
}

/**
 * Post-assignment settlement: hide already-imported lines, then run the
 * auto-poster over the freshly-routed inbox. Assignment is the moment an
 * account's transactions become postable — without this they'd wait for the
 * next webhook or the daily sweep while every rule visibly "matches" in
 * Review. Idempotent and isolated; server actions run it via after() so a
 * big first sync can't block (or time out) the assignment response.
 */
export async function settleAssignedEntity(entityId: string): Promise<void> {
  try {
    await reconcileBookedExactMatches(entityId);
    const r = await autoPostEntity(entityId);
    if (r.posted || r.errors) {
      console.log(
        `assign: auto-post entity=${entityId} posted=${r.posted} ` +
          `skippedDup=${r.skippedDup} errors=${r.errors}`
      );
    }
  } catch (e) {
    console.error(`assign: settlement failed for entity=${entityId}:`, e);
  }
}
