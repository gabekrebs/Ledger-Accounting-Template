import { eq, and, desc, inArray, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";

const {
  bkLedgerEntities,
  bkPlaidItems,
  bkPlaidAccounts,
  bkPlaidTransactions,
  bkAccounts,
  bkJournalEntries,
  bkJournalLines,
} = schema;

export type PlaidAccountRow = typeof bkPlaidAccounts.$inferSelect;
export type PlaidItemView = {
  id: string;
  institutionName: string | null;
  status: string;
  lastError: string | null;
  lastSyncedAt: Date | null;
  accounts: PlaidAccountRow[];
};

/** A Plaid account as shown on the global Bank connections screen. */
export type ConnectionAccount = PlaidAccountRow & {
  entityName: string | null; // assigned entity, null = unassigned
  mappedAccountName: string | null; // ledger account it posts to
  // True when this same real-world bank account (institution + mask + subtype)
  // is ALSO connected under another Item → its feed would double-pull. Surfaced
  // so the user removes the duplicate connection before assigning it.
  duplicateWarning: boolean;
};

/**
 * Fingerprint a bank account across Items: same institution + last-four (mask) +
 * subtype is the same real account even when two separate links give it
 * different Plaid ids. Null when there's no mask to key on (can't assert).
 */
function acctFingerprint(
  institutionId: string | null,
  mask: string | null,
  subtype: string | null
): string | null {
  if (!mask) return null;
  return `${institutionId ?? "?"}|${mask}|${subtype ?? "?"}`;
}
export type ConnectionView = {
  id: string;
  institutionName: string | null;
  status: string;
  lastError: string | null;
  lastSyncedAt: Date | null;
  accounts: ConnectionAccount[];
};

/** An entity + its postable bank/liability ledger accounts, for the assign dropdown. */
export type AssignTarget = {
  entityId: string;
  entityName: string | null;
  accounts: { id: string; label: string }[];
};

/** Ledger accounts a bank account can post to (bank assets + credit-card liabilities). */
export async function listMappableAccounts(entityId: string) {
  const rows = await db
    .select({
      id: bkAccounts.id,
      name: bkAccounts.name,
      fullyQualifiedName: bkAccounts.fullyQualifiedName,
      classification: bkAccounts.classification,
    })
    .from(bkAccounts)
    .where(
      and(
        eq(bkAccounts.entityId, entityId),
        inArray(bkAccounts.classification, ["asset", "liability"])
      )
    );
  return rows.sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
}

/**
 * Connections (Items) that have at least one account assigned to THIS entity,
 * each carrying only that entity's accounts. Items are no longer owned by an
 * entity — an account is — so the per-entity Bank tab is resolved through the
 * account assignments, grouped back under their originating connection.
 */
export async function listItems(entityId: string): Promise<PlaidItemView[]> {
  const accounts = await db
    .select()
    .from(bkPlaidAccounts)
    .where(eq(bkPlaidAccounts.entityId, entityId));
  if (!accounts.length) return [];

  const itemIds = [...new Set(accounts.map((a) => a.itemId))];
  const items = await db
    .select()
    .from(bkPlaidItems)
    .where(inArray(bkPlaidItems.id, itemIds))
    .orderBy(desc(bkPlaidItems.createdAt));

  return items.map((it) => ({
    id: it.id,
    institutionName: it.institutionName,
    status: it.status,
    lastError: it.lastError,
    lastSyncedAt: it.lastSyncedAt,
    accounts: accounts.filter((a) => a.itemId === it.id),
  }));
}

/**
 * Every connection + every account it returned (regardless of entity), with each
 * account's current assignment resolved to display names. Backs the global Bank
 * connections screen where one link fans out to many businesses.
 */
export async function listConnections(): Promise<ConnectionView[]> {
  const allItems = await db
    .select()
    .from(bkPlaidItems)
    .orderBy(desc(bkPlaidItems.createdAt));
  // Replaced items are tombstones (assignments migrated to the fresh link) —
  // not connections anymore. Their accounts also stay out of dup-warnings.
  const items = allItems.filter((it) => it.status !== "replaced");
  if (!items.length) return [];
  const liveItemIds = new Set(items.map((it) => it.id));

  const accounts = (await db.select().from(bkPlaidAccounts)).filter((a) =>
    liveItemIds.has(a.itemId)
  );
  const entities = await db
    .select({ id: bkLedgerEntities.id, name: bkLedgerEntities.name })
    .from(bkLedgerEntities);
  const entityName = new Map(entities.map((e) => [e.id, e.name]));

  const mappedIds = accounts
    .map((a) => a.mappedAccountId)
    .filter((id): id is string => !!id);
  const mapped = mappedIds.length
    ? await db
        .select({
          id: bkAccounts.id,
          name: bkAccounts.name,
          fullyQualifiedName: bkAccounts.fullyQualifiedName,
        })
        .from(bkAccounts)
        .where(inArray(bkAccounts.id, mappedIds))
    : [];
  const mappedName = new Map(
    mapped.map((m) => [m.id, m.fullyQualifiedName ?? m.name])
  );

  // Flag the same real account connected under more than one Item (double-pull).
  const institutionOf = new Map(items.map((it) => [it.id, it.institutionId]));
  const fpItems = new Map<string, Set<string>>(); // fingerprint → set of itemIds
  for (const a of accounts) {
    const fp = acctFingerprint(
      institutionOf.get(a.itemId) ?? null,
      a.mask,
      a.subtype
    );
    if (!fp) continue;
    if (!fpItems.has(fp)) fpItems.set(fp, new Set());
    fpItems.get(fp)!.add(a.itemId);
  }

  return items.map((it) => ({
    id: it.id,
    institutionName: it.institutionName,
    status: it.status,
    lastError: it.lastError,
    lastSyncedAt: it.lastSyncedAt,
    accounts: accounts
      .filter((a) => a.itemId === it.id)
      .map((a) => {
        const fp = acctFingerprint(
          institutionOf.get(a.itemId) ?? null,
          a.mask,
          a.subtype
        );
        return {
          ...a,
          entityName: a.entityId ? entityName.get(a.entityId) ?? null : null,
          mappedAccountName: a.mappedAccountId
            ? mappedName.get(a.mappedAccountId) ?? null
            : null,
          // Same fingerprint present under ≥2 distinct Items.
          duplicateWarning: fp ? (fpItems.get(fp)?.size ?? 0) > 1 : false,
        };
      }),
  }));
}

/**
 * At link time, detect which of a freshly-linked Item's accounts are the SAME
 * real bank account (institution + mask + subtype) already connected under a
 * different Item. Linking the same account twice would double-pull its history
 * (the two Items issue different ids, so the unique-id guard can't catch it).
 * Returns the colliding accounts so the exchange can warn the user.
 */
export async function detectDuplicateAccounts(
  institutionId: string | null,
  freshAccounts: { mask?: string | null; subtype?: string | null; name?: string | null }[],
  excludeItemId: string
): Promise<{ name: string | null; mask: string | null }[]> {
  const existing = await db
    .select({
      itemId: bkPlaidAccounts.itemId,
      mask: bkPlaidAccounts.mask,
      subtype: bkPlaidAccounts.subtype,
      institutionId: bkPlaidItems.institutionId,
      itemStatus: bkPlaidItems.status,
    })
    .from(bkPlaidAccounts)
    .innerJoin(bkPlaidItems, eq(bkPlaidAccounts.itemId, bkPlaidItems.id));

  const existingFps = new Set<string>();
  for (const e of existing) {
    if (e.itemId === excludeItemId) continue;
    // A replaced item's accounts are EXPECTED to collide with their fresh
    // re-link — that's the migration, not a double-pull.
    if (e.itemStatus === "replaced") continue;
    const fp = acctFingerprint(e.institutionId, e.mask, e.subtype);
    if (fp) existingFps.add(fp);
  }

  const dups: { name: string | null; mask: string | null }[] = [];
  for (const a of freshAccounts) {
    const fp = acctFingerprint(institutionId, a.mask ?? null, a.subtype ?? null);
    if (fp && existingFps.has(fp)) {
      dups.push({ name: a.name ?? null, mask: a.mask ?? null });
    }
  }
  return dups;
}

/**
 * All entities and their bank/liability ledger accounts — the grouped options
 * for the per-account "assign to entity → ledger account" dropdown. One option
 * carries both the entity and the specific ledger account a Plaid account posts
 * to, so picking it sets the whole assignment at once.
 */
export async function listAssignTargets(): Promise<AssignTarget[]> {
  const entities = await db
    .select({ id: bkLedgerEntities.id, name: bkLedgerEntities.name })
    .from(bkLedgerEntities)
    .orderBy(bkLedgerEntities.name);
  const accounts = await db
    .select({
      id: bkAccounts.id,
      entityId: bkAccounts.entityId,
      name: bkAccounts.name,
      fullyQualifiedName: bkAccounts.fullyQualifiedName,
    })
    .from(bkAccounts)
    .where(inArray(bkAccounts.classification, ["asset", "liability"]));

  return entities.map((e) => ({
    entityId: e.id,
    entityName: e.name,
    accounts: accounts
      .filter((a) => a.entityId === e.id)
      .map((a) => ({ id: a.id, label: a.fullyQualifiedName ?? a.name ?? "" }))
      .sort((a, b) => a.label.localeCompare(b.label)),
  }));
}

/** Pending staging transactions for the review list. */
export async function listPendingTransactions(entityId: string, limit = 200) {
  return db
    .select()
    .from(bkPlaidTransactions)
    .where(
      and(
        eq(bkPlaidTransactions.entityId, entityId),
        eq(bkPlaidTransactions.status, "pending_review")
      )
    )
    .orderBy(desc(bkPlaidTransactions.txnDate))
    .limit(limit);
}

/**
 * Recently auto-posted (`plaid_auto`) transactions, newest first — the review
 * surface for the deterministic auto-poster. Auto-posted rows leave the inbox,
 * so this is where a human catches and undoes a bad one. Joins through to the
 * category account picked so the row reads "Merchant → Category".
 */
export async function listRecentAutoPosted(entityId: string, limit = 25) {
  const rows = await db
    .select({
      txnId: bkPlaidTransactions.id,
      txnDate: bkPlaidTransactions.txnDate,
      name: bkPlaidTransactions.name,
      merchantName: bkPlaidTransactions.merchantName,
      amountCents: bkPlaidTransactions.amountCents,
      postedAt: bkJournalEntries.createdAt,
      categoryName: bkAccounts.fullyQualifiedName,
      categoryNameFallback: bkAccounts.name,
    })
    .from(bkPlaidTransactions)
    .innerJoin(
      bkJournalEntries,
      eq(bkJournalEntries.id, bkPlaidTransactions.journalEntryId)
    )
    // The category (non-bank) line carries the account we want to display.
    .innerJoin(
      bkJournalLines,
      and(
        eq(bkJournalLines.entryId, bkJournalEntries.id),
        eq(bkJournalLines.lineNo, 2)
      )
    )
    .innerJoin(bkAccounts, eq(bkAccounts.id, bkJournalLines.accountId))
    .where(
      and(
        eq(bkPlaidTransactions.entityId, entityId),
        eq(bkPlaidTransactions.status, "posted"),
        eq(bkJournalEntries.source, "plaid_auto")
      )
    )
    .orderBy(desc(bkJournalEntries.createdAt))
    .limit(limit);
  return rows.map((r) => ({
    txnId: r.txnId,
    txnDate: r.txnDate,
    label: r.merchantName ?? r.name ?? "—",
    amountCents: r.amountCents,
    postedAt: r.postedAt,
    categoryLabel: r.categoryName ?? r.categoryNameFallback ?? "",
  }));
}

/** All active ledger accounts an outflow/inflow can be categorized to. */
export async function listPostableAccounts(entityId: string) {
  const rows = await db
    .select({
      id: bkAccounts.id,
      name: bkAccounts.name,
      fullyQualifiedName: bkAccounts.fullyQualifiedName,
      classification: bkAccounts.classification,
      accountType: bkAccounts.accountType,
    })
    .from(bkAccounts)
    .where(
      and(eq(bkAccounts.entityId, entityId), eq(bkAccounts.active, true))
    );
  return rows.sort((a, b) =>
    (a.fullyQualifiedName ?? a.name ?? "").localeCompare(
      b.fullyQualifiedName ?? b.name ?? ""
    )
  );
}

/* ────────────────────────────────────────────────────────────────────────────
 * Already-booked detection (Plaid vs the QBO/Wave import).
 *
 * The historical books were imported from QuickBooks (`qbo_import`) or Wave
 * (`wave_import`) up to each entity's cutoff. When Plaid then re-pulls the same
 * checking/CC account, the SAME economic txn would land twice. We match a
 * pending Plaid line against imported bank-side journal lines on its mapped
 * ledger account by (account, |amount|, date within a tolerance). An EXACT
 * match (≤1 day) is auto-suppressed; a NEAR match (≤3 days) is flagged with Post
 * disabled.
 *
 * By default we never match against our own `plaid`/`manual` entries — two
 * genuinely distinct same-amount charges a day apart must both post. The one
 * exception is a replaced connection's re-link, where the fresh Item re-delivers
 * already-posted history under NEW transaction ids: the reconciler passes
 * sources:'all' and bounds the wide matching to the replace overlap window
 * (see reconcile.ts).
 * ──────────────────────────────────────────────────────────────────────────── */
export const BOOKED_EXACT_DAYS = 1;
export const BOOKED_NEAR_DAYS = 3;

export const IMPORT_SOURCES = ["qbo_import", "wave_import"] as const;

export type BookedBankLine = {
  accountId: string;
  txnDate: string;
  cents: number;
  source: string;
};
export type BookedMatch = {
  source: string; // journal-entry source of the booked side, e.g. 'qbo_import'
  daysOff: number;
  exact: boolean;
} | null;

/**
 * Bank-side journal lines on the given ledger accounts. sources:'imports'
 * (default — QBO/Wave history only, what post-time guards key on) or 'all'
 * (every journal entry, for the replace-overlap reconciler).
 */
export async function getBookedBankLines(
  entityId: string,
  bankAccountIds: string[],
  sources: "imports" | "all" = "imports"
): Promise<BookedBankLine[]> {
  if (!bankAccountIds.length) return [];
  const rows = await db
    .select({
      accountId: bkJournalLines.accountId,
      txnDate: bkJournalEntries.txnDate,
      debitCents: bkJournalLines.debitCents,
      creditCents: bkJournalLines.creditCents,
      source: bkJournalEntries.source,
    })
    .from(bkJournalLines)
    .innerJoin(
      bkJournalEntries,
      eq(bkJournalLines.entryId, bkJournalEntries.id)
    )
    .where(
      and(
        eq(bkJournalEntries.entityId, entityId),
        inArray(bkJournalLines.accountId, bankAccountIds),
        ...(sources === "imports"
          ? [inArray(bkJournalEntries.source, [...IMPORT_SOURCES])]
          : [])
      )
    );
  return rows.map((r) => ({
    accountId: r.accountId,
    txnDate: String(r.txnDate).slice(0, 10),
    cents: Math.max(r.debitCents, r.creditCents),
    source: r.source,
  }));
}

function daysBetween(a: string, b: string): number {
  const ms = Math.abs(
    new Date(a.slice(0, 10) + "T00:00:00Z").getTime() -
      new Date(b.slice(0, 10) + "T00:00:00Z").getTime()
  );
  return Math.round(ms / 86_400_000);
}

/**
 * Closest imported bank line matching (accountId, cents) within the near window.
 * Returns the match + whether it's exact (≤ BOOKED_EXACT_DAYS), else null.
 */
export function matchBooked(
  lines: BookedBankLine[],
  accountId: string,
  cents: number,
  dateISO: string
): BookedMatch {
  let best: { source: string; daysOff: number } | null = null;
  for (const l of lines) {
    if (l.accountId !== accountId || l.cents !== cents) continue;
    const d = daysBetween(l.txnDate, dateISO);
    if (d > BOOKED_NEAR_DAYS) continue;
    if (!best || d < best.daysOff) best = { source: l.source, daysOff: d };
  }
  if (!best) return null;
  return { ...best, exact: best.daysOff <= BOOKED_EXACT_DAYS };
}

export { daysBetween };

/**
 * Bank / cash / credit-card ledger accounts across ALL entities — the only valid
 * TARGETS a Plaid account can post to (a checking → a bank asset, a card → a CC
 * liability). Used by the matcher both as the candidate set and to scope the
 * booked-history fingerprint match below.
 */
export async function listBankLedgerAccounts(): Promise<
  { entityId: string; accountId: string; label: string }[]
> {
  const rows = await db
    .select({
      id: bkAccounts.id,
      entityId: bkAccounts.entityId,
      name: bkAccounts.name,
      fqn: bkAccounts.fullyQualifiedName,
      accountType: bkAccounts.accountType,
      accountSubtype: bkAccounts.accountSubtype,
    })
    .from(bkAccounts)
    .where(inArray(bkAccounts.classification, ["asset", "liability"]));
  return rows
    .filter(
      (r) =>
        r.accountType === "Bank" ||
        r.accountType === "Credit Card" ||
        /checking|savings|money market/i.test(String(r.accountSubtype ?? ""))
    )
    .map((r) => ({
      entityId: r.entityId,
      accountId: r.id,
      label: r.fqn ?? r.name ?? "",
    }));
}

/**
 * Imported (QBO/Wave) bank-side journal lines for a set of ledger accounts,
 * WITHOUT an entity filter — the matcher compares an UNASSIGNED Plaid account
 * (no entity yet) against every candidate bank account's booked history.
 */
export async function getBookedBankLinesForAccounts(
  accountIds: string[]
): Promise<BookedBankLine[]> {
  if (!accountIds.length) return [];
  const rows = await db
    .select({
      accountId: bkJournalLines.accountId,
      txnDate: bkJournalEntries.txnDate,
      debitCents: bkJournalLines.debitCents,
      creditCents: bkJournalLines.creditCents,
      source: bkJournalEntries.source,
    })
    .from(bkJournalLines)
    .innerJoin(
      bkJournalEntries,
      eq(bkJournalLines.entryId, bkJournalEntries.id)
    )
    .where(
      and(
        inArray(bkJournalLines.accountId, accountIds),
        inArray(bkJournalEntries.source, ["qbo_import", "wave_import"])
      )
    );
  return rows.map((r) => ({
    accountId: r.accountId,
    txnDate: String(r.txnDate).slice(0, 10),
    cents: Math.max(r.debitCents, r.creditCents),
    source: r.source,
  }));
}

/** Count of txns auto-suppressed as already-booked for an entity (UI note). */
export async function countAlreadyBooked(entityId: string): Promise<number> {
  const rows = await db
    .select({ id: bkPlaidTransactions.id })
    .from(bkPlaidTransactions)
    .where(
      and(
        eq(bkPlaidTransactions.entityId, entityId),
        eq(bkPlaidTransactions.status, "already_booked")
      )
    );
  return rows.length;
}

/**
 * Vendor/payee names already in this entity's books (imported + posted),
 * most-used first — feeds the review inbox's payee autocomplete so a vendor
 * is spelled the same way every time (which is also what the merchant-history
 * fingerprint learns from).
 */
export async function listKnownPayees(
  entityId: string,
  limit = 400
): Promise<string[]> {
  const rows = await db
    .select({
      name: bkJournalEntries.name,
      uses: sql<number>`count(*)`,
    })
    .from(bkJournalEntries)
    .where(
      and(
        eq(bkJournalEntries.entityId, entityId),
        sql`${bkJournalEntries.name} is not null and ${bkJournalEntries.name} <> ''`
      )
    )
    .groupBy(bkJournalEntries.name)
    .orderBy(sql`count(*) desc`)
    .limit(limit);
  return rows.map((r) => r.name as string);
}
