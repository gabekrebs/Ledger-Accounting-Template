import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  date,
  bigint,
  boolean,
  integer,
  numeric,
  jsonb,
  timestamp,
  unique,
  index,
  check,
  primaryKey,
} from "drizzle-orm/pg-core";
import type { ConditionGroup, ActionSpec } from "@/lib/rules/types";

/**
 * Phase 6 — custom property-level double-entry ledger.
 *
 * Money is stored as bigint CENTS everywhere (mode: "number" — values are far
 * below 2^53). This ledger is the BOOK OF RECORD: QuickBooks/Wave seed it once,
 * then an owner can correct a transaction in-product (recategorize a line, fix
 * the payee/memo/date — never the amount, so Σdebit = Σcredit always holds).
 * Every edit is recorded in `bk_journal_edits` (append-only provenance) and the
 * entry is stamped `edited_at`/`edited_by`; "revert to original" replays the
 * earliest recorded value. Because edits live on the rows, the destructive QBO
 * re-import is guarded (`importTransactions`) so it can never silently wipe a
 * correction — see `lib/ledger/import.ts`.
 */

/**
 * App users managed in-product (the self-serve counterpart to the env-var
 * allowlists). The login gate admits env `AUTH_ALLOWED_EMAILS` ∪ ACTIVE rows
 * here. Roles: 'owner' (and legacy alias 'admin') grants full access to every
 * entity, like `AUTH_ADMIN_EMAILS`; 'accountant', 'business_partner', and
 * legacy 'member' are scoped per-entity by `bk_entity_access` (whose
 * access_level decides read vs write). The env vars remain as
 * bootstrap/break-glass — deleting every row here can never lock out an
 * env-listed admin. Rows reference Supabase auth users by email; deleting a
 * row revokes app access but never deletes the auth user (the Supabase
 * project's `auth.users` is shared across apps).
 */
export const bkAppUsers = pgTable(
  "bk_app_users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    email: text("email").notNull().unique(),
    displayName: text("display_name"),
    firstName: text("first_name"),
    lastName: text("last_name"),
    // 'owner' | 'admin' (legacy alias) | 'accountant' | 'business_partner' | 'member'
    role: text("role").notNull().default("member"),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    createdBy: text("created_by"),
  },
  (t) => [index("bk_app_users_email_idx").on(t.email)]
);

/**
 * Per-user entity access grants. The login allowlist (`AUTH_ALLOWED_EMAILS`
 * + active `bk_app_users`) answers "may this email sign in?"; this table answers
 * "which entities may they see?". Owner-tier users (`AUTH_ADMIN_EMAILS` +
 * `bk_app_users` role 'owner'/'admin') bypass this and see everything; every
 * other signed-in user sees exactly the entities they have a row for
 * (none = nothing).
 */
export const bkEntityAccess = pgTable(
  "bk_entity_access",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userEmail: text("user_email").notNull(),
    entityId: uuid("entity_id")
      .notNull()
      .references(() => bkLedgerEntities.id, { onDelete: "cascade" }),
    // Per-entity capability. Absence of a row = no access; a row grants either
    // 'read' (view only) or 'write' (bookkeeping mutations). Added by direct
    // ALTER (scripts/add-rbac-and-audit.mjs); default 'read'. Owner bypasses.
    accessLevel: text("access_level").notNull().default("read"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    unique("bk_entity_access_email_entity_uq").on(t.userEmail, t.entityId),
    index("bk_entity_access_email_idx").on(t.userEmail),
  ]
);

/**
 * Admin review log — every meaningful WRITE by a NON-admin user is recorded here
 * for the owner to review. Owner/admin actions are NOT logged (the owner is the
 * reviewer). Rows are append-only in practice; only the review flags
 * (`reviewed`/`reviewedAt`/`reviewedBy`) are updated. Written by `logAudit`
 * (plus system alerts like `plaid_source_drift` from the sync), read only by
 * the admin `/teamactivity` page. Added by direct ALTER
 * (scripts/add-rbac-and-audit.mjs), RLS-locked in the same migration.
 */
export const bkAuditLog = pgTable(
  "bk_audit_log",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    actorEmail: text("actor_email").notNull(),
    actorRole: text("actor_role").notNull(), // 'accountant' | 'business_partner' | 'system'
    entityId: uuid("entity_id")
      .notNull()
      .references(() => bkLedgerEntities.id, { onDelete: "cascade" }),
    actionType: text("action_type").notNull(), // e.g. 'post_transaction'
    objectTable: text("object_table"), // e.g. 'bk_journal_entries'
    objectId: text("object_id"),
    description: text("description").notNull(), // short human-readable summary
    beforeJson: jsonb("before_json"), // prior state where practical
    afterJson: jsonb("after_json"), // new state where practical
    affectedLedger: boolean("affected_ledger").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    reviewed: boolean("reviewed").notNull().default(false),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewedBy: text("reviewed_by"),
  },
  (t) => [
    index("bk_audit_log_entity_reviewed_idx").on(t.entityId, t.reviewed),
    index("bk_audit_log_reviewed_created_idx").on(t.reviewed, t.createdAt),
    index("bk_audit_log_actor_idx").on(t.actorEmail),
  ]
);

