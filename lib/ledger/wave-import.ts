/**
 * Wave accounting CSV → ledger import logic.
 * Shared by the CLI script (scripts/import-wave.mts) and the in-app import UI.
 *
 * Handles two Wave export formats:
 *
 *  A) "Accounting Transactions" (legacy / Pro export)
 *     Columns: Transaction ID, Transaction Date, Account Name, Account Group, ...
 *     One row per journal line; rows with the same Transaction ID form one entry.
 *
 *  B) "Account Transactions" (current Wave UI export)
 *     Columns: ACCOUNT NUMBER, DATE, DESCRIPTION, DEBIT, CREDIT, BALANCE
 *     Per-account bank-register view with a 4-row preamble.
 *     Journal entries are reconstructed by grouping rows that share the same
 *     (date, description) — Wave uses identical descriptions for all lines of
 *     a transaction, so the match is exact.
 *
 * Both return WaveParseResult. The caller doesn't need to know which format
 * was used.
 */

import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";

const { bkAccounts, bkJournalEntries, bkJournalLines } = schema;

// ---------------------------------------------------------------------------
// Shared helpers (pure)
// ---------------------------------------------------------------------------

/** RFC-4180-ish CSV parse (quote-aware). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/** Dollar string → integer cents. Handles "$1,234.56", "-$500", "(200.00)". */
export function toCents(s: string): number {
  const t = (s || "").trim().replace(/,/g, "").replace(/\$/g, "");
  if (!t || t === "-") return 0;
  // Parenthetical negatives: (200.00) → -200
  const neg = t.startsWith("(") && t.endsWith(")");
  const clean = neg ? "-" + t.slice(1, -1) : t;
  return Math.round(parseFloat(clean) * 100) || 0;
}

