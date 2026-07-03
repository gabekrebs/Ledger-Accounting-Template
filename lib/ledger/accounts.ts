import { db } from "@/lib/db/client";
import { bkAccounts, bkLedgerEntities } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { displayEntityName } from "./entity-name";

/**
 * Chart-of-accounts sync: QBO Account list → bk_accounts.
 * Classification + normal balance are derived from QBO AccountType.
 */

export type Classification =
  | "asset"
  | "liability"
  | "equity"
  | "revenue"
  | "expense";
export type NormalBalance = "debit" | "credit";

/** QBO AccountType → {classification, normalBalance}. */
const TYPE_MAP: Record<string, { classification: Classification; normalBalance: NormalBalance }> = {
  Bank: { classification: "asset", normalBalance: "debit" },
  "Accounts Receivable": { classification: "asset", normalBalance: "debit" },
  "Other Current Asset": { classification: "asset", normalBalance: "debit" },
  "Fixed Asset": { classification: "asset", normalBalance: "debit" },
  "Other Asset": { classification: "asset", normalBalance: "debit" },
  "Credit Card": { classification: "liability", normalBalance: "credit" },
  "Accounts Payable": { classification: "liability", normalBalance: "credit" },
  "Other Current Liability": { classification: "liability", normalBalance: "credit" },
  "Long Term Liability": { classification: "liability", normalBalance: "credit" },
  Equity: { classification: "equity", normalBalance: "credit" },
  Income: { classification: "revenue", normalBalance: "credit" },
  "Other Income": { classification: "revenue", normalBalance: "credit" },
  "Cost of Goods Sold": { classification: "expense", normalBalance: "debit" },
  Expense: { classification: "expense", normalBalance: "debit" },
  "Other Expense": { classification: "expense", normalBalance: "debit" },
};

export function classifyAccountType(accountType: string): {
  classification: Classification;
  normalBalance: NormalBalance;
} {
  const m = TYPE_MAP[accountType];
  if (!m) throw new Error(`unmapped QBO AccountType: "${accountType}"`);
  return m;
}

/** Ensure a bk_ledger_entities row exists for this realm; return its id. */
export async function ensureLedgerEntity(opts: {
  realmId: string;
  name: string;
  legalName: string;
  taxType: string;
  fiscalYearStart?: string;
}): Promise<string> {
  const existing = await db
    .select({ id: bkLedgerEntities.id })
    .from(bkLedgerEntities)
    .where(eq(bkLedgerEntities.realmId, opts.realmId))
    .limit(1);
  if (existing[0]) return existing[0].id;

  const inserted = await db
    .insert(bkLedgerEntities)
    .values({
      realmId: opts.realmId,
      // Display name is smart-title-cased (QBO sends ALL CAPS); legal_name stays
      // verbatim. See lib/ledger/entity-name.ts. Idempotent — safe for the Wave
      // path's hand-set display names and for re-imports.
      name: displayEntityName(opts.name),
      legalName: opts.legalName,
      taxType: opts.taxType,
      fiscalYearStart: opts.fiscalYearStart ?? "January",
    })
    .returning({ id: bkLedgerEntities.id });
  return inserted[0].id;
}

/** qboAccountId → bk_accounts.id map for an entity (for posting resolution). */
export async function accountIdMap(
  entityId: string
): Promise<Map<string, string>> {
  const rows = await db
    .select({ id: bkAccounts.id, qboAccountId: bkAccounts.qboAccountId })
    .from(bkAccounts)
    .where(eq(bkAccounts.entityId, entityId));
  return new Map(rows.map((r) => [r.qboAccountId, r.id]));
}

export interface SpecialAccounts {
  arQboId: string | null; // default Accounts Receivable
  apQboId: string | null; // default Accounts Payable
  undepositedQboId: string | null; // Undeposited Funds
}

/**
 * Resolve the entity's "system" accounts by QBO type/subtype rather than id, so
 * the importer is multi-tenant (every QBO file has these but with different ids).
 * Invoices/Payments don't name their A/R account and VendorCredits don't name
 * their A/P account — QBO posts to the file's default. We pick the single account
 * of that type; if a file has more than one we throw so it surfaces (rather than
 * silently posting to the wrong one).
 */
export async function specialAccountIds(
  entityId: string
): Promise<SpecialAccounts> {
  const rows = await db
    .select({
      qboAccountId: bkAccounts.qboAccountId,
      accountType: bkAccounts.accountType,
      accountSubtype: bkAccounts.accountSubtype,
      active: bkAccounts.active,
    })
    .from(bkAccounts)
    .where(eq(bkAccounts.entityId, entityId));

  const pick = (label: string, pred: (r: (typeof rows)[number]) => boolean) => {
    const all = rows.filter(pred);
    if (all.length === 0) return null;
    if (all.length === 1) return all[0].qboAccountId;
    const active = all.filter((r) => r.active);
    if (active.length === 1) return active[0].qboAccountId;
    throw new Error(
      `ambiguous ${label}: ${all.length} accounts of this type — cannot pick the default`
    );
  };

  return {
    arQboId: pick("Accounts Receivable", (r) => r.accountType === "Accounts Receivable"),
    apQboId: pick("Accounts Payable", (r) => r.accountType === "Accounts Payable"),
    undepositedQboId: pick(
      "Undeposited Funds",
      (r) => r.accountSubtype === "UndepositedFunds"
    ),
  };
}