/** Entities on the custom ledger (added in-app; no hardcoded seed). */
export const bkLedgerEntities = pgTable("bk_ledger_entities", {
  id: uuid("id").defaultRandom().primaryKey(),
  realmId: text("realm_id").notNull().unique(), // per-entity accounting realm id (unique key)
  name: text("name"),
  legalName: text("legal_name"),
  taxType: text("tax_type"), // 'partnership' | 'schedule_e'
  fiscalYearStart: text("fiscal_year_start").default("January"),
  // When the entity was formed / first capitalized. Drives the capital "initial
  // vs capital call" split: contributions in the formation fiscal year are
  // INITIAL capital, later contributions are CAPITAL CALLS. Nullable — when
  // unset, reports fall back to the entity's earliest journal txn date, so the
  // split works zero-config for any entity / new onboard. UI-editable.
  formationDate: date("formation_date"),
  importedThrough: date("imported_through"), // high-water mark of imported txns
  // Short display name for the home-page launcher. Null = show `name`.
  // Added by scripts/add-entity-nickname.mjs.
  nickname: text("nickname"),
  // REMOVED FEATURE (2026-07): `qbo_sync_enabled` — the QBO nightly-import
  // toggle. The import itself was deleted with the QBO integration (ADR-008);
  // the flag lingered as dead UI. The COLUMN still exists in the database
  // (dormant, unread); dropping it is an optional future migration.
  // How the Overview hero values the property and computes appreciation:
  //   'income'       — cap-rate on stabilized NOI (default; multifamily/commercial/hospitality).
  //   'market'       — comps: one or more valuation COMPONENTS (structures), each with
  //                    Zillow/Redfin/AI/manual estimates; entity value = Σ component chosen.
  //                    Right for single-family houses & duplexes. Appreciation = value − cost basis.
  //   'equity_stake' — entity owns a % of another entity (parentEntityId); its value =
  //                    parent's valuation × ownershipPct (e.g. 1428 Holdings owns part of
  //                    Hungry Harbor). Lets a holding co inherit the underlying property value.
  //   'none'         — entity holds no real estate (e.g. a holding company); hero suppressed.
  // Added by direct ALTER (scripts/add-valuation-fields.mjs), matching the
  // bk_journal_lines.location precedent — no drizzle-kit sweep.
  valuationMethod: text("valuation_method").notNull().default("income"),
  // Legacy single-value market fields — kept as a fallback for entities not yet
  // migrated to components; getEntity prefers Σ(components) when components exist.
  marketValueCents: bigint("market_value_cents", { mode: "number" }),
  marketValueSource: text("market_value_source"),
  marketValueAsOf: date("market_value_as_of"),
  propertyAddress: text("property_address"),
  valuationUrl: text("valuation_url"),
  // equity_stake: this entity's value = parent entity's valuation × ownership %.
  parentEntityId: uuid("parent_entity_id"),
  ownershipPct: numeric("ownership_pct"), // 0–100; nullable (only for equity_stake)
  // [{name: string, pct: number, reportingPct?: number}] — partner/owner roster
  // for the capital & returns views. `pct` is the LEGAL ownership (books, taxes,
  // true-up). `reportingPct`, when present, is the owner's ECONOMIC share for
  // personal reporting (/comparison) — used when the legal split temporarily
  // parks a partner's stake with someone else.
  owners: jsonb("owners").$type<{ name: string; pct: number; reportingPct?: number }[]>(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

/**
 * A valuation COMPONENT = one physical structure/parcel inside a market-method
 * entity. Most entities have exactly one (the house); some hold several on one
 * lot (1032 SE 12th = a duplex + a separate house), and the entity's market
 * value is the SUM of its components' chosen values. Collapsing the single- and
 * multi-structure cases into one list keeps the model + UI uniform.
 */
export const bkValuationComponents = pgTable(
  "bk_valuation_components",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    entityId: uuid("entity_id")
      .notNull()
      .references(() => bkLedgerEntities.id, { onDelete: "cascade" }),
    label: text("label").notNull(), // e.g. "House — 123 Main St", "Duplex — 125-127 Main St"
    address: text("address"),
    zillowUrl: text("zillow_url"),
    redfinUrl: text("redfin_url"),
    // Property facts that feed the AI estimate prompt. The scraper fills the
    // public ones (propertyType/beds/baths/sqft) from the same Zillow/Redfin
    // pages it reads for the AVM; the owner provides the rest. Stored as text so
    // the AI form round-trips them verbatim.
    propertyType: text("property_type"), // "single-family", "townhome + ADU", …
    units: text("units"), // "2 (3BR up + studio ADU)"
    beds: text("beds"),
    baths: text("baths"),
    sqft: text("sqft"),
    monthlyRent: text("monthly_rent"), // gross monthly rent across units
    condition: text("condition"), // "renovated 2024", "new build 2023", …
    factsNote: text("facts_note"), // owner notes / known comps for the AI prompt
    // Which estimate source is the headline for this component. null → resolver
    // falls back manual → zillow → redfin → ai (most recent).
    chosenSource: text("chosen_source"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [index("bk_valuation_components_entity_idx").on(t.entityId)]
);

/**
 * One estimate of a component's value from a single SOURCE. Multiple sources
 * coexist (Zillow + Redfin + an AI research pass + a manual comp), each with its
 * own provenance + as-of date, so the owner-facing figure is always auditable.
 * Re-pulling a source upserts its row (one current estimate per source).
 */
export const bkValuationEstimates = pgTable(
  "bk_valuation_estimates",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    componentId: uuid("component_id")
      .notNull()
      .references(() => bkValuationComponents.id, { onDelete: "cascade" }),
    source: text("source").notNull(), // 'zillow' | 'redfin' | 'ai' | 'manual'
    valueCents: bigint("value_cents", { mode: "number" }).notNull(),
    asOf: date("as_of"),
    url: text("url"),
    reasoning: text("reasoning"), // AI: the rationale; manual: optional note
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    unique("bk_valuation_estimates_component_source_uq").on(t.componentId, t.source),
    index("bk_valuation_estimates_component_idx").on(t.componentId),
  ]
);

/**
 * Per-entity document vault — settlement statements, 1098s, insurance, tax
 * returns, escrow analyses, etc. The FILE lives in the PRIVATE Supabase Storage
 * bucket `entity-documents` (never public); this row is the metadata + the
 * storage path. Served only via short-lived signed URLs, gated by the same
 * entity access as the rest of the ledger. PII-bearing (SSNs/TINs) — see the
 * Documents section in ARCHITECTURE.md.
 */
export const bkDocuments = pgTable(
  "bk_documents",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    entityId: uuid("entity_id")
      .notNull()
      .references(() => bkLedgerEntities.id, { onDelete: "cascade" }),
    storagePath: text("storage_path").notNull(), // path within the private bucket
    fileName: text("file_name").notNull(), // original upload name
    contentType: text("content_type"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    // Owner-facing taxonomy: '1098' | 'settlement_statement' | 'tax_return' |
    // 'insurance' | 'escrow_analysis' | '1099' | 'other'. Free-form, UI-suggested.
    docType: text("doc_type"),
    docYear: integer("doc_year"), // tax/calendar year the doc pertains to
    label: text("label"), // optional human label / note
    uploadedBy: text("uploaded_by"), // user email
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    index("bk_documents_entity_idx").on(t.entityId),
    index("bk_documents_entity_year_idx").on(t.entityId, t.docYear),
  ]
);

/** Per-entity chart of accounts, mirrored from QBO. */
export const bkAccounts = pgTable(
  "bk_accounts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    entityId: uuid("entity_id")
      .notNull()
      .references(() => bkLedgerEntities.id, { onDelete: "cascade" }),
    qboAccountId: text("qbo_account_id").notNull(),
    name: text("name").notNull(),
    fullyQualifiedName: text("fully_qualified_name"),
    accountType: text("account_type").notNull(), // QBO AccountType
    accountSubtype: text("account_subtype"),
    parentQboId: text("parent_qbo_id"), // for sub-accounts
    normalBalance: text("normal_balance").notNull(), // 'debit' | 'credit'
    classification: text("classification").notNull(), // asset|liability|equity|revenue|expense
    active: boolean("active").notNull().default(true),
    // Business activity segment — e.g. "Real Estate", "Vehicle Leasing", "Hospitality".
    // Defaults to "Real Estate" for all accounts. Enables P&L filtering by activity
    // so RE performance can be isolated across mixed-use entities.
    activity: text("activity").notNull().default("Real Estate"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    unique("bk_accounts_entity_qbo_uq").on(t.entityId, t.qboAccountId),
    index("bk_accounts_entity_idx").on(t.entityId),
  ]
);

/** Immutable transaction headers — one per posted transaction. */
export const bkJournalEntries = pgTable(
  "bk_journal_entries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    entityId: uuid("entity_id")
      .notNull()
      .references(() => bkLedgerEntities.id, { onDelete: "cascade" }),
    source: text("source").notNull(), // 'qbo_import' | 'plaid' | 'manual'
    qboTxnType: text("qbo_txn_type"), // 'Purchase' | 'Deposit' | 'JournalEntry'
    qboTxnId: text("qbo_txn_id"),
    txnDate: date("txn_date").notNull(),
    docNum: text("doc_num"),
    name: text("name"), // payee / customer string
    memo: text("memo"),
    totalCents: bigint("total_cents", { mode: "number" }).notNull(), // Σ debits
    rawQbo: jsonb("raw_qbo"), // full original QBO object for drill-down/search
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    // Authorship for in-product entries (manual JEs); imports leave it null.
    // Added by direct ALTER (scripts/add-reconciliation.mjs).
    createdBy: text("created_by"),
    // In-product edit provenance (book-of-record). Null until a human corrects
    // the transaction; then stamped with when + which email. Drives the small
    // "edited · Jun 8" note shown wherever the transaction renders.
    editedAt: timestamp("edited_at", { withTimezone: true }),
    editedBy: text("edited_by"),
  },
  (t) => [
    // Idempotent re-import. (manual/plaid entries leave type/id null → distinct)
    unique("bk_journal_entries_qbo_uq").on(
      t.entityId,
      t.qboTxnType,
      t.qboTxnId
    ),
    index("bk_journal_entries_entity_date_idx").on(t.entityId, t.txnDate),
  ]
);

/** The postings — N per entry; Σ debit = Σ credit (enforced in importer). */
export const bkJournalLines = pgTable(
  "bk_journal_lines",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    entryId: uuid("entry_id")
      .notNull()
      .references(() => bkJournalEntries.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => bkAccounts.id),
    lineNo: integer("line_no").notNull(),
    debitCents: bigint("debit_cents", { mode: "number" }).notNull().default(0),
    creditCents: bigint("credit_cents", { mode: "number" })
      .notNull()
      .default(0),
    lineMemo: text("line_memo"),
    // Per-address (class/location) dimension — e.g. "508"/"512"/"516"/"520" for
    // a multi-unit entity. Null for single-property entities. Lets reports group
    // a single LLC's P&L by physical address (the "sell one unit" view) without
    // exploding the chart of accounts. Added by direct ALTER (not drizzle-kit)
    // to avoid sweeping unrelated schema drift into a migration.
    location: text("location"),
    // Cleared mark: set when this line is checked off in a bank reconciliation
    // (bk_reconciliations). NULL = never reconciled. ON DELETE SET NULL — undoing
    // a reconciliation releases its lines. A reconciled line's account is locked
    // against recategorization (see lib/ledger/edit-transaction.ts) and the QBO
    // clean-replace re-import refuses when marks exist (see lib/ledger/import.ts).
    // Added by direct ALTER (scripts/add-reconciliation.mjs), location precedent.
    reconciliationId: uuid("reconciliation_id"),
  },
  (t) => [
    index("bk_journal_lines_entry_idx").on(t.entryId),
    index("bk_journal_lines_account_idx").on(t.accountId),
    // Each line is a debit XOR a credit, both non-negative.
    check(
      "bk_journal_lines_debit_xor_credit",
      sql`${t.debitCents} >= 0 AND ${t.creditCents} >= 0 AND NOT (${t.debitCents} > 0 AND ${t.creditCents} > 0)`
    ),
  ]
);

/**
 * Bank reconciliation — the statement-tie workflow for one bank / credit-card
 * account. One row per statement: the user enters the statement end date and
 * ending balance, checks off journal lines (stamping their `reconciliation_id`),
 * and can only complete when beginning + Σ(checked) equals the statement balance
 * to the penny. A partial unique index (account_id WHERE status='in_progress')
 * enforces one open reconciliation per account. Undo/cancel releases the lines
 * (FK ON DELETE SET NULL). Created by scripts/add-reconciliation.mjs.
 */
export const bkReconciliations = pgTable(
  "bk_reconciliations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    entityId: uuid("entity_id")
      .notNull()
      .references(() => bkLedgerEntities.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => bkAccounts.id, { onDelete: "cascade" }),
    statementDate: date("statement_date").notNull(),
    // Statement ending balance in the account's NATURAL sign (a credit-card
    // statement's positive "balance owed" is stored positive; reports.ts-style
    // debit-net comparison normalizes by the account's normal_balance).
    statementBalanceCents: bigint("statement_balance_cents", {
      mode: "number",
    }).notNull(),
    // Cleared balance (debit − credit, signed) at start = Σ of already-reconciled
    // lines. Stored for the workspace header; live math recomputes from marks.
    beginningBalanceCents: bigint("beginning_balance_cents", { mode: "number" })
      .notNull()
      .default(0),
    status: text("status").notNull().default("in_progress"), // in_progress | completed
    notes: text("notes"),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    index("bk_reconciliations_entity_idx").on(t.entityId),
    index("bk_reconciliations_account_date_idx").on(t.accountId, t.statementDate),
  ]
);