/** Account name → stable synthetic qboAccountId slug. */
export function accountSlug(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

// ---------------------------------------------------------------------------
// Account classification (Format A — uses Wave's own Account Group column)
// ---------------------------------------------------------------------------

const GROUP: Record<string, { classification: string; normalBalance: "debit" | "credit" }> = {
  Asset:     { classification: "asset",     normalBalance: "debit"  },
  Liability: { classification: "liability", normalBalance: "credit" },
  Equity:    { classification: "equity",    normalBalance: "credit" },
  Income:    { classification: "revenue",   normalBalance: "credit" },
  Expense:   { classification: "expense",   normalBalance: "debit"  },
};

export function subtypeFor(name: string, classification: string): string | null {
  const n = name.toLowerCase();
  if (classification === "expense") {
    if (n.includes("deprec")) return "Depreciation";
    if (n.includes("amort"))  return "Amortization";
    if (n.includes("interest")) return "InterestPaid";
  }
  if (classification === "asset") {
    if (n.includes("accumulated depreciation")) return "AccumulatedDepreciation";
    if (n.includes("accumulated amortization")) return "AccumulatedAmortizationOfOtherAssets";
  }
  return null;
}

export function accountTypeFor(waveType: string, name: string, classification: string): string {
  const t = (waveType || "").toLowerCase();
  const n = name.toLowerCase();
  if (classification === "asset") {
    if (t.includes("cash") || t.includes("bank")) return "Bank";
    if (t.includes("receivable")) return "Accounts Receivable";
    if (n.includes("accumulated amortization")) return "Other Asset";
    if (n.includes("accumulated depreciation")) return "Fixed Asset";
    if (t.includes("property") || t.includes("plant") || t.includes("equipment")) return "Fixed Asset";
    if (t.includes("depreciation")) return "Fixed Asset";
    // Name-based fixed-asset detection for Account Balances imports where
    // waveType is unavailable. Covers common real-estate account names.
    if (
      n.includes("land") ||
      n.includes("building") ||
      n.includes("improvement") ||
      n.includes("furniture") ||
      n.includes("equipment") ||
      n.includes("fixture") ||
      n.includes("ff&e") ||
      n.includes("vehicle") ||
      n.includes("machinery") ||
      n.includes("structure")
    ) return "Fixed Asset";
    if (t.includes("long")) return "Other Asset";
    return "Other Current Asset";
  }
  if (classification === "liability") {
    if (t.includes("payable") && t.includes("account")) return "Accounts Payable";
    if (t.includes("credit card")) return "Credit Card";
    if (t.includes("short") || t.includes("current")) return "Other Current Liability";
    return "Long Term Liability";
  }
  if (classification === "equity") return "Equity";
  if (classification === "revenue") return t.includes("other") ? "Other Income" : "Income";
  if (classification === "expense") return t.includes("cost of goods") ? "Cost of Goods Sold" : "Expense";
  return "Other Current Asset";
}

// ---------------------------------------------------------------------------
// Account classification (Format B — inferred from account name alone)
// ---------------------------------------------------------------------------

interface AccountClass {
  group: string;           // "Asset" | "Liability" | "Equity" | "Income" | "Expense"
  classification: string;
  normalBalance: "debit" | "credit";
  accountType: string;     // QBO-convention account type
}

function classifyByName(name: string): AccountClass {
  const n = name.toLowerCase();

  // Expense — catch "Mortgage Interest", "Mortgage Insurance", "Loan Interest"
  // etc. BEFORE the liability matcher grabs them via /mortgage|loan/.
  if (/mortgage\s*(interest|insurance)|loan\s*interest|interest\s*expense/.test(n))
    return { group: "Expense", classification: "expense", normalBalance: "debit", accountType: "Expense" };


  // Asset — loan costs / deferred financing are amortized assets, not liabilities
  if (/loan cost|financing cost|deferred financing/.test(n))
    return { group: "Asset", classification: "asset", normalBalance: "debit", accountType: "Other Asset" };

  // Liability — match first so "credit card" beats "checking"
  if (/credit card|amex|visa|mastercard|ink card|ink credit|chase ink|discover|citi.*card|citi.*simplicity|citi.*aadvantage|capitalone|capital one/.test(n))
    return { group: "Liability", classification: "liability", normalBalance: "credit", accountType: "Credit Card" };
  if (/kabbage|wave payment/i.test(n))
    return { group: "Liability", classification: "liability", normalBalance: "credit", accountType: "Other Current Liability" };
  if (/chase loc/i.test(n))
    return { group: "Liability", classification: "liability", normalBalance: "credit", accountType: "Long Term Liability" };
  if (/mortgage|loan|sba|eidl|deferred mortgage|line of credit|heloc/.test(n))
    return { group: "Liability", classification: "liability", normalBalance: "credit", accountType: "Long Term Liability" };
  if (/payable/.test(n))
    return { group: "Liability", classification: "liability", normalBalance: "credit", accountType: "Accounts Payable" };
  if (/liability/.test(n))
    return { group: "Liability", classification: "liability", normalBalance: "credit", accountType: "Other Current Liability" };

  // Expense — match before asset so "bank service charges", "bank fees" etc.
  // don't get caught by the /bank/ asset pattern below.
  if (/bank.*(service|fee|charge)|service charge/.test(n))
    return { group: "Expense", classification: "expense", normalBalance: "debit", accountType: "Expense" };

  // Asset
  if (/checking|savings|bank|cash/.test(n))
    return { group: "Asset", classification: "asset", normalBalance: "debit", accountType: "Bank" };
  if (/accumulated depreciation|accum deprec|accumulated amortization|accum amort/.test(n))
    return { group: "Asset", classification: "asset", normalBalance: "credit", accountType: "Fixed Asset" };
  if (/building|improvement|land|equipment|vehicle|furniture/.test(n))
    return { group: "Asset", classification: "asset", normalBalance: "debit", accountType: "Fixed Asset" };
  if (/receivable/.test(n))
    return { group: "Asset", classification: "asset", normalBalance: "debit", accountType: "Accounts Receivable" };
  if (/prepayment|escrow|reserve|clearing|deposit|accrued mortgage|deferred mortgage/.test(n))
    return { group: "Asset", classification: "asset", normalBalance: "debit", accountType: "Other Current Asset" };

  // Equity
  if (/owner|equity|investment|drawing|partner|capital/.test(n))
    return { group: "Equity", classification: "equity", normalBalance: "credit", accountType: "Equity" };

  // Revenue
  if (/income|revenue|rental|rent|interest income|gain/.test(n))
    return { group: "Income", classification: "revenue", normalBalance: "credit", accountType: "Income" };

  // Default: expense
  return { group: "Expense", classification: "expense", normalBalance: "debit", accountType: "Expense" };
}

// ---------------------------------------------------------------------------
// Shared output types
// ---------------------------------------------------------------------------

export interface WaveLine {
  acctName: string;
  group: string;
  acctType: string;
  debit: number;  // cents
  credit: number; // cents
  lineDesc: string;
}

export interface WaveEntry {
  txnId: string;
  date: string;   // YYYY-MM-DD
  name: string;
  memo: string;
  docNum: string;
  lines: WaveLine[];
}

export interface WaveAccountMeta {
  group: string;
  acctType: string;
}

export interface WaveTrialBalance {
  asset: number;
  liability: number;
  equity: number;
  revenue: number;
  expense: number;
}

export interface WavePreview {
  accounts: number;
  entries: number;
  lines: number;
  dateMin: string;
  dateMax: string;
  totalDebitCents: number;
  trialBalance: WaveTrialBalance;
  netIncomeCents: number;
  residualCents: number;
  errors: string[];
  warnings: string[];
  // Transaction-matching stats (Account Transactions format only)
  matchedByDescription: number;
  matchedByAmount: number;
  inferred: number; // balanced via suspense
  sampleEntries: SampleEntry[]; // first 20 for preview table
}

export interface SampleEntry {
  date: string;
  description: string;
  debitAccount: string;
  creditAccount: string;
  amountCents: number;
}

export interface WaveParseResult {
  entries: WaveEntry[];
  acctMeta: Map<string, WaveAccountMeta>;
  preview: WavePreview;
}

// ---------------------------------------------------------------------------
// Format detection
// ---------------------------------------------------------------------------

type WaveFormat = "accounting_transactions" | "account_transactions" | "unknown";

function detectFormat(text: string): WaveFormat {
  // Strip BOM if present
  const clean = text.replace(/^﻿/, "");
  const firstLine = clean.split(/\r?\n/)[0].trim();
  if (firstLine.startsWith("Transaction ID")) return "accounting_transactions";
  if (firstLine === "Account Transactions") return "account_transactions";
  // Also check row 5 for the account transactions header pattern
  const lines = clean.split(/\r?\n/).slice(0, 6);
  for (const l of lines) {
    if (l.startsWith("Transaction ID")) return "accounting_transactions";
    if (l.startsWith("ACCOUNT NUMBER,DATE")) return "account_transactions";
  }
  return "unknown";
}

// ---------------------------------------------------------------------------
// Shared post-parse statistics
// ---------------------------------------------------------------------------

interface PreviewExtras {
  warnings?: string[];
  matchedByDescription?: number;
  matchedByAmount?: number;
  inferred?: number;
}

function buildPreview(
  entries: WaveEntry[],
  acctMeta: Map<string, WaveAccountMeta>,
  extraErrors: string[] = [],
  extras: PreviewExtras = {}
): WavePreview {
  const unbalanced: string[] = [];
  let totalDebitCents = 0;
  for (const e of entries) {
    const dr = e.lines.reduce((s, l) => s + l.debit, 0);
    const cr = e.lines.reduce((s, l) => s + l.credit, 0);
    totalDebitCents += dr;
    if (dr !== cr) unbalanced.push(`${e.date} #${e.txnId} (off by $${((dr - cr) / 100).toFixed(2)})`);
  }

  const csvNet = new Map<string, number>();
  for (const e of entries)
    for (const l of e.lines)
      csvNet.set(l.acctName, (csvNet.get(l.acctName) ?? 0) + l.debit - l.credit);

  const tb: WaveTrialBalance = { asset: 0, liability: 0, equity: 0, revenue: 0, expense: 0 };
  for (const [name, net] of csvNet) {
    const meta = acctMeta.get(name);
    if (!meta) continue;
    const g = GROUP[meta.group];
    if (!g) continue;
    const cls = g.classification as keyof WaveTrialBalance;
    if (cls in tb) tb[cls] += net;
  }

  const netIncomeCents = -(tb.revenue + tb.expense);
  const residualCents = tb.asset + tb.liability + tb.equity + tb.revenue + tb.expense;
  const dates = entries.map((e) => e.date).filter(Boolean).sort();

  const errors: string[] = [
    ...extraErrors,
    ...unbalanced.slice(0, 10).map((u) => `Unbalanced entry: ${u}`),
    ...(unbalanced.length > 10 ? [`…and ${unbalanced.length - 10} more unbalanced entries`] : []),
    ...(residualCents !== 0 ? [`Accounting equation doesn't balance (residual: $${(residualCents / 100).toFixed(2)})`] : []),
  ];

  // Build sample entries (first 20) for the preview table
  const sampleEntries: SampleEntry[] = entries.slice(0, 20).map((e) => {
    const drLine = e.lines.find((l) => l.debit > 0);
    const crLine = e.lines.find((l) => l.credit > 0);
    return {
      date: e.date,
      description: e.name || e.lines[0]?.lineDesc || "",
      debitAccount: drLine?.acctName ?? "—",
      creditAccount: crLine?.acctName ?? "—",
      amountCents: drLine?.debit ?? crLine?.credit ?? 0,
    };
  });

  return {
    accounts: acctMeta.size,
    entries: entries.length,
    lines: entries.reduce((s, e) => s + e.lines.length, 0),
    dateMin: dates[0] ?? "",
    dateMax: dates[dates.length - 1] ?? "",
    totalDebitCents,
    trialBalance: tb,
    netIncomeCents,
    residualCents,
    errors,
    warnings: extras.warnings ?? [],
    matchedByDescription: extras.matchedByDescription ?? entries.length,
    matchedByAmount: extras.matchedByAmount ?? 0,
    inferred: extras.inferred ?? 0,
    sampleEntries,
  };
}

// ---------------------------------------------------------------------------
// Format A: Accounting Transactions parser
// ---------------------------------------------------------------------------

function parseAccountingTransactions(text: string): WaveParseResult {
  const raw = parseCsv(text.replace(/^﻿/, ""));
  if (raw.length < 2) {
    return emptyResult(["CSV appears empty or has no data rows"]);
  }

  const header = raw[0];
  const col = (name: string) => header.indexOf(name);
  const COL = {
    txnId:    col("Transaction ID"),
    date:     col("Transaction Date"),
    acctName: col("Account Name"),
    txnDesc:  col("Transaction Description"),
    lineDesc: col("Transaction Line Description"),
    debit:    col("Debit Amount (Two Column Approach)"),
    credit:   col("Credit Amount (Two Column Approach)"),
    customer: col("Customer"),
    vendor:   col("Vendor"),
    invoice:  col("Invoice Number"),
    bill:     col("Bill Number"),
    memo:     col("Notes / Memo"),
    group:    col("Account Group"),
    acctType: col("Account Type"),
  };

  const missing = (Object.entries(COL) as [string, number][]).filter(([, i]) => i < 0).map(([k]) => k);
  if (missing.length) {
    return emptyResult([`Missing columns: ${missing.join(", ")}. Make sure you're uploading a Wave "Accounting Transactions" export.`]);
  }

  const dataRows = raw.slice(1).filter((r) => r.length > 1 && r[COL.txnId]);
  const byTxn = new Map<string, WaveEntry>();
  const acctMeta = new Map<string, WaveAccountMeta>();

  for (const r of dataRows) {
    const acctName = r[COL.acctName] ?? "";
    const group    = r[COL.group]    ?? "";
    const acctType = r[COL.acctType] ?? "";
    if (!acctMeta.has(acctName)) acctMeta.set(acctName, { group, acctType });

    const txnId = r[COL.txnId];
    let e = byTxn.get(txnId);
    if (!e) {
      e = {
        txnId,
        date:   r[COL.date] ?? "",
        name:   r[COL.txnDesc] || r[COL.customer] || r[COL.vendor] || "",
        memo:   r[COL.memo] ?? "",
        docNum: r[COL.invoice] || r[COL.bill] || "",
        lines:  [],
      };
      byTxn.set(txnId, e);
    }
    e.lines.push({ acctName, group, acctType, debit: toCents(r[COL.debit] ?? ""), credit: toCents(r[COL.credit] ?? ""), lineDesc: r[COL.lineDesc] ?? "" });
  }

  const entries = [...byTxn.values()];
  return { entries, acctMeta, preview: buildPreview(entries, acctMeta) };
}

// ---------------------------------------------------------------------------
// Format B: Account Transactions parser
// ---------------------------------------------------------------------------

function parseAccountTransactions(text: string): WaveParseResult {
  const clean = text.replace(/^﻿/, "");
  const lines = clean.split(/\r?\n/);

  // Find the column header row (ACCOUNT NUMBER,DATE,...)
  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trimStart().startsWith("ACCOUNT NUMBER,DATE")) { headerIdx = i; break; }
  }
  if (headerIdx < 0) return emptyResult(["Could not find column headers in file."]);

  // Parse all rows under the header
  interface RawRow { account: string; date: string; desc: string; dr: number; cr: number; }
  const rawRows: RawRow[] = [];
  const acctMeta = new Map<string, WaveAccountMeta>();
  let currentAcct = "";

  for (const line of lines.slice(headerIdx + 1)) {
    if (!line.trim()) continue;
    // Parse one CSV row
    const parts = parseOneCsvRow(line);
    if (parts.length < 2) continue;

    const col0 = parts[0]?.trim() ?? "";
    const col1 = parts[1]?.trim() ?? "";

    // Account section header: first col empty, second col = account name (not a date)
    if (col0 === "" && col1 && !/^\d{4}-\d{2}-\d{2}$/.test(col1) && col1 !== "Starting Balance" && col1 !== "Ending Balance") {
      currentAcct = col1;
      // Register in acctMeta if new
      if (!acctMeta.has(currentAcct)) {
        const cls = classifyByName(currentAcct);
        acctMeta.set(currentAcct, { group: cls.group, acctType: cls.accountType });
      }
      continue;
    }

    // Transaction row: second col is a YYYY-MM-DD date
    if (!/^\d{4}-\d{2}-\d{2}$/.test(col1)) continue;
    if (!currentAcct) continue;

    const desc = parts[2]?.trim() ?? "";
    const dr   = toCents(parts[3] ?? "");
    const cr   = toCents(parts[4] ?? "");
    if (!dr && !cr) continue;

    rawRows.push({ account: currentAcct, date: col1, desc, dr, cr });
  }

  // Reconstruct journal entries by grouping on (date, description).
  // Wave uses the same description for all lines of a transaction, so this
  // grouping reconstructs the original double-entry entries exactly.
  const grouped = new Map<string, RawRow[]>();
  for (const row of rawRows) {
    const key = `${row.date}\x00${row.desc}`;
    const g = grouped.get(key) ?? [];
    g.push(row);
    grouped.set(key, g);
  }

  const entries: WaveEntry[] = [];
  const warnings: string[] = [];
  let suspenseUsed = 0;
  let txnSeq = 0;

  for (const [key, group] of grouped) {
    const [date, desc] = key.split("\x00");
    const totalDr = group.reduce((s, r) => s + r.dr, 0);
    const totalCr = group.reduce((s, r) => s + r.cr, 0);

    const lines: WaveLine[] = group.map((r) => {
      const meta = acctMeta.get(r.account)!;
      return { acctName: r.account, group: meta.group, acctType: meta.acctType, debit: r.dr, credit: r.cr, lineDesc: desc };
    });

    // If balanced, great. If not, add a suspense line to force balance.
    if (totalDr !== totalCr) {
      const diff = totalDr - totalCr;
      suspenseUsed++;
      const suspenseAcct = "Wave Import Suspense";
      if (!acctMeta.has(suspenseAcct)) {
        acctMeta.set(suspenseAcct, { group: "Asset", acctType: "Other Current Asset" });
      }
      lines.push({
        acctName: suspenseAcct, group: "Asset", acctType: "Other Current Asset",
        debit: diff < 0 ? -diff : 0,
        credit: diff > 0 ? diff : 0,
        lineDesc: "Wave import suspense — counterpart not found",
      });
    }

    txnSeq++;
    entries.push({
      txnId: `acct-txn-${date}-${txnSeq.toString().padStart(6, "0")}`,
      date,
      name: desc,
      memo: "",
      docNum: "",
      lines,
    });
  }

  if (suspenseUsed > 0) {
    warnings.push(`${suspenseUsed} transactions had no matching counterpart and were balanced against "Wave Import Suspense". Review and reclassify after import.`);
  }

  const matchedByDescription = entries.length - suspenseUsed;
  return {
    entries,
    acctMeta,
    preview: buildPreview(entries, acctMeta, [], {
      warnings,
      matchedByDescription,
      matchedByAmount: 0,
      inferred: suspenseUsed,
    }),
  };
}

