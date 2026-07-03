/**
 * Wave balance-sheet CSV → opening-balance journal entry.
 *
 * Supports two Wave export formats:
 *
 * Format A — "Account Balances" (Accounting → Account Balances → Export CSV)
 *   Row 1: "Account Balances"
 *   Row 3: "Date Range: YYYY-MM-DD to YYYY-MM-DD"
 *   Header: ACCOUNT NUMBER, ACCOUNT, STARTING BALANCE, DEBIT, CREDIT, NET MOVEMENT, ENDING BALANCE
 *   Flat sections: Assets | Liabilities | Equity | Income | Expenses
 *
 * Format B — "Balance Sheet" (Accounting → Balance Sheet → Export CSV)
 *   Row 1: "Balance Sheet"
 *   Row 3: "As of YYYY-MM-DD"
 *   Header: ACCOUNT NUMBER, ACCOUNTS, [date-column]
 *   Two-level sections:
 *     Assets > Cash and Bank | Other Current Assets | Long-term Assets
 *     Liabilities > Current Liabilities | Long-term Liabilities
 *     Equity
 */

import { eq, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { parseCsv, toCents, accountSlug, accountTypeFor, subtypeFor } from "./wave-import";

const { bkAccounts, bkJournalEntries, bkJournalLines } = schema;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BalanceSection = "Assets" | "Liabilities" | "Equity" | "Income" | "Expenses";

export interface BalanceAccount {
  name: string;
  section: BalanceSection;
  endingBalanceCents: number;
  side: "debit" | "credit";
  amountCents: number;
  /** Explicit account type — set by the Balance Sheet parser from sub-section context.
   *  When present, used directly; otherwise derived from section + name in importWaveBalances. */
  accountType?: string;
}

export interface WaveBalancesPreview {
  asOfDate: string;
  accounts: BalanceAccount[];
  totalDebitCents: number;
  totalCreditCents: number;
  residualCents: number;
  totalIncomeCents: number;
  totalExpenseCents: number;
  netIncomeCents: number;
  errors: string[];
  warnings: string[];
}

export interface WaveBalancesParseResult {
  asOfDate: string;
  accounts: BalanceAccount[];
  preview: WaveBalancesPreview;
}

// ---------------------------------------------------------------------------
// Shared section metadata
// ---------------------------------------------------------------------------

export const SECTION_META: Record<BalanceSection, {
  group: string;
  classification: string;
  normalBalance: "debit" | "credit";
}> = {
  Assets:      { group: "Asset",     classification: "asset",     normalBalance: "debit"  },
  Liabilities: { group: "Liability", classification: "liability", normalBalance: "credit" },
  Equity:      { group: "Equity",    classification: "equity",    normalBalance: "credit" },
  Income:      { group: "Income",    classification: "revenue",   normalBalance: "credit" },
  Expenses:    { group: "Expense",   classification: "expense",   normalBalance: "debit"  },
};

const SECTION_NAMES = new Set<string>(["Assets", "Liabilities", "Equity", "Income", "Expenses"]);

function toSection(s: string): BalanceSection | null {
  const t = s.trim();
  if (SECTION_NAMES.has(t)) return t as BalanceSection;
  if (t === "Expense") return "Expenses";
  if (t === "Revenue") return "Income";
  return null;
}

function toBalanceAccount(
  name: string,
  section: BalanceSection,
  endingBalanceCents: number,
  accountType?: string
): BalanceAccount {
  const meta = SECTION_META[section];
  const side: "debit" | "credit" =
    meta.normalBalance === "debit"
      ? endingBalanceCents >= 0 ? "debit" : "credit"
      : endingBalanceCents >= 0 ? "credit" : "debit";
  return { name, section, endingBalanceCents, side, amountCents: Math.abs(endingBalanceCents), accountType };
}

// ---------------------------------------------------------------------------
// Format B — Balance Sheet sub-section → accountType mapping
// ---------------------------------------------------------------------------

type SubSection =
  | "cash_bank"
  | "other_current_asset"
  | "longterm_asset"
  | "current_liability"
  | "longterm_liability"
  | null;

function detectSubSection(s: string): SubSection {
  const t = s.toLowerCase().trim();
  if (t === "cash and bank" || t === "cash & bank") return "cash_bank";
  if (t.includes("other current asset")) return "other_current_asset";
  if (t.includes("long") && t.includes("asset")) return "longterm_asset";
  if (t.includes("current liabilit")) return "current_liability";
  if (t.includes("long") && t.includes("liabilit")) return "longterm_liability";
  return null;
}

function accountTypeFromSubSection(sub: SubSection, name: string): string {
  switch (sub) {
    case "cash_bank":          return "Bank";
    case "other_current_asset": return "Other Current Asset";
    case "longterm_asset":      return accountTypeFor("", name, "asset"); // name-based (land/building/improvements → Fixed Asset)
    case "current_liability":   return "Other Current Liability";
    case "longterm_liability":  return "Long Term Liability";
    default:                    return ""; // caller falls back to accountTypeFor
  }
}

// ---------------------------------------------------------------------------
// Public entry point — auto-detects format
// ---------------------------------------------------------------------------

export function parseWaveBalancesCsv(text: string): WaveBalancesParseResult {
  const raw = parseCsv(text.replace(/^﻿/, ""));
  const errors: string[] = [];
  const warnings: string[] = [];

  const titleRow = (raw[0] ?? []).join("").trim();
  const titleLower = titleRow.toLowerCase();

  if (titleLower.includes("balance sheet")) {
    return parseBalanceSheetFormat(raw, errors, warnings);
  }
  if (titleLower.includes("account balances")) {
    return parseAccountBalancesFormat(raw, errors, warnings);
  }

  return emptyBalancesResult([
    "This doesn't look like a Wave balance export. " +
    "Upload either the Balance Sheet or the Account Balances CSV.",
  ]);
}

// ---------------------------------------------------------------------------
// Format B — Wave "Balance Sheet" report
// ---------------------------------------------------------------------------

function parseBalanceSheetFormat(
  raw: string[][],
  errors: string[],
  warnings: string[]
): WaveBalancesParseResult {
  // Extract as-of date from "As of YYYY-MM-DD"
  let asOfDate = "";
  outer: for (let i = 0; i < Math.min(8, raw.length); i++) {
    for (const c of raw[i]) {
      const m = (c ?? "").match(/as\s+of\s+(\d{4}-\d{2}-\d{2})/i);
      if (m) { asOfDate = m[1]; break outer; }
    }
  }
  if (!asOfDate) {
    warnings.push("Could not extract as-of date. Using today's date.");
    asOfDate = new Date().toISOString().slice(0, 10);
  }

  // Find header row — contains "ACCOUNTS" (Balance Sheet uses plural)
  let headerIdx = -1;
  let valueCol = 2; // default: third column is the date/value column
  for (let i = 0; i < Math.min(10, raw.length); i++) {
    const upper = raw[i].map(c => (c ?? "").trim().toUpperCase());
    if (upper.some(h => h === "ACCOUNTS" || h === "ACCOUNT NUMBER")) {
      headerIdx = i;
      // Value column = last non-empty column header
      for (let j = upper.length - 1; j >= 0; j--) {
        if (upper[j]) { valueCol = j; break; }
      }
      break;
    }
  }
  if (headerIdx < 0) {
    return emptyBalancesResult(["Could not find the column header row in the Balance Sheet export."]);
  }

  const accounts: BalanceAccount[] = [];
  let currentSection: BalanceSection | null = null;
  let currentSubSection: SubSection = null;

  for (let i = headerIdx + 1; i < raw.length; i++) {
    const row = raw[i];
    if (!row || row.every(c => !c?.trim())) continue;

    const col0 = (row[0] ?? "").trim();
    const colA = (row[1] ?? "").trim(); // second column = account name
    const label = colA || col0;

    // Top-level section header?
    const sec = toSection(col0) ?? toSection(colA);
    if (sec) {
      currentSection = sec;
      currentSubSection = null;
      continue;
    }

    if (!currentSection) continue;

    // Sub-section header (Balance Sheet has two levels)?
    const sub = detectSubSection(col0) ?? detectSubSection(colA);
    if (sub) {
      currentSubSection = sub;
      continue;
    }

    // "Retained Earnings" grouping label in equity section (no balance, just a header)
    if (label.toLowerCase() === "retained earnings") continue;

    // Skip total rows
    if (
      col0.toLowerCase().startsWith("total") ||
      colA.toLowerCase().startsWith("total")
    ) continue;

    // Parse account row
    const acctName = label;
    if (!acctName) continue;

    const rawVal = (row[valueCol] ?? "").trim();
    const endingBalanceCents = toCents(rawVal);
    if (endingBalanceCents === 0) continue;

    // Account type: explicit from sub-section, else name-based
    const explicitType = accountTypeFromSubSection(currentSubSection, acctName);
    const accountType = explicitType || undefined; // only set if we have an explicit mapping

    accounts.push(toBalanceAccount(acctName, currentSection, endingBalanceCents, accountType));
  }

  if (accounts.length === 0) {
    errors.push("No account balances found in the Balance Sheet export.");
  }

  // Balance sheet should net to zero (assets = liabilities + equity)
  const totalDebitCents  = accounts.filter(a => a.side === "debit").reduce((s, a) => s + a.amountCents, 0);
  const totalCreditCents = accounts.filter(a => a.side === "credit").reduce((s, a) => s + a.amountCents, 0);
  const residualCents    = totalDebitCents - totalCreditCents;

  if (Math.abs(residualCents) > 200) {
    const sign = residualCents > 0 ? "+" : "";
    errors.push(
      `Balance sheet doesn't balance (residual: ${sign}$${(residualCents / 100).toFixed(2)}). ` +
      `Verify the report is complete in Wave before importing.`
    );
  }

  const preview: WaveBalancesPreview = {
    asOfDate,
    accounts,
    totalDebitCents,
    totalCreditCents,
    residualCents,
    totalIncomeCents: 0,
    totalExpenseCents: 0,
    netIncomeCents: 0, // retained earnings already in equity accounts — no plug needed
    errors,
    warnings,
  };

  return { asOfDate, accounts, preview };
}

// ---------------------------------------------------------------------------
// Format A — Wave "Account Balances" report
// ---------------------------------------------------------------------------

function parseAccountBalancesFormat(
  raw: string[][],
  errors: string[],
  warnings: string[]
): WaveBalancesParseResult {
  // Extract as-of date from "to YYYY-MM-DD" in the first 8 rows
  let asOfDate = "";
  outer: for (let i = 0; i < Math.min(8, raw.length); i++) {
    for (const c of raw[i]) {
      const m = (c ?? "").match(/to\s+(\d{4}-\d{2}-\d{2})/);
      if (m) { asOfDate = m[1]; break outer; }
    }
  }
  if (!asOfDate) {
    warnings.push("Could not extract export date from file. The journal entry will use today's date.");
    asOfDate = new Date().toISOString().slice(0, 10);
  }

  // Find the column header row
  let headerIdx = -1;
  for (let i = 0; i < raw.length; i++) {
    const joined = raw[i].map(c => c?.trim().toUpperCase()).join(",");
    if (joined.startsWith("ACCOUNT NUMBER") || joined.includes(",ACCOUNT,")) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx < 0) {
    return emptyBalancesResult([
      "Could not find the column header row (expected \"ACCOUNT NUMBER,ACCOUNT,...\").",
    ]);
  }

  const header    = raw[headerIdx].map(c => c.trim().toUpperCase());
  const ACCT_COL  = header.findIndex(h => h === "ACCOUNT") !== -1 ? header.findIndex(h => h === "ACCOUNT") : 1;
  const ENDING_COL = header.findIndex(h => h.startsWith("ENDING"));
  if (ENDING_COL < 0) {
    return emptyBalancesResult([
      "Could not find \"ENDING BALANCE\" column. Make sure you're uploading a Wave Account Balances export.",
    ]);
  }

  let currentSection: BalanceSection | null = null;

  interface ParsedAccount { name: string; section: BalanceSection; endingBalanceCents: number; }
  const allParsed: ParsedAccount[] = [];

  for (let i = headerIdx + 1; i < raw.length; i++) {
    const row = raw[i];
    if (!row || row.every(c => !c?.trim())) continue;

    const col0 = (row[0] ?? "").trim();
    const colA = (row[ACCT_COL] ?? "").trim();

    const sec = toSection(col0) ?? toSection(colA);
    if (sec) { currentSection = sec; continue; }

    if (col0.toLowerCase().startsWith("total") || colA.toLowerCase().startsWith("total")) continue;
    if (col0.toLowerCase() === "net income" || colA.toLowerCase() === "net income") continue;
    if (!currentSection) continue;

    const acctName = colA || col0;
    if (!acctName || acctName === "Starting Balance" || acctName === "Ending Balance") continue;

    const endingBalanceCents = toCents((row[ENDING_COL] ?? "").trim());
    if (endingBalanceCents === 0) continue;

    allParsed.push({ name: acctName, section: currentSection, endingBalanceCents });
  }

  if (allParsed.length === 0) {
    errors.push("No account balances found in the file. Make sure the export contains data rows.");
  }

  const bsRaw     = allParsed.filter(a => a.section !== "Income" && a.section !== "Expenses");
  const incomeRaw = allParsed.filter(a => a.section === "Income");
  const expenseRaw = allParsed.filter(a => a.section === "Expenses");

  const accounts: BalanceAccount[] = bsRaw.map(a => toBalanceAccount(a.name, a.section, a.endingBalanceCents));

  // Net income plug: derived from BS residual so it works even when Wave omits I/E sections
  const bsDr = accounts.filter(a => a.side === "debit").reduce((s, a) => s + a.amountCents, 0);
  const bsCr = accounts.filter(a => a.side === "credit").reduce((s, a) => s + a.amountCents, 0);
  const netIncomeCents = bsDr - bsCr;

  if (netIncomeCents !== 0) {
    accounts.push(toBalanceAccount(
      "Historical Net Income",
      "Equity",
      netIncomeCents,
    ));
  }

  const totalDebitCents  = accounts.filter(a => a.side === "debit").reduce((s, a) => s + a.amountCents, 0);
  const totalCreditCents = accounts.filter(a => a.side === "credit").reduce((s, a) => s + a.amountCents, 0);
  const residualCents    = totalDebitCents - totalCreditCents;

  if (residualCents !== 0) {
    const sign = residualCents > 0 ? "+" : "";
    errors.push(
      `Opening balance entry doesn't balance after net-income adjustment ` +
      `(residual: ${sign}$${(residualCents / 100).toFixed(2)}). ` +
      `The Wave books may not balance — verify the report in Wave first.`
    );
  }

  const totalIncomeCents  = incomeRaw.reduce((s, a) => s + Math.abs(a.endingBalanceCents), 0);
  const totalExpenseCents = expenseRaw.reduce((s, a) => s + Math.abs(a.endingBalanceCents), 0);

  const preview: WaveBalancesPreview = {
    asOfDate, accounts, totalDebitCents, totalCreditCents, residualCents,
    totalIncomeCents, totalExpenseCents, netIncomeCents, errors, warnings,
  };

  return { asOfDate, accounts, preview };
}

// ---------------------------------------------------------------------------
// Post opening balances as a single balanced journal entry
// ---------------------------------------------------------------------------

export async function importWaveBalances(
  entityId: string,
  result: WaveBalancesParseResult
): Promise<{ inserted: number; skipped: number; error?: string }> {
  const { asOfDate, accounts } = result;

  const txnId = `opening-balance-${asOfDate}`;

  // Always upsert accounts — even on re-import — so account types are
  // corrected if the first import misclassified them (e.g. "Land" landing as
  // Other Current Asset instead of Fixed Asset).
  for (const acct of accounts) {
    const sectionMeta = SECTION_META[acct.section];
    const classification = sectionMeta.classification;
    // Use explicit accountType from parser (e.g. sub-section context) when available;
    // otherwise fall back to name-based detection.
    const accountType = acct.accountType ?? accountTypeFor("", acct.name, classification);
    const accountSubtype = subtypeFor(acct.name, classification);

    await db
      .insert(bkAccounts)
      .values({
        entityId,
        qboAccountId: accountSlug(acct.name),
        name: acct.name,
        fullyQualifiedName: acct.name,
        accountType,
        accountSubtype,
        normalBalance: sectionMeta.normalBalance,
        classification,
        active: true,
      })
      .onConflictDoUpdate({
        target: [bkAccounts.entityId, bkAccounts.qboAccountId],
        set: {
          accountType:    sql`excluded.account_type`,
          accountSubtype: sql`excluded.account_subtype`,
          normalBalance:  sql`excluded.normal_balance`,
          classification: sql`excluded.classification`,
        },
      });
  }

  // Idempotency check for the journal entry (accounts already fixed above)
  const existingEntries = await db
    .select({ id: bkJournalEntries.id, qboTxnId: bkJournalEntries.qboTxnId })
    .from(bkJournalEntries)
    .where(eq(bkJournalEntries.entityId, entityId));

  if (existingEntries.some(e => e.qboTxnId === txnId)) {
    return { inserted: 0, skipped: accounts.length, error: undefined };
  }

  // Fetch account IDs
  const acctRows = await db
    .select({ id: bkAccounts.id, qboAccountId: bkAccounts.qboAccountId })
    .from(bkAccounts)
    .where(eq(bkAccounts.entityId, entityId));
  const idBySlug = new Map(acctRows.map(r => [r.qboAccountId, r.id]));

  const totalCents = accounts
    .filter(a => a.side === "debit")
    .reduce((s, a) => s + a.amountCents, 0);

  // Validate BEFORE any write. Every parsed account was upserted above, so an
  // unresolvable slug is a bug — fail the import rather than silently dropping
  // the line (a dropped line unbalances the opening entry by its full amount).
  const unresolved = accounts.filter(a => !idBySlug.get(accountSlug(a.name)));
  if (unresolved.length) {
    return {
      inserted: 0,
      skipped: 0,
      error: `Import aborted — ${unresolved.length} account(s) could not be resolved (e.g. "${unresolved[0].name}"). Nothing was written.`,
    };
  }
  // Balance backstop at WRITE time (parse already gates this): the balance-
  // sheet format tolerates a small Wave rounding residual (≤ 200¢); anything
  // beyond that must never reach the journal.
  const writeDr = accounts.filter(a => a.side === "debit").reduce((s, a) => s + a.amountCents, 0);
  const writeCr = accounts.filter(a => a.side === "credit").reduce((s, a) => s + a.amountCents, 0);
  if (Math.abs(writeDr - writeCr) > 200) {
    return {
      inserted: 0,
      skipped: 0,
      error: `Import aborted — opening balances don't balance (dr ${writeDr}¢ vs cr ${writeCr}¢). Nothing was written.`,
    };
  }

  // Header + all lines commit or roll back together.
  await db.transaction(async (tx) => {
    const [entry] = await tx
      .insert(bkJournalEntries)
      .values({
        entityId,
        source: "wave_import",
        qboTxnType: "WaveBalances",
        qboTxnId: txnId,
        txnDate: asOfDate,
        name: `Opening balances as of ${asOfDate}`,
        totalCents,
      })
      .returning({ id: bkJournalEntries.id });

    await tx.insert(bkJournalLines).values(
      accounts.map((acct, i) => ({
        entryId: entry.id,
        accountId: idBySlug.get(accountSlug(acct.name))!,
        lineNo: i + 1,
        debitCents:  acct.side === "debit"  ? acct.amountCents : 0,
        creditCents: acct.side === "credit" ? acct.amountCents : 0,
        lineMemo: `Opening balance — ${acct.name}`,
      }))
    );
  });

  return { inserted: accounts.length, skipped: 0 };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emptyBalancesResult(errors: string[]): WaveBalancesParseResult {
  return {
    asOfDate: "",
    accounts: [],
    preview: {
      asOfDate: "",
      accounts: [],
      totalDebitCents: 0,
      totalCreditCents: 0,
      residualCents: 0,
      totalIncomeCents: 0,
      totalExpenseCents: 0,
      netIncomeCents: 0,
      errors,
      warnings: [],
    },
  };
}
