import { db, type DbOrTx } from "@/lib/db/client";
import { bkAuditLog } from "@/lib/db/schema";
import { getCurrentUser } from "@/lib/supabase/auth-server";
import { getAppUser, isAdmin } from "@/lib/ledger/access";

/**
 * The admin review log writer. Every meaningful WRITE by a non-admin user is
 * recorded for the owner to review (see `bk_audit_log`). Owner/admin actions are
 * deliberately NOT logged — the owner is the reviewer, not the reviewed.
 *
 * Placement: call this from a WRITE server action AFTER the mutation, so the log
 * reflects a change that actually happened. Capture `before`/`after` where cheap
 * (e.g. a category change); leave them null when there's no prior state.
 */
export interface AuditInput {
  entityId: string;
  /** Stable machine key, e.g. 'post_transaction', 'upload_document'. */
  actionType: string;
  /** The table the change lands in, e.g. 'bk_journal_entries'. */
  objectTable?: string | null;
  objectId?: string | null;
  /** Short human-readable summary for the review feed. */
  description: string;
  before?: unknown;
  after?: unknown;
  /** True when this touched the double-entry journal (helps triage review). */
  affectedLedger?: boolean;
}

/**
 * Record a non-admin write. NO-OP for owner/admin.
 *
 * Durability: BEST-EFFORT by default — a failed log is swallowed to the server
 * console and never rolls back a completed write. Pass a transaction handle as
 * `exec` (i.e. from inside a `db.transaction`) to make the log commit ATOMICALLY
 * with the write — there a log failure DOES roll the write back. Journal posts
 * use the atomic form so a ledger change and its audit entry are all-or-nothing.
 */
export async function logAudit(input: AuditInput, exec: DbOrTx = db): Promise<void> {
  const user = await getCurrentUser();
  const email = user?.email;
  if (!email) return; // no authenticated actor → nothing to attribute
  if (await isAdmin(email)) return; // owner/admin actions are not reviewed

  const row = await getAppUser(email);
  const values = {
    actorEmail: email.toLowerCase(),
    actorRole: row?.role ?? "business_partner",
    entityId: input.entityId,
    actionType: input.actionType,
    objectTable: input.objectTable ?? null,
    objectId: input.objectId ?? null,
    description: input.description,
    beforeJson: input.before ?? null,
    afterJson: input.after ?? null,
    affectedLedger: input.affectedLedger ?? false,
  };

  if (exec !== db) {
    // Atomic path: inside the caller's transaction — let failures propagate so
    // the whole write rolls back rather than committing an unlogged change.
    await exec.insert(bkAuditLog).values(values);
    return;
  }
  try {
    await db.insert(bkAuditLog).values(values);
  } catch (e) {
    console.error(`[audit] failed to record ${input.actionType}`, e);
  }
}