// Minimal single-row CSV parser (handles quoted fields)
function parseOneCsvRow(line: string): string[] {
  const fields: string[] = [];
  let field = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') { if (line[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { fields.push(field); field = ""; }
    else field += c;
  }
  fields.push(field);
  return fields;
}

function emptyResult(errors: string[]): WaveParseResult {
  return {
    entries: [],
    acctMeta: new Map(),
    preview: {
      accounts: 0, entries: 0, lines: 0, dateMin: "", dateMax: "",
      totalDebitCents: 0,
      trialBalance: { asset: 0, liability: 0, equity: 0, revenue: 0, expense: 0 },
      netIncomeCents: 0, residualCents: 0, errors, warnings: [],
      matchedByDescription: 0, matchedByAmount: 0, inferred: 0, sampleEntries: [],
    },
  };
}

// ---------------------------------------------------------------------------
// Public entry point — auto-detects format
// ---------------------------------------------------------------------------

export function parseWaveCsv(text: string): WaveParseResult {
  const fmt = detectFormat(text);
  if (fmt === "accounting_transactions") return parseAccountingTransactions(text);
  if (fmt === "account_transactions")    return parseAccountTransactions(text);
  return emptyResult([
    "Unrecognised Wave export format. Upload a Wave CSV exported from Accounting → Transactions (either format).",
  ]);
}