/**
 * Manual balance checkpoints for the per-entity Reconciliation view — one row
 * per "I looked at the real statement/portal and the balance was X on date D"
 * assertion, for accounts with no Plaid feed (non-mortgage loans, unlinked
 * bank/credit-card accounts). Append-only history; the view reads only the
 * most-recent `as_of_date` row per account. `actual_balance_cents` is entered
 * in the account's NATURAL sign (a loan's balance owed is positive), matching
 * the statement-tie convention. Keyed by `account_qbo_id` (the GL route key,
 * same as bk_loans' account links) with no FK — a checkpoint is a historical
 * observation, not live state, so it survives account/entity churn.
 *
 * Created by scripts/add-account-recon.mjs (direct ALTER, not drizzle-kit) and
 * deliberately KEPT OUT of drizzle.config.ts `tablesFilter` so drizzle-kit
 * never diffs it.
 */
export const bkAccountRecon = pgTable(
  "bk_account_recon",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    entityId: uuid("entity_id").notNull(),
    accountQboId: text("account_qbo_id").notNull(),
    asOfDate: date("as_of_date").notNull(),
    actualBalanceCents: bigint("actual_balance_cents", {
      mode: "number",
    }).notNull(),
    note: text("note"),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // "Latest checkpoint per account" is the only read path.
    index("bk_account_recon_lookup_idx").on(
      t.entityId,
      t.accountQboId,
      t.asOfDate.desc()
    ),
  ]
);

