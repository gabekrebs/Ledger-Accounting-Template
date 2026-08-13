import { and, eq, ilike, ne, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { classifyAccountType } from "./accounts";

const { bkAccounts } = schema;

/**
 * In-product chart-of-accounts management — add / rename / retype / deactivate.
 *
 * Every account is editable in-app: the QuickBooks nightly sync (which once
 * owned numeric `qbo_account_id` rows and would have clobbered edits) was
 * removed with the QBO integration — the ids survive only as import lineage.
 *
 * Deactivation requires a $0 balance — money can never be hidden, and a $0
 * debt account still deserves a look before retiring (standing rule: debt is
 * never blind-swept), which is why this is a deliberate per-account action.
 */

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export interface CreateAccountInput {
  entityId: string;
  name: string;
  /** A QBO AccountType (TYPE_MAP key) — classification + normal balance derive from it. */
  accountType: string;
  /** Optional parent — a bk_accounts.id in the same entity + classification. */
  parentId?: string | null;
}

/** Create an in-app account. Allowed on every entity (the sync never deletes). */
export async function createAccount(
  input: CreateAccountInput
): Promise<{ accountId: string; qboAccountId: string }> {
  const name = input.name.trim();
  if (!name) throw new Error("account name is required");
  if (name.includes(":")) {
    throw new Error("account names cannot contain ':' (reserved for sub-account paths)");
  }
  // Derivation throws on an unknown type — same gate the QBO sync uses.
  const { classification, normalBalance } = classifyAccountType(input.accountType);

  return db.transaction(async (tx) => {
    // Duplicate-name guard (case-insensitive) — two "Repairs" accounts is how
    // charts rot. QBO enforces the same.
    const [dup] = await tx
      .select({ id: bkAccounts.id })
      .from(bkAccounts)
      .where(and(eq(bkAccounts.entityId, input.entityId), ilike(bkAccounts.name, name)));
    if (dup) throw new Error(`an account named "${name}" already exists`);

    let parent: { qboAccountId: string; fullyQualifiedName: string | null; name: string } | null =
      null;
    if (input.parentId) {
      const [p] = await tx
        .select({
          qboAccountId: bkAccounts.qboAccountId,
          fullyQualifiedName: bkAccounts.fullyQualifiedName,
          name: bkAccounts.name,
          classification: bkAccounts.classification,
        })
        .from(bkAccounts)
        .where(
          and(eq(bkAccounts.id, input.parentId), eq(bkAccounts.entityId, input.entityId))
        );
      if (!p) throw new Error("parent account not found for this entity");
      if (p.classification !== classification) {
        throw new Error("a sub-account must share its parent's classification");
      }
      parent = p;
    }

    // Synthetic id, `manual:` prefix (slug convention precedent: grossup:/wave:).
    // Suffix on collision so renames/recreates can't trip the unique index.
    const base = `manual:${slugify(name)}`;
    let qboAccountId = base;
    for (let i = 2; ; i++) {
      const [hit] = await tx
        .select({ id: bkAccounts.id })
        .from(bkAccounts)
        .where(
          and(
            eq(bkAccounts.entityId, input.entityId),
            eq(bkAccounts.qboAccountId, qboAccountId)
          )
        );
      if (!hit) break;
      qboAccountId = `${base}-${i}`;
    }

    const fullyQualifiedName = parent
      ? `${parent.fullyQualifiedName ?? parent.name}:${name}`
      : name;

    const [row] = await tx
      .insert(bkAccounts)
      .values({
        entityId: input.entityId,
        qboAccountId,
        name,
        fullyQualifiedName,
        accountType: input.accountType,
        accountSubtype: null,
        parentQboId: parent?.qboAccountId ?? null,
        normalBalance,
        classification,
        active: true,
      })
      .returning({ id: bkAccounts.id });
    return { accountId: row.id, qboAccountId };
  });
}

export interface UpdateAccountInput {
  entityId: string;
  accountId: string;
  name?: string;
  accountType?: string;
}

/**
 * Rename / retype an account. Renames cascade the stored `fullyQualifiedName`
 * to sub-accounts.
 */
export async function updateAccount(input: UpdateAccountInput): Promise<void> {
  await db.transaction(async (tx) => {
    const [acct] = await tx
      .select()
      .from(bkAccounts)
      .where(
        and(eq(bkAccounts.id, input.accountId), eq(bkAccounts.entityId, input.entityId))
      )
      .for("update");
    if (!acct) throw new Error("account not found for this entity");

    const updates: Partial<typeof bkAccounts.$inferInsert> = { updatedAt: new Date() };

    const newName = input.name?.trim();
    if (newName && newName !== acct.name) {
      if (newName.includes(":")) {
        throw new Error("account names cannot contain ':' (reserved for sub-account paths)");
      }
      const [dup] = await tx
        .select({ id: bkAccounts.id })
        .from(bkAccounts)
        .where(
          and(
            eq(bkAccounts.entityId, input.entityId),
            ilike(bkAccounts.name, newName),
            ne(bkAccounts.id, acct.id)
          )
        );
      if (dup) throw new Error(`an account named "${newName}" already exists`);
      updates.name = newName;

      const oldFqn = acct.fullyQualifiedName ?? acct.name;
      const prefix = oldFqn.includes(":")
        ? oldFqn.slice(0, oldFqn.lastIndexOf(":") + 1)
        : "";
      const newFqn = `${prefix}${newName}`;
      updates.fullyQualifiedName = newFqn;

      // Cascade the stored path to descendants ("Old:Child" → "New:Child").
      await tx.execute(sql`
        UPDATE bk_accounts
           SET fully_qualified_name = ${newFqn} || SUBSTRING(fully_qualified_name FROM ${oldFqn.length + 1}),
               updated_at = now()
         WHERE entity_id = ${input.entityId}
           AND fully_qualified_name LIKE ${oldFqn + ":%"}`);
    }

    if (input.accountType && input.accountType !== acct.accountType) {
      const { classification, normalBalance } = classifyAccountType(input.accountType);
      // Changing type re-files history on the statements (that's the point of a
      // correction), but a parent/child must keep one classification.
      if (acct.parentQboId) {
        const [p] = await tx
          .select({ classification: bkAccounts.classification })
          .from(bkAccounts)
          .where(
            and(
              eq(bkAccounts.entityId, input.entityId),
              eq(bkAccounts.qboAccountId, acct.parentQboId)
            )
          );
        if (p && p.classification !== classification) {
          throw new Error("a sub-account must share its parent's classification");
        }
      }
      const [child] = await tx
        .select({ id: bkAccounts.id })
        .from(bkAccounts)
        .where(
          and(
            eq(bkAccounts.entityId, input.entityId),
            eq(bkAccounts.parentQboId, acct.qboAccountId),
            ne(bkAccounts.classification, classification)
          )
        )
        .limit(1);
      if (child) {
        throw new Error("sub-accounts would no longer match — retype them first");
      }
      updates.accountType = input.accountType;
      updates.classification = classification;
      updates.normalBalance = normalBalance;
      updates.accountSubtype = null; // subtype was QBO's; a retype invalidates it
    }

    await tx.update(bkAccounts).set(updates).where(eq(bkAccounts.id, acct.id));
  });
}

// ---------------------------------------------------------------------------
// Activity tagging
// ---------------------------------------------------------------------------

/** Update the activity tag on a single account. */
export async function setAccountActivity(input: {
  entityId: string;
  accountId: string;
  activity: string;
}): Promise<void> {
  const activity = input.activity.trim();
  if (!activity) throw new Error("activity cannot be empty");
  const [acct] = await db
    .select({ id: bkAccounts.id })
    .from(bkAccounts)
    .where(and(eq(bkAccounts.id, input.accountId), eq(bkAccounts.entityId, input.entityId)));
  if (!acct) throw new Error("account not found for this entity");
  await db
    .update(bkAccounts)
    .set({ activity, updatedAt: new Date() })
    .where(eq(bkAccounts.id, input.accountId));
}


/**
 * Bulk archive / restore. Loops {@link setAccountActive} per id so each account
 * re-runs the same guards (deactivation needs a $0 balance + no active children).
 * Never all-or-nothing: an ineligible account is collected in `failed` with its
 * reason and the rest still apply. Returns how many changed + which were skipped.
 */
export async function bulkSetAccountActive(input: {
  entityId: string;
  accountIds: string[];
  active: boolean;
}): Promise<{ changed: number; failed: { accountId: string; error: string }[] }> {
  const failed: { accountId: string; error: string }[] = [];
  let changed = 0;
  for (const accountId of input.accountIds) {
    try {
      await setAccountActive({ entityId: input.entityId, accountId, active: input.active });
      changed++;
    } catch (e) {
      failed.push({ accountId, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { changed, failed };
}

/** Get distinct activity tags used by an entity's accounts. */
export async function getEntityActivities(entityId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ activity: bkAccounts.activity })
    .from(bkAccounts)
    .where(eq(bkAccounts.entityId, entityId))
    .orderBy(bkAccounts.activity);
  return rows.map((r) => r.activity);
}

/**
 * Deactivate / reactivate. Deactivating a BALANCE-SHEET account (asset /
 * liability / equity) requires a $0 net balance — real financial position is
 * never hidden. P&L accounts (revenue / expense) carry a lifetime cumulative
 * total rather than a current balance, so they can be archived at any balance
 * (a retired category still appears on statements for the periods it was used).
 * Either way, an account with active sub-accounts can't be archived first.
 * Reactivation is always allowed.
 */
export async function setAccountActive(input: {
  entityId: string;
  accountId: string;
  active: boolean;
}): Promise<void> {
  await db.transaction(async (tx) => {
    const [acct] = await tx
      .select()
      .from(bkAccounts)
      .where(
        and(eq(bkAccounts.id, input.accountId), eq(bkAccounts.entityId, input.entityId))
      )
      .for("update");
    if (!acct) throw new Error("account not found for this entity");
    if (acct.active === input.active) return;

    if (!input.active) {
      // The $0 guard applies only to balance-sheet accounts — a P&L account's
      // net is a lifetime total, not money on hand, so it's always archivable.
      const isBalanceSheet =
        acct.classification === "asset" ||
        acct.classification === "liability" ||
        acct.classification === "equity";
      if (isBalanceSheet) {
        const [{ net }] = await tx
          .select({
            net: sql<string>`COALESCE(SUM(${schema.bkJournalLines.debitCents} - ${schema.bkJournalLines.creditCents}), 0)`,
          })
          .from(schema.bkJournalLines)
          .where(eq(schema.bkJournalLines.accountId, acct.id));
        if (Number(net) !== 0) {
          throw new Error(
            "only $0-balance accounts can be deactivated — move or correct its balance first"
          );
        }
      }
      const [activeChild] = await tx
        .select({ id: bkAccounts.id })
        .from(bkAccounts)
        .where(
          and(
            eq(bkAccounts.entityId, input.entityId),
            eq(bkAccounts.parentQboId, acct.qboAccountId),
            eq(bkAccounts.active, true)
          )
        )
        .limit(1);
      if (activeChild) {
        throw new Error("deactivate its sub-accounts first");
      }
    }

    await tx
      .update(bkAccounts)
      .set({ active: input.active, updatedAt: new Date() })
      .where(eq(bkAccounts.id, acct.id));
  });
}