// ---------------------------------------------------------------------------
// Import (DB writes — idempotent on txnId)
// ---------------------------------------------------------------------------

export async function importWaveEntries(
  entityId: string,
  result: WaveParseResult
): Promise<{ inserted: number; skipped: number; errors: string[] }> {
  const { entries, acctMeta } = result;
  const errors: string[] = [];

  for (const [name, meta] of acctMeta) {
    if (!GROUP[meta.group]) { errors.push(`Skipped unknown group "${meta.group}" for account "${name}"`); continue; }
    const g = GROUP[meta.group];
    await db
      .insert(bkAccounts)
      .values({
        entityId,
        qboAccountId: accountSlug(name),
        name,
        fullyQualifiedName: name,
        accountType: meta.acctType,
        accountSubtype: subtypeFor(name, g.classification),
        normalBalance: g.normalBalance,
        classification: g.classification,
        active: true,
      })
      .onConflictDoNothing({ target: [bkAccounts.entityId, bkAccounts.qboAccountId] });
  }

  const acctRows = await db
    .select({ id: bkAccounts.id, qboAccountId: bkAccounts.qboAccountId })
    .from(bkAccounts)
    .where(eq(bkAccounts.entityId, entityId));
  const idBySlug = new Map(acctRows.map((r) => [r.qboAccountId, r.id]));

  let inserted = 0;
  let skipped = 0;

  for (const e of entries) {
    // Validate BEFORE any write: every line must resolve to an account and the
    // entry must balance — an unbalanced or unmappable entry is skipped whole,
    // never partially written. (Previously the header inserted first, so a
    // missing mapping left an orphaned, line-less journal entry.)
    const totalDr = e.lines.reduce((s, l) => s + l.debit, 0);
    const totalCr = e.lines.reduce((s, l) => s + l.credit, 0);
    if (totalDr !== totalCr) {
      errors.push(`Entry ${e.txnId} skipped — unbalanced (dr ${totalDr}¢ ≠ cr ${totalCr}¢)`);
      skipped++;
      continue;
    }
    if (e.lines.length < 2) {
      errors.push(`Entry ${e.txnId} skipped — fewer than 2 lines`);
      skipped++;
      continue;
    }
    const lineAccounts = e.lines.map((l) => idBySlug.get(accountSlug(l.acctName)));
    if (lineAccounts.some((id) => !id)) {
      errors.push(`Entry ${e.txnId} skipped — missing account mapping`);
      skipped++;
      continue;
    }

    // Header + all lines commit or roll back together.
    const wrote = await db.transaction(async (tx) => {
      const res = await tx
        .insert(bkJournalEntries)
        .values({
          entityId,
          source: "wave_import",
          qboTxnType: "WaveTxn",
          qboTxnId: e.txnId,
          txnDate: e.date,
          docNum: e.docNum || null,
          name: e.name || null,
          memo: e.memo || null,
          totalCents: totalDr,
          rawQbo: { wave: e.lines },
        })
        .onConflictDoNothing({
          target: [bkJournalEntries.entityId, bkJournalEntries.qboTxnType, bkJournalEntries.qboTxnId],
        })
        .returning({ id: bkJournalEntries.id });
      if (!res[0]) return false; // already imported (idempotent re-run)

      await tx.insert(bkJournalLines).values(
        e.lines.map((l, i) => ({
          entryId: res[0].id,
          accountId: lineAccounts[i]!,
          lineNo: i + 1,
          debitCents: l.debit,
          creditCents: l.credit,
          lineMemo: l.lineDesc || null,
        }))
      );
      return true;
    });
    if (wrote) inserted++;
    else skipped++;
  }

  return { inserted, skipped, errors };
}