/**
 * Sync-observation memory for the Reconciliation view's Plaid rows — one row
 * per mapped account recording when the book-vs-bank residual was last within
 * tolerance and, if it currently isn't, when that streak started. This is what
 * lets the status pill distinguish "settling" (a residual younger than the
 * grace window — pending charges the bank counts but Plaid hasn't delivered
 * yet; self-corrects) from a GENUINE discrepancy that has persisted. Stamped
 * by every reconStatus() pass (page render + the daily cron sweeps). Pure
 * derived state — safe to truncate, it rebuilds from observations.
 *
 * Created by scripts/add-recon-state.mjs (direct ALTER, not drizzle-kit) and
 * deliberately KEPT OUT of drizzle.config.ts `tablesFilter`.
 */
export const bkAccountReconState = pgTable("bk_account_recon_state", {
  id: uuid("id").defaultRandom().primaryKey(),
  entityId: uuid("entity_id")
    .notNull()
    .references(() => bkLedgerEntities.id, { onDelete: "cascade" }),
  accountId: uuid("account_id")
    .notNull()
    .unique()
    .references(() => bkAccounts.id, { onDelete: "cascade" }),
  /** First observation of the current out-of-tolerance streak; null = in sync. */
  offSince: timestamp("off_since", { withTimezone: true }),
  lastInSyncAt: timestamp("last_in_sync_at", { withTimezone: true }),
  lastResidualCents: bigint("last_residual_cents", { mode: "number" })
    .notNull()
    .default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * Append-only audit trail for in-product transaction edits (book-of-record).
 *
 * One row per field changed. `lineId` is set for a line-level change (the only
 * one today is `field='account'` — recategorizing a posting to a different
 * account, amounts untouched); null for a header field (`name`/`memo`/
 * `txn_date`). `oldValue`/`newValue` are text — for `account` they hold the
 * `bk_accounts.id` (uuid) on each side. This is the source of truth for "revert
 * to original" (replay the earliest `oldValue` per field) and the provenance
 * note; it survives QBO re-import, which is itself guarded when edits exist.
 */
export const bkJournalEdits = pgTable(
  "bk_journal_edits",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    entityId: uuid("entity_id")
      .notNull()
      .references(() => bkLedgerEntities.id, { onDelete: "cascade" }),
    entryId: uuid("entry_id")
      .notNull()
      .references(() => bkJournalEntries.id, { onDelete: "cascade" }),
    lineId: uuid("line_id").references(() => bkJournalLines.id, {
      onDelete: "cascade",
    }),
    field: text("field").notNull(), // 'name' | 'memo' | 'txn_date' | 'account'
    oldValue: text("old_value"),
    newValue: text("new_value"),
    editedAt: timestamp("edited_at", { withTimezone: true }).defaultNow(),
    editedBy: text("edited_by"),
  },
  (t) => [
    index("bk_journal_edits_entry_idx").on(t.entryId),
    index("bk_journal_edits_entity_idx").on(t.entityId),
  ]
);

/* ────────────────────────────────────────────────────────────────────────────
 * Phase 6b — Plaid bank-feed ingest (staging).
 *
 * These tables are the "For Review" inbox: raw bank lines pulled from Plaid,
 * held OUTSIDE the immutable journal until a category is assigned and a balanced
 * journal entry is posted (milestone 2). Nothing here touches bk_journal_* until
 * a Plaid txn is explicitly posted. Money is bigint CENTS, sign preserved from
 * Plaid's convention (positive = money OUT of a depository account).
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * One row per linked bank connection (a Plaid "Item" = one bank auth).
 *
 * An Item is NOT owned by a single entity. One login (e.g. Chase business) can
 * expose many accounts that fan out to many different ledger entities — the
 * entity assignment lives on `bk_plaid_accounts`, not here. `entityId` is kept
 * only as provenance ("which entity, if any, the connection was first linked
 * from") and is nullable for global links; it does NOT drive transaction
 * routing. Route everything off the account, never the Item.
 */
export const bkPlaidItems = pgTable(
  "bk_plaid_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    // Provenance only (nullable). Account-level assignment is the source of truth.
    entityId: uuid("entity_id").references(() => bkLedgerEntities.id, {
      onDelete: "set null",
    }),
    plaidItemId: text("plaid_item_id").notNull().unique(),
    // Plaid access_token — server-only secret. Never select into a client
    // component / public page. (Sandbox tokens are fake; for production add
    // at-rest encryption + app auth before linking real banks.)
    accessToken: text("access_token").notNull(),
    institutionId: text("institution_id"),
    institutionName: text("institution_name"),
    // transactions/sync cursor — null until the first sync.
    txnCursor: text("txn_cursor"),
    status: text("status").notNull().default("active"), // active|login_required|error
    lastError: text("last_error"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [index("bk_plaid_items_entity_idx").on(t.entityId)]
);

/**
 * Bank accounts within an Item. This is the UNIT OF ENTITY OWNERSHIP: each
 * account is independently assignable to any ledger entity, regardless of which
 * Item it arrived under. `entityId` null = unassigned (the account showed up in
 * Link but hasn't been routed to a business yet). `mappedAccountId` is the
 * specific ledger (QBO-mirrored) bank/CC account within that entity it posts to;
 * a complete assignment sets both, together.
 */
export const bkPlaidAccounts = pgTable(
  "bk_plaid_accounts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    itemId: uuid("item_id")
      .notNull()
      .references(() => bkPlaidItems.id, { onDelete: "cascade" }),
    // Which ledger entity this bank account is routed to. Null = unassigned.
    entityId: uuid("entity_id").references(() => bkLedgerEntities.id, {
      onDelete: "set null",
    }),
    plaidAccountId: text("plaid_account_id").notNull().unique(),
    name: text("name"),
    officialName: text("official_name"),
    mask: text("mask"),
    type: text("type"), // depository|credit|loan|...
    subtype: text("subtype"), // checking|savings|credit card|...
    // Which ledger (QBO-mirrored) account this bank account posts to. Null until
    // the user maps it on the Bank review screen; required before posting.
    mappedAccountId: uuid("mapped_account_id").references(() => bkAccounts.id),
    // Never store this account's transactions (a personal account a bank login
    // forced along, e.g. the Barclays Skywards card). Sync skips it entirely.
    syncExcluded: boolean("sync_excluded").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    index("bk_plaid_accounts_item_idx").on(t.itemId),
    index("bk_plaid_accounts_entity_idx").on(t.entityId),
  ]
);

/** Staging inbox of raw bank transactions awaiting review/posting. */
export const bkPlaidTransactions = pgTable(
  "bk_plaid_transactions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    // Denormalized routing cache: follows the txn's ACCOUNT entity assignment.
    // Stamped at sync time from bk_plaid_accounts.entityId and re-stamped when an
    // account is (re)assigned. Null = the account is unassigned → not in any
    // entity's review inbox yet. Never derived from the Item.
    entityId: uuid("entity_id").references(() => bkLedgerEntities.id, {
      onDelete: "set null",
    }),
    plaidAccountId: text("plaid_account_id").notNull(),
    plaidTransactionId: text("plaid_transaction_id").notNull().unique(),
    pending: boolean("pending").notNull().default(false),
    txnDate: date("txn_date").notNull(),
    name: text("name"),
    merchantName: text("merchant_name"),
    // Sign per Plaid: positive = outflow from a depository account. bigint cents.
    amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
    isoCurrencyCode: text("iso_currency_code"),
    plaidCategory: jsonb("plaid_category"), // personal_finance_category + legacy
    // pending_review → posted (journal entry written) | ignored.
    status: text("status").notNull().default("pending_review"),
    journalEntryId: uuid("journal_entry_id").references(() => bkJournalEntries.id),
    raw: jsonb("raw"),
    // Persisted category SUGGESTION (Phase 2/3). NOT a posting — only pre-fills
    // the review dropdown. Written by the interactive "Suggest categories" path
    // and by the threshold Batch-API job; the review page reads it to pre-fill.
    // Cleared implicitly on post/ignore (the row leaves pending_review).
    suggestedAccountId: uuid("suggested_account_id").references(
      () => bkAccounts.id
    ),
    suggestedConfidence: numeric("suggested_confidence", { mode: "number" }),
    suggestedReasoning: text("suggested_reasoning"),
    suggestionSource: text("suggestion_source"), // 'history' | 'ai'
    suggestedAt: timestamp("suggested_at", { withTimezone: true }),
    // AI-cleaned vendor name — pre-fills the review row's payee field (the raw
    // descriptor stays visible underneath). Null = no clean name suggested.
    suggestedPayee: text("suggested_payee"),
    // Evidence bucket the suggestion fell into at suggestion time (e.g.
    // "ai|seen|b90") — joins to bk_autopost_buckets for calibration + gating.
    suggestionBucket: text("suggestion_bucket"),
    // Rules-engine marks (added by scripts/add-rules-engine.mjs, suggested_*
    // precedent). `reviewReason` = why this txn is waiting (a matching non-auto
    // rule, a gate deferral, pre-cutoff). `matchedRuleId` = the rule the last
    // auto-post sweep matched (null when none).
    // Both are the sweep's RECORD; the review page recomputes the live match.
    reviewReason: text("review_reason"),
    matchedRuleId: uuid("matched_rule_id").references(() => bkRules.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    index("bk_plaid_txns_entity_status_idx").on(t.entityId, t.status),
    index("bk_plaid_txns_account_idx").on(t.plaidAccountId),
    index("bk_plaid_txns_date_idx").on(t.entityId, t.txnDate),
    // FK lookup: posting/unposting resolves by journal entry, and journal-entry
    // deletes (entity re-import/removal) trigger a per-row FK check here —
    // unindexed, that's a seq scan per deleted entry.
    index("bk_plaid_txns_journal_entry_idx").on(t.journalEntryId),
  ]
);


/**
 * Open/closed Anthropic Batch-API jobs for category suggestions (Phase 3b). The
 * threshold cron submits one job covering all entities' leftover transactions
 * (one batch request per entity, custom_id = entity_id), records it here, and a
 * later cron run polls + ingests results into the `suggested_*` columns above.
 * Tracked so we never submit a second job while one is still open, and so a
 * finished job is ingested exactly once.
 */
export const bkCategoryBatches = pgTable("bk_category_batches", {
  id: uuid("id").defaultRandom().primaryKey(),
  anthropicBatchId: text("anthropic_batch_id").notNull().unique(),
  // submitted → ingested | failed.
  status: text("status").notNull().default("submitted"),
  requestCount: integer("request_count").notNull().default(0),
  suggestionsWritten: integer("suggestions_written").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  ingestedAt: timestamp("ingested_at", { withTimezone: true }),
});

/**
 * Loan / mortgage terms — drives the amortization calculator and (post-Plaid)
 * auto-posting of payment splits. Account links are by QBO account id so the
 * loan ties to the ledger's existing accounts; interest/escrow/funding links
 * are nullable (only needed when auto-posting goes live in Phase 6b).
 */
export const bkLoans = pgTable("bk_loans", {
  id: uuid("id").defaultRandom().primaryKey(),
  entityId: uuid("entity_id")
    .notNull()
    .references(() => bkLedgerEntities.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  lender: text("lender"),
  liabilityAccountQboId: text("liability_account_qbo_id"), // mortgage payable
  interestAccountQboId: text("interest_account_qbo_id"), // interest expense
  // Where the escrow LEG of a payment posts. Owner decision (2026-07): escrow
  // is EXPENSED monthly to a "Taxes & Insurance (Escrow)" account and trued up
  // at year end — not accumulated in an escrow asset.
  escrowAccountQboId: text("escrow_account_qbo_id"),
  fundingAccountQboId: text("funding_account_qbo_id"), // bank paying it

  // --- Liability-engine recognition state (added 2026-07) ---
  // The loan is the stable economic identity; the servicer is just a label.
  // `payeeAliases` accumulates every NACHA descriptor seen paying this loan
  // (NEWREZ-SHELLPOIN, whoever buys it next) — a match bonus, never a
  // requirement. `expectedPaymentCents` is the current full draft (P&I +
  // escrow); it is BOTH the recognition band's center and the engine's
  // on-switch (null = never auto-recognize; unknown loans land in Review).
  // Auto-adopted when an in-band payment amount changes (escrow re-analysis).
  payeeAliases: jsonb("payee_aliases").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  expectedPaymentCents: bigint("expected_payment_cents", { mode: "number" }),
  recognizedCount: integer("recognized_count").notNull().default(0),
  lastRecognizedDate: date("last_recognized_date"),

  // --- Legacy full-amortization fields (now optional) ---
  // Principal paydown is computed directly from the GL (initial balance −
  // current balance), so these are no longer required. Existing rows that
  // have them still drive the legacy amortize() path; new rows use the
  // lighter "remaining term" path below.
  originalPrincipalCents: bigint("original_principal_cents", { mode: "number" }),
  annualRateBps: numeric("annual_rate_bps", { mode: "number" }),  // 6.5% = 650 bps
  termMonths: integer("term_months"),
  startDate: date("start_date"),
  firstPaymentDate: date("first_payment_date"),

  // --- Current-state projection fields (preferred for new entries) ---
  // Enter these after any refi/forbearance — the amortization schedule is
  // built from the CURRENT GL balance + these terms, so it stays accurate
  // without needing to know the original loan history.
  remainingTermMonths: integer("remaining_term_months"), // as of rate_as_of_date
  rateAsOfDate: date("rate_as_of_date"),                // when rate/term snapshot taken

  monthlyPaymentCents: bigint("monthly_payment_cents", { mode: "number" }), // P&I; computed if null
  monthlyEscrowCents: bigint("monthly_escrow_cents", { mode: "number" })
    .notNull()
    .default(0),
  // Interest-only loans never reduce principal (e.g. a construction LOC or
  // a 0%-interest forbearance deferral that only repays par on a schedule).
  interestOnly: boolean("interest_only").notNull().default(false),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

/*
 * REMOVED FEATURE — invoicing / notes-receivable statements (2026-07).
 * The physical tables `bk_notes_receivable`, `bk_invoice_templates`, and
 * `bk_invoices` still exist in the database (RLS-locked, deny-all to the public
 * API) but are DORMANT: no code references them. Dropping them (and their data)
 * is an optional future migration — do not drop without the owner's approval.
 */

/* ────────────────────────────────────────────────────────────────────────────
 * Categorization rules engine — the deterministic, user-authored spine.
 *
 * Created by scripts/add-rules-engine.mjs (direct ALTER, not drizzle-kit) and
 * deliberately KEPT OUT of drizzle.config.ts `tablesFilter` so drizzle-kit never
 * diffs them. JSONB predicate/action shapes live in lib/rules/types.ts.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * A categorization rule. `scope='global'` ⇔ `entityId IS NULL`: global rules
 * target canonical keys (resolved per-entity) and are admin-authored; entity
 * rules target concrete accounts and OVERRIDE global (see lib/rules/engine.ts
 * sort order). Only `enabled && status='active' && autoApply` rules post
 * unattended (lib/plaid/auto-post.ts). `origin`/`status`/`proposedFromTxnId` are
 * the hooks the future history→rule learner writes through.
 */
export const bkRules = pgTable(
  "bk_rules",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    scope: text("scope").notNull(), // 'global' | 'entity'
    entityId: uuid("entity_id").references(() => bkLedgerEntities.id, {
      onDelete: "cascade",
    }),
    name: text("name").notNull(),
    description: text("description"),
    enabled: boolean("enabled").notNull().default(true),
    // Only auto_apply rules post unattended. Default false — authoring a rule
    // never silently changes the books until the user opts it in.
    autoApply: boolean("auto_apply").notNull().default(false),
    status: text("status").notNull().default("active"), // 'active'|'proposed'|'archived'
    origin: text("origin").notNull().default("manual"), // 'manual'|'learned'|'nl'
    rank: integer("rank").notNull().default(100), // lower wins
    predicate: jsonb("predicate").$type<ConditionGroup>().notNull(),
    action: jsonb("action").$type<ActionSpec>().notNull(),
    proposedFromTxnId: uuid("proposed_from_txn_id"),
    appliedCount: integer("applied_count").notNull().default(0),
    correctedCount: integer("corrected_count").notNull().default(0),
    // Genuine review-flow confirmations only (the owner posted a txn keeping this
    // rule's suggestion). Distinct from appliedCount, which also counts bulk
    // "apply to similar/retroactive" — those must NOT graduate a rule. Graduation
    // reads confirmedCount so auto_apply is only earned one real review at a time.
    confirmedCount: integer("confirmed_count").notNull().default(0),
    lastAppliedAt: timestamp("last_applied_at", { withTimezone: true }),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    index("bk_rules_scope_enabled_status_idx").on(t.scope, t.enabled, t.status),
    index("bk_rules_entity_idx").on(t.entityId),
    index("bk_rules_origin_status_idx").on(t.origin, t.status),
    // scope='global' ⇔ entity_id IS NULL (mirrors the DB CHECK).
    check(
      "bk_rules_scope_entity_ck",
      sql`(${t.scope} = 'global') = (${t.entityId} IS NULL)`
    ),
  ]
);

/**
 * Append-only categorization decision log — every decision (auto-post, proposal,
 * manual apply, skip, ignore, leave-uncategorized) with its source, confidence,
 * and reason. The "why wasn't this auto-categorized" surface and the
 * fingerprint→learner feed. FKs SET NULL so deleting a rule/entry never erases
 * the audit trail.
 */
export const bkCategorizationEvents = pgTable(
  "bk_categorization_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    entityId: uuid("entity_id").references(() => bkLedgerEntities.id, {
      onDelete: "cascade",
    }),
    plaidTxnId: uuid("plaid_txn_id").references(() => bkPlaidTransactions.id, {
      onDelete: "set null",
    }),
    journalEntryId: uuid("journal_entry_id").references(
      () => bkJournalEntries.id,
      { onDelete: "set null" }
    ),
    ruleId: uuid("rule_id").references(() => bkRules.id, {
      onDelete: "set null",
    }),
    // 'rule' | 'recognizer' | 'ai' | 'manual' ('fingerprint' appears on legacy rows only)
    decisionSource: text("decision_source").notNull(),
    // Sweep decisions: 'auto_posted' | 'proposed' | 'applied_manual' | 'skipped'
    // | 'leave_uncategorized'. Suggestion lifecycle (ADR-021): one 'suggested'
    // row per suggestion shown, then the SAME row is stamped 'accepted' |
    // 'corrected' | 'ignored' | 'auto_posted' | 'superseded' when decided.
    outcome: text("outcome").notNull(),
    actionKind: text("action_kind"),
    confidence: numeric("confidence", { mode: "number" }),
    reason: text("reason"),
    detail: jsonb("detail"),
    createdBy: text("created_by"),
    // Suggestion-lifecycle fields (ADR-021 evidence ledger). One 'suggested'
    // row per suggestion shown; the decision (accepted/corrected/ignored/
    // auto_posted) is stamped onto the SAME row so calibration reads
    // one-row-per-suggestion. `detail` carries the evidence snapshot (similar
    // txns shown, merchant intel used, history hint) for future-model replay.
    suggestedAccountId: uuid("suggested_account_id").references(
      () => bkAccounts.id,
      { onDelete: "set null" }
    ),
    postedAccountId: uuid("posted_account_id").references(() => bkAccounts.id, {
      onDelete: "set null",
    }),
    merchantKey: text("merchant_key"),
    amountCents: bigint("amount_cents", { mode: "number" }),
    bucketKey: text("bucket_key"),
    model: text("model"),
    promptVersion: text("prompt_version"),
    suggestedPayee: text("suggested_payee"),
    wouldAutoPost: boolean("would_auto_post"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decidedBy: text("decided_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    index("bk_categorization_events_entity_idx").on(t.entityId, t.createdAt),
    index("bk_categorization_events_txn_idx").on(t.plaidTxnId),
    index("bk_categorization_events_rule_idx").on(t.ruleId),
    index("bk_categorization_events_entry_idx").on(t.journalEntryId),
    index("bk_categorization_events_bucket_idx").on(t.bucketKey, t.outcome),
    index("bk_categorization_events_merchant_idx").on(t.merchantKey),
  ]
);

/**
 * Web-enriched merchant profiles, one per normalized merchant key, shared
 * across every entity. Assistive context for the AI categorizer — never an
 * executable mapping (likely_category is a human-readable concept, not an
 * account id). `owner_category` records what the owner actually books this
 * merchant to when it differs, so the profile converges on his reality.
 */
export const bkMerchantIntel = pgTable("bk_merchant_intel", {
  id: uuid("id").defaultRandom().primaryKey(),
  merchantKey: text("merchant_key").notNull().unique(),
  displayName: text("display_name"),
  businessType: text("business_type"),
  likelyCategory: text("likely_category"),
  notes: text("notes"),
  source: text("source").notNull().default("web"), // 'web' | 'model'
  confidence: numeric("confidence", { mode: "number" }),
  ownerCategory: text("owner_category"),
  sampleRaw: text("sample_raw"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

/**
 * Per-evidence-bucket measured precision + the state machine gating AI
 * auto-posts: 'shadow' (measuring) → 'unlocked' (≥98% precision over ≥50
 * outcomes) → 'locked' (a correction re-locks instantly). The nightly
 * calibration sweep maintains counts from bk_categorization_events; the
 * review UI reads measured_precision as the displayed calibrated %.
 */
export const bkAutopostBuckets = pgTable("bk_autopost_buckets", {
  bucketKey: text("bucket_key").primaryKey(),
  status: text("status").notNull().default("shadow"),
  outcomes: integer("outcomes").notNull().default(0),
  correct: integer("correct").notNull().default(0),
  measuredPrecision: numeric("measured_precision", { mode: "number" }),
  unlockedAt: timestamp("unlocked_at", { withTimezone: true }),
  lockedAt: timestamp("locked_at", { withTimezone: true }),
  lockReason: text("lock_reason"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

/**
 * Append-only rule-change audit (mirrors bk_journal_edits): one row per field
 * changed. `oldValue`/`newValue` are JSON-stringified text. `entityId` null for
 * global rules.
 */
export const bkRuleEdits = pgTable(
  "bk_rule_edits",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ruleId: uuid("rule_id")
      .notNull()
      .references(() => bkRules.id, { onDelete: "cascade" }),
    entityId: uuid("entity_id"),
    field: text("field").notNull(), // predicate|action|enabled|auto_apply|rank|name|status
    oldValue: text("old_value"),
    newValue: text("new_value"),
    editedAt: timestamp("edited_at", { withTimezone: true }).defaultNow(),
    editedBy: text("edited_by"),
  },
  (t) => [index("bk_rule_edits_rule_idx").on(t.ruleId)]
);


/**
 * Utility tracker (2026-07-30): entities whose long-term tenants don't pay
 * their own utilities get a Utilities tab summarizing owner-covered spend,
 * sourced from the Plaid staging feed. One group per building; matchers pin
 * (bank account, descriptor fragment) → category — the bank account is the
 * address discriminator (each building pays from its own checking account).
 * Ships via scripts/add-utility-tracker.mjs; kept OUT of drizzle tablesFilter.
 */
export const bkUtilityGroups = pgTable(
  "bk_utility_groups",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    entityId: uuid("entity_id")
      .notNull()
      .references(() => bkLedgerEntities.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    /** First payment date that counts (e.g. when the building went long-term). */
    trackingStart: date("tracking_start").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("bk_utility_groups_entity_id_name_key").on(t.entityId, t.name)]
);

export const bkUtilityMatchers = pgTable(
  "bk_utility_matchers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    groupId: uuid("group_id")
      .notNull()
      .references(() => bkUtilityGroups.id, { onDelete: "cascade" }),
    category: text("category").notNull(), // display label: Electric, Gas, …
    matchContains: text("match_contains").notNull(), // ILIKE fragment on raw name
    plaidAccountId: uuid("plaid_account_id")
      .notNull()
      .references(() => bkPlaidAccounts.id, { onDelete: "cascade" }),
    /** Optional categories (garbage) sit behind an include/exclude toggle. */
    optional: boolean("optional").notNull().default(false),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("bk_utility_matchers_group_id_category_match_contains_key").on(
      t.groupId,
      t.category,
      t.matchContains
    ),
    index("bk_utility_matchers_group_idx").on(t.groupId),
  ]
);





























/**
 * Owner heads-up holds for the review queue — "a transaction like this is
 * coming (exact |amount| and/or vendor substring, this entity, next N days);
 * keep it out of ALL automation and in review". Checked FIRST in the
 * auto-poster, ahead of recognizers and rules, which are never modified.
 * A hold is only closed by the owner acknowledging it ("transaction found") —
 * expiry stops the interception but keeps the hold listed, so an anomaly that
 * never arrived is still chased down, never silently forgotten.
 *
 * Created by scripts/add-review-holds.mjs (direct ALTER, not drizzle-kit);
 * deliberately KEPT OUT of drizzle.config.ts `tablesFilter`.
 */
export const bkReviewHolds = pgTable(
  "bk_review_holds",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    entityId: uuid("entity_id")
      .notNull()
      .references(() => bkLedgerEntities.id, { onDelete: "cascade" }),
    /** Exact |amount| when amountMaxCents is null; else the inclusive lower bound. */
    amountCents: bigint("amount_cents", { mode: "number" }),
    amountMaxCents: bigint("amount_max_cents", { mode: "number" }),
    vendorText: text("vendor_text"),
    note: text("note"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    matchCount: integer("match_count").notNull().default(0),
    lastMatchedTxnId: uuid("last_matched_txn_id"),
    lastMatchedAt: timestamp("last_matched_at", { withTimezone: true }),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    acknowledgedBy: text("acknowledged_by"),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("bk_review_holds_entity_idx").on(t.entityId)]
);









