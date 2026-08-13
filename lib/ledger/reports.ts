import { db } from "@/lib/db/client";
import { bkAccounts, bkJournalEntries, bkJournalLines } from "@/lib/db/schema";
import { eq, sql } from "drizzle-orm";
import { extractParty } from "@/lib/ledger/merchant";

// Re-exported for back-compat: extractParty now lives in the neutral pure
// merchant module (shared by the fingerprint, rules engine, and learner).
export { extractParty };

/**
 * Reporting core — pure reads over the immutable journal. Everything derives
 * from per-account net balances in CENTS (debit − credit, signed).
 *
 *  asset/expense  → natural debit  → positive net = normal balance
 *  liability/equity/revenue → natural credit → negative net = normal balance
 */

export interface AccountBalance {
  qboAccountId: string;
  name: string;
  fullyQualifiedName: string | null;
  accountType: string;
  accountSubtype: string | null;
  classification: string;
  parentQboId: string | null;
  active: boolean;
  activity: string;
  netCents: number; // Σ(debit − credit)
}

/**
 * Net balance per account over an optional date window.
 * `end` only → as-of (balance sheet / trial balance).
 * `start`+`end` → period activity (P&L).
 *
 * The date filter is a CONDITIONAL SUM (not a WHERE) so accounts with no
 * postings in the window still return a row at net 0 — a balance sheet must
 * list every account, even empty ones.
 */
export async function accountBalances(
  entityId: string,
  opts: { start?: string; end?: string } = {}
): Promise<AccountBalance[]> {
  const lo = opts.start
    ? sql`${bkJournalEntries.txnDate} >= ${opts.start}`
    : sql`TRUE`;
  const hi = opts.end
    ? sql`${bkJournalEntries.txnDate} <= ${opts.end}`
    : sql`TRUE`;

  const rows = await db
    .select({
      qboAccountId: bkAccounts.qboAccountId,
      name: bkAccounts.name,
      fullyQualifiedName: bkAccounts.fullyQualifiedName,
      accountType: bkAccounts.accountType,
      accountSubtype: bkAccounts.accountSubtype,
      classification: bkAccounts.classification,
      parentQboId: bkAccounts.parentQboId,
      active: bkAccounts.active,
      activity: bkAccounts.activity,
      netCents:
        sql<number>`COALESCE(SUM(CASE WHEN ${lo} AND ${hi} THEN ${bkJournalLines.debitCents} - ${bkJournalLines.creditCents} ELSE 0 END), 0)::bigint`.as(
          "net_cents"
        ),
    })
    .from(bkAccounts)
    .leftJoin(bkJournalLines, eq(bkJournalLines.accountId, bkAccounts.id))
    .leftJoin(bkJournalEntries, eq(bkJournalEntries.id, bkJournalLines.entryId))
    .where(eq(bkAccounts.entityId, entityId))
    .groupBy(
      bkAccounts.qboAccountId,
      bkAccounts.name,
      bkAccounts.fullyQualifiedName,
      bkAccounts.accountType,
      bkAccounts.accountSubtype,
      bkAccounts.classification,
      bkAccounts.parentQboId,
      bkAccounts.active,
      bkAccounts.activity
    );
  // drizzle returns bigint sums as string under pg — coerce.
  return rows.map((r) => ({ ...r, netCents: Number(r.netCents) }));
}

const PL = new Set(["revenue", "expense"]);

/** Net income (cents) for a period = Σ(credit − debit) over P&L accounts. */
export async function netIncomeCents(
  entityId: string,
  opts: { start?: string; end?: string } = {}
): Promise<number> {
  const bals = await accountBalances(entityId, opts);
  return bals
    .filter((b) => PL.has(b.classification))
    .reduce((s, b) => s - b.netCents, 0); // credit−debit = −net
}

/** Total assets (cents) as of `end` = Σ(debit − credit) over asset accounts. */
export async function totalAssetsCents(
  entityId: string,
  end?: string
): Promise<number> {
  const bals = await accountBalances(entityId, { end });
  return bals
    .filter((b) => b.classification === "asset")
    .reduce((s, b) => s + b.netCents, 0);
}

/** Below-the-line buckets: non-operating / non-cash / one-time expenses. */
export type BelowLineBucket =
  | "interest"
  | "depreciation"
  | "amortization"
  | "one-time"
  | "non-operating";

export const BELOW_LINE_LABEL: Record<BelowLineBucket, string> = {
  interest: "Mortgage interest",
  depreciation: "Depreciation",
  amortization: "Amortization",
  "one-time": "One-time / non-recurring",
  "non-operating": "Non-operating / other",
};

// "One-time" has no QBO flag — identified by a name keyword heuristic (an owner's
// call). Conservative list: words that strongly imply non-recurring,
// avoiding recurring categories like "legal", "repairs", "supplies". Matched
// accounts are itemized below the line so a misfire is visible at a glance.
const ONE_TIME_KEYWORDS = [
  "renovation",
  "remodel",
  "rehab",
  "one-time",
  "one time",
  "nonrecurring",
  "non-recurring",
  "start-up",
  "startup",
  "organizational",
  "formation",
  "acquisition cost",
  "syndication",
  "loan cost", // loan origination / financing costs — non-operating, below the NOI line
  "loan fee",
];

/** Which below-the-line bucket an expense account falls in, or null = operating. */
export function belowLineBucket(b: {
  accountSubtype: string | null;
  accountType?: string | null;
  name: string;
}): BelowLineBucket | null {
  if (b.accountSubtype === "InterestPaid") return "interest";
  if (b.accountSubtype === "Depreciation") return "depreciation";
  if (b.accountSubtype === "Amortization") return "amortization";
  const n = b.name.toLowerCase();
  if (ONE_TIME_KEYWORDS.some((k) => n.includes(k))) return "one-time";
  // QBO's "Other Expense" account type IS non-operating by definition — it sits
  // below ordinary income on QuickBooks' own P&L. So anything booked there
  // (reconciliation discrepancies, misc adjustments, gas/fuel) drops below the
  // NOI line, keeping NOI = true operating result. (Net income is unchanged —
  // this only moves items between operating and below-the-line.)
  if (b.accountType === "Other Expense") return "non-operating";
  return null;
}

export interface PlLine {
  qboAccountId: string;
  name: string;
  classification: string;
  accountSubtype?: string | null; // QBO subtype — drives expense categorization
  amountCents: number; // revenue/expense shown as positive magnitude
  bucket?: BelowLineBucket; // set on below-the-line expense lines
}

// Group operating-expense accounts into standard owner-facing categories. Driven
// primarily by the QBO account SUBTYPE (every entity carries it), with a name
// heuristic only to split the two big rental costs (cleaning vs management) that
// QBO lumps under one CostOfLabor subtype. Universal — a brand-new entity's chart
// classifies with zero per-entity config. Order = how they read on a statement.
export const EXPENSE_CATEGORY_ORDER = [
  "Property management",
  "Cleaning & turnover",
  "Repairs & maintenance",
  "Utilities",
  "Rent & lease",
  "Supplies",
  "Hospitality essentials",
  "Insurance",
  "Property & other taxes",
  "Professional fees",
  "Marketing",
  "Office & admin",
  "Travel & meals",
  "Bank & merchant fees",
  "Other operating",
] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORY_ORDER)[number];

export function expenseCategory(b: { name: string; accountSubtype?: string | null }): ExpenseCategory {
  const n = b.name.toLowerCase();
  const st = b.accountSubtype ?? "";
  // The two headline rental costs share QBO's CostOfLabor subtype — split by name.
  // Prefix match (no trailing \b) so "Cleaning"/"cleaners"/"Management"/"managing"
  // all hit — a trailing \b would miss the plural/gerund forms.
  if (/\b(clean|turnover|laundr)/.test(n)) return "Cleaning & turnover";
  if (/\b(manage|managing|mgmt|property manager)/.test(n)) return "Property management";
  // Guest hospitality consumables (toiletries, coffee, paper goods, welcome
  // items) are a distinct recurring STR cost — break them out of generic
  // Supplies. Name-driven and checked BEFORE the subtype switch because the
  // account subtype varies across entities (SuppliesMaterials / CostOfLaborCos).
  if (/\bhospitality\b|guest essential|guest suppl/.test(n)) return "Hospitality essentials";
  switch (st) {
    case "Utilities":
      return "Utilities";
    case "RentOrLeaseOfBuildings":
    case "EquipmentRental":
    case "Rent":
      return "Rent & lease";
    case "RepairMaintenance":
      return "Repairs & maintenance";
    case "Insurance":
      return "Insurance";
    case "TaxesPaid":
      return "Property & other taxes";
    case "LegalProfessionalFees":
      return "Professional fees";
    case "AdvertisingPromotional":
      return "Marketing";
    case "OfficeGeneralAdministrativeExpenses":
      return "Office & admin";
    case "BankCharges":
      return "Bank & merchant fees";
    case "Travel":
    case "EntertainmentMeals":
    case "GasAndFuel":
      return "Travel & meals";
    case "SuppliesMaterials":
    case "SuppliesMaterialsCogs":
      return "Supplies";
    case "CostOfLaborCos":
    case "ShippingFreightDelivery":
      return "Other operating";
    default:
      // Name fallback for charts without subtypes (Wave imports, hand-created
      // sub-accounts like "Utilities - Electric").
      if (/\butilit/.test(n)) return "Utilities";
      if (/\b(professional|legal|accounting|cpa)\b/.test(n)) return "Professional fees";
      if (/\b(rent|lease|ground lease|land lease)/.test(n)) return "Rent & lease";
      if (/\b(supply|supplies|essential|material)/.test(n)) return "Supplies";
      if (/\b(repair|maintenance|landscap|handyman|pest)/.test(n)) return "Repairs & maintenance";
      if (/\binsurance/.test(n)) return "Insurance";
      if (/\b(tax|license|permit)/.test(n)) return "Property & other taxes";
      return "Other operating";
  }
}

// ── Semantic sub-type split within a category ────────────────────────────────
// A few operating-expense categories roll up to a SINGLE lumped QBO account
// ("Taxes & Licenses", "Legal & Professional Fees"), so the account view shows
// one opaque line for a material number. The real sub-type lives in WHO was paid
// and WHAT FOR — the transaction payee + memo — exactly the way revenueByChannel
// reads the booking channel off the deposit memo. These rules classify each
// expense line into an owner-facing sub-type (CPA vs legal vs design; property
// tax vs business tax vs permits). Presentation-only (the journal is untouched)
// and universal: the keywords are generic KINDS of spend, so a brand-new entity
// classifies with zero per-entity config. Categories with no rules below return
// null and the P&L falls back to its account-level detail.
const SUBTYPE_RULES: Partial<Record<ExpenseCategory, { label: string; re: RegExp }[]>> = {
  "Professional fees": [
    { label: "Accounting & tax prep", re: /(cpa|accountant|accounting|bookkeep|tax prep|tax return|tax service|tax filing|payroll service)/ },
    { label: "Legal", re: /(legal|attorney|lawyer|\blaw\b|law firm|counsel|paralegal|notary)/ },
    { label: "Design & staging", re: /(interior|\bdesign|stager|staging|home stag|decor|architect)/ },
    { label: "Inspection & appraisal", re: /(inspect|apprais|survey|\bengineer)/ },
  ],
  // Order matters (first match wins). Specific fees/permits are peeled off
  // BEFORE the generic city/county-revenue → business-tax catch-all. These rules
  // only run once a line is already in the "Property & other taxes" category
  // (account "Taxes & Licenses"), so context-only signals are safe here: an
  // escrow / 1098 true-up in this account is the property-tax portion, and a
  // bare "City of Portland" / "…Revenue Dept" payment is a city/state tax.
  "Property & other taxes": [
    { label: "Property taxes", re: /(property tax|propert|county tax|tax collector|assessor|escrow|\b1098\b|per 1098|adjusting to actual)/ },
    { label: "Licenses, permits & registration", re: /(secretary of state|sec.{0,4}state|corpdiv|corp div|permit|licens|registration|\bdmv\b|development services|\bbds\b|leaf fee)/ },
    { label: "State & local income/business taxes", re: /(dept of revenue|department of revenue|revenue dept|\brevenue\b|\bdor\b|pro pymt|portland rev|city of portland|\bcity of\b|city tax|excise|business tax|business income|arts tax|corporate activity|franchise tax|income tax)/ },
  ],
};
const SUBTYPE_FALLBACK: Partial<Record<ExpenseCategory, string>> = {
  "Professional fees": "Other professional fees",
  "Property & other taxes": "Other taxes & fees",
};

/** Sub-type label for an expense line, or null if its category has no rules. */
export function expenseSubtype(
  category: ExpenseCategory,
  l: { payee?: string | null; memo?: string | null }
): string | null {
  const rules = SUBTYPE_RULES[category];
  if (!rules) return null;
  const hay = `${l.payee ?? ""} ${l.memo ?? ""}`.toLowerCase();
  for (const r of rules) if (r.re.test(hay)) return r.label;
  return SUBTYPE_FALLBACK[category]!;
}

export interface SubtypeGroup {
  label: string;
  cents: number;
}

/**
 * Sub-type breakdown for the categories that have rules (taxes, professional
 * fees). Built from line-level payee+memo, reusing the SAME expenseCategory /
 * belowLineBucket logic on the SAME lines as profitAndLoss → each category's
 * sub-type lines sum EXACTLY to its operatingExpenseGroups total. Only returns a
 * category when it splits into ≥2 non-zero sub-types (otherwise there's nothing
 * to show and the P&L keeps its account view).
 */
export async function expenseSubtypeGroups(
  entityId: string,
  opts: { start?: string; end?: string; activity?: string } = {}
): Promise<Map<ExpenseCategory, SubtypeGroup[]>> {
  const lo = opts.start ? sql`${bkJournalEntries.txnDate} >= ${opts.start}` : sql`TRUE`;
  const hi = opts.end ? sql`${bkJournalEntries.txnDate} <= ${opts.end}` : sql`TRUE`;
  const actFilter = opts.activity ? sql`AND ${bkAccounts.activity} = ${opts.activity}` : sql``;
  const rows = await db
    .select({
      payee: bkJournalEntries.name,
      memo: sql<string>`COALESCE(${bkJournalLines.lineMemo}, ${bkJournalEntries.memo}, '')`,
      accountName: bkAccounts.name,
      accountType: bkAccounts.accountType,
      accountSubtype: bkAccounts.accountSubtype,
      netCents: sql<number>`(${bkJournalLines.debitCents} - ${bkJournalLines.creditCents})::bigint`,
    })
    .from(bkJournalLines)
    .innerJoin(bkJournalEntries, eq(bkJournalEntries.id, bkJournalLines.entryId))
    .innerJoin(bkAccounts, eq(bkAccounts.id, bkJournalLines.accountId))
    .where(sql`${bkAccounts.entityId} = ${entityId} AND ${bkAccounts.classification} = 'expense' AND ${lo} AND ${hi} ${actFilter}`);

  const acc = new Map<ExpenseCategory, Map<string, number>>();
  for (const r of rows) {
    const net = Number(r.netCents);
    if (net === 0) continue;
    // Exclude below-the-line exactly as profitAndLoss does (same account fields).
    if (belowLineBucket({ accountSubtype: r.accountSubtype, accountType: r.accountType, name: r.accountName }))
      continue;
    const cat = expenseCategory({ name: r.accountName, accountSubtype: r.accountSubtype });
    const sub = expenseSubtype(cat, { payee: r.payee, memo: r.memo });
    if (!sub) continue; // no rules for this category → fall back to account view
    let m = acc.get(cat);
    if (!m) acc.set(cat, (m = new Map()));
    m.set(sub, (m.get(sub) ?? 0) + net);
  }

  const out = new Map<ExpenseCategory, SubtypeGroup[]>();
  for (const [cat, m] of acc) {
    const rules = SUBTYPE_RULES[cat]!;
    const ordered = [...rules.map((r) => r.label), SUBTYPE_FALLBACK[cat]!];
    const groups = ordered
      .map((label) => ({ label, cents: m.get(label) ?? 0 }))
      .filter((g) => g.cents !== 0);
    if (groups.length >= 2) out.set(cat, groups);
  }
  return out;
}

export interface ExpenseGroup {
  category: ExpenseCategory;
  lines: PlLine[];
  totalCents: number;
}
export interface ProfitAndLoss {
  start?: string;
  end?: string;
  revenue: PlLine[];
  /** All expense lines (operating + below-the-line), kept for back-compat. */
  expenses: PlLine[];
  /** Operating expenses only (above the NOI line). */
  operatingExpenses: PlLine[];
  /** Operating expenses grouped into standard categories, ordered for a statement. */
  operatingExpenseGroups: ExpenseGroup[];
  /** Non-operating / non-cash / one-time, ordered interest→deprec→amort→one-time. */
  belowLine: PlLine[];
  totalRevenueCents: number;
  totalExpenseCents: number;
  totalOperatingExpenseCents: number;
  totalBelowLineCents: number;
  noiCents: number; // revenue − operating expenses
  netIncomeCents: number; // noi − below-the-line (ties to QuickBooks)
}

export async function profitAndLoss(
  entityId: string,
  opts: { start?: string; end?: string; activity?: string } = {}
): Promise<ProfitAndLoss> {
  let bals = await accountBalances(entityId, opts);
  if (opts.activity) {
    bals = bals.filter((b) => b.activity === opts.activity);
  }
  const revenue: PlLine[] = [];
  const operatingExpenses: PlLine[] = [];
  const belowLineRaw: PlLine[] = [];
  for (const b of bals) {
    if (b.classification === "revenue") {
      // "Other Income" (gains on sale, interest income) is non-operating — it
      // belongs below the NOI line, not in operating revenue. Carried as a
      // negative below-the-line amount so net income still ties to the books.
      if (b.accountType === "Other Income") {
        belowLineRaw.push({
          qboAccountId: b.qboAccountId,
          name: b.name,
          classification: b.classification,
          accountSubtype: b.accountSubtype,
          amountCents: b.netCents,
          bucket: "non-operating",
        });
        continue;
      }
      revenue.push({
        qboAccountId: b.qboAccountId,
        name: b.name,
        classification: b.classification,
        amountCents: -b.netCents,
      });
    } else if (b.classification === "expense") {
      const bucket = belowLineBucket(b);
      const line: PlLine = {
        qboAccountId: b.qboAccountId,
        name: b.name,
        classification: b.classification,
        accountSubtype: b.accountSubtype,
        amountCents: b.netCents,
        ...(bucket ? { bucket } : {}),
      };
      if (bucket) belowLineRaw.push(line);
      else operatingExpenses.push(line);
    }
  }

  const nz = (ls: PlLine[]) => ls.filter((l) => l.amountCents !== 0);
  const rev = nz(revenue);
  const opEx = nz(operatingExpenses);

  // Order below-the-line consistently: interest → depreciation → amortization → one-time.
  const ORDER: BelowLineBucket[] = ["interest", "depreciation", "amortization", "one-time", "non-operating"];
  const belowLine = nz(belowLineRaw).sort(
    (a, b) => ORDER.indexOf(a.bucket!) - ORDER.indexOf(b.bucket!)
  );

  const totalRevenueCents = rev.reduce((s, l) => s + l.amountCents, 0);
  const totalOperatingExpenseCents = opEx.reduce((s, l) => s + l.amountCents, 0);
  const totalBelowLineCents = belowLine.reduce((s, l) => s + l.amountCents, 0);
  const totalExpenseCents = totalOperatingExpenseCents + totalBelowLineCents;

  // Group operating expenses into standard categories (each ordered, lines desc).
  const byCategory = new Map<ExpenseCategory, PlLine[]>();
  for (const l of opEx) {
    const cat = expenseCategory(l);
    (byCategory.get(cat) ?? byCategory.set(cat, []).get(cat)!).push(l);
  }
  const operatingExpenseGroups: ExpenseGroup[] = EXPENSE_CATEGORY_ORDER.filter((c) =>
    byCategory.has(c)
  ).map((category) => {
    const lines = byCategory.get(category)!.sort((a, b) => b.amountCents - a.amountCents);
    return { category, lines, totalCents: lines.reduce((s, l) => s + l.amountCents, 0) };
  });

  return {
    ...opts,
    revenue: rev,
    expenses: [...opEx, ...belowLine],
    operatingExpenses: opEx,
    operatingExpenseGroups,
    belowLine,
    totalRevenueCents,
    totalExpenseCents,
    totalOperatingExpenseCents,
    totalBelowLineCents,
    noiCents: totalRevenueCents - totalOperatingExpenseCents,
    netIncomeCents: totalRevenueCents - totalExpenseCents,
  };
}

// ============================================================================
// Income by channel — presentation-layer split of rental income by booking
// channel (Airbnb / Booking.com / VRBO / Marriott / Direct), parsed from the
// transaction memo (the channel signal lives in the deposit/line memo, e.g.
// "ORIG CO NAME:AIRBNB…" or a "Booking.com Management" line memo — NOT the QBO
// account, which is a single lumped "Sales"). Non-destructive: the journal is
// untouched. Universal — `hasRealChannel` is false when no channel is detected
// (e.g. a non-rental entity), so the P&L can fall back to the account view.
// Reimbursement/other income (e.g. QBO "Billable Expense Income") that carries
// no channel memo lands in "Other income" — i.e. it's just counted as income,
// no longer a standalone oddly-named line.
// ============================================================================
export interface IncomeChannel {
  key: string;
  label: string;
  cents: number; // revenue magnitude (credit − debit), positive
}

const CHANNEL_ORDER = ["airbnb", "booking", "vrbo", "marriott", "capitalone", "direct", "longterm", "reimbursement", "other"] as const;
const CHANNEL_LABEL: Record<string, string> = {
  airbnb: "Airbnb",
  booking: "Booking.com",
  vrbo: "VRBO",
  marriott: "Marriott (Homes & Villas)",
  capitalone: "Capital One Travel",
  direct: "Direct",
  longterm: "Long-term rental",
  reimbursement: "Reimbursements",
  other: "Other income",
};

/**
 * JS twin of the channel CASE expression in revenueByChannel. `sig` is the same
 * signal that function builds: `(lineMemo | memo | '') || entry.name || account.name`.
 * The two MUST stay in sync — SQL groups income for the statement, this drives
 * the per-channel drill-down. Order matters (first match wins).
 */
export function classifyChannel(sig: string): string {
  const s = sig.toLowerCase();
  if (s.includes("airbnb")) return "airbnb";
  if (s.includes("booking.com") || s.includes("booking com")) return "booking";
  if (s.includes("vrbo") || s.includes("homeaway") || s.includes("expedia")) return "vrbo";
  if (s.includes("marriott") || s.includes("homes & villas") || s.includes("homesandvillas")) return "marriott";
  if (s.includes("capital one")) return "capitalone";
  if (s.includes("long-term") || s.includes("long term") || s.includes("longterm")) return "longterm";
  if (s.includes("billable expense") || s.includes("reimburs")) return "reimbursement";
  if (s.includes("direct")) return "direct";
  return "other";
}

// ── Counterparty (vendor / customer) extraction ─────────────────────────────
// The QBO-assigned name (entry.name) is the gold source, but bank-feed deposits
// often land with NO name and the real party sits in the memo. We recover it
// ONLY from high-confidence, structured patterns (so a wrong guess never gets
// attributed): a Zelle/Venmo "payment from/to NAME", or the originator company
// that precedes "DES:" in a NACHA/ACH descriptor (e.g. "AIRBNB 4977 DES:AIRBNB"
// → Airbnb, "FLAGSTAR DES:LOAN PYMT" → Flagstar). Free-text item descriptions
// ("Propane", "Bath trash can …") are deliberately left UNASSIGNED rather than
// risk a bad attribution. Presentation-only — the journal is never mutated.
// extractParty (+ its helpers) moved to lib/ledger/merchant.ts; imported and
// re-exported at the top of this file. The drill-down below still calls it.

export async function revenueByChannel(
  entityId: string,
  opts: { start?: string; end?: string; activity?: string } = {}
): Promise<{ channels: IncomeChannel[]; totalCents: number; hasRealChannel: boolean }> {
  const lo = opts.start ? sql`${bkJournalEntries.txnDate} >= ${opts.start}` : sql`TRUE`;
  const hi = opts.end ? sql`${bkJournalEntries.txnDate} <= ${opts.end}` : sql`TRUE`;
  const actFilter = opts.activity ? sql`AND ${bkAccounts.activity} = ${opts.activity}` : sql``;
  // Channel signal = per-transaction memo PLUS the account name. The account is
  // often the STRONGER signal: income lands in "Rental Income - Airbnb" /
  // "Rental Income - Long-Term" / "Billable Expense Income" accounts, while the
  // line memo may just read "Management JE" or "Zelle payment". Reading both
  // means Airbnb income booked via a transfer still counts as Airbnb, and the
  // long-term tenant + reimbursements get their own lines instead of being
  // dumped into an opaque "Other income". (3820-style single "Sales" accounts
  // carry no channel in the name, so they fall through to the memo as before.)
  // Entry NAME is included too: Wave/bank-feed deposits carry the channel in
  // the bank descriptor ("ORIG CO NAME:AIRBNB PAYMENTS…"), which the importer
  // stores as the entry name, with memo empty.
  const sig = sql`(COALESCE(${bkJournalLines.lineMemo}, ${bkJournalEntries.memo}, '') || ' ' || COALESCE(${bkJournalEntries.name}, '') || ' ' || ${bkAccounts.name})`;
  // Only apply channel detection to generic income accounts (e.g. "Rental Income",
  // "KP: Rental Income"). Specifically-named accounts like "V: Turo Income" or
  // "R: Commission Income" should show as their account name, not a channel.
  const isGenericIncome = sql`(${bkAccounts.name} ILIKE '%rental income%' OR ${bkAccounts.name} ILIKE '%sales%')`;
  const channelExpr = sql<string>`CASE
    WHEN NOT (${isGenericIncome}) THEN 'other'
    WHEN ${sig} ILIKE '%airbnb%' THEN 'airbnb'
    WHEN ${sig} ILIKE '%booking.com%' OR ${sig} ILIKE '%booking com%' THEN 'booking'
    WHEN ${sig} ILIKE '%vrbo%' OR ${sig} ILIKE '%homeaway%' OR ${sig} ILIKE '%expedia%' THEN 'vrbo'
    WHEN ${sig} ILIKE '%marriott%' OR ${sig} ILIKE '%homes & villas%' OR ${sig} ILIKE '%homesandvillas%' THEN 'marriott'
    WHEN ${sig} ILIKE '%capital one%' THEN 'capitalone'
    WHEN ${sig} ILIKE '%long-term%' OR ${sig} ILIKE '%long term%' OR ${sig} ILIKE '%longterm%' THEN 'longterm'
    WHEN ${sig} ILIKE '%billable expense%' OR ${sig} ILIKE '%reimburs%' THEN 'reimbursement'
    ELSE 'other' END`;

  // Group by (channel, account). Matched booking channels collapse across
  // accounts; the unmatched residual is itemized BY ACCOUNT NAME instead of one
  // opaque "Other income" — so a generic "Rental Income" account reads as
  // "Rental income", interest as "Interest Income", etc. (Same break-the-opaque-
  // bucket idea as the expense sub-types.)
  const rows = await db
    .select({
      channel: sql<string>`${channelExpr}`.as("channel"),
      account: bkAccounts.name,
      net: sql<number>`COALESCE(SUM(${bkJournalLines.creditCents} - ${bkJournalLines.debitCents}), 0)::bigint`.as("net"),
    })
    .from(bkJournalLines)
    .innerJoin(bkJournalEntries, eq(bkJournalEntries.id, bkJournalLines.entryId))
    .innerJoin(bkAccounts, eq(bkAccounts.id, bkJournalLines.accountId))
    .where(
      // Other Income (gains on sale, interest income) sits below the NOI line
      // on the statement, so it's excluded here too — the channel rows must sum
      // to the operating "Total income" they render against.
      sql`${eq(bkAccounts.entityId, entityId)} AND ${bkAccounts.classification} = 'revenue' AND ${bkAccounts.accountType} != 'Other Income' AND ${lo} AND ${hi} ${actFilter}`
    )
    .groupBy(channelExpr, bkAccounts.name);

  const channelCents = new Map<string, number>(); // matched channel → cents
  const otherByAccount = new Map<string, number>(); // residual account name → cents
  for (const r of rows) {
    const net = Number(r.net);
    if (r.channel === "other") otherByAccount.set(r.account, (otherByAccount.get(r.account) ?? 0) + net);
    else channelCents.set(r.channel, (channelCents.get(r.channel) ?? 0) + net);
  }

  // Detect if this is a management company (has KP:-prefixed income accounts)
  const isManagementCo = rows.some((r) => r.account.startsWith("KP:"));
  const channelLabel = (key: string) => {
    const base = CHANNEL_LABEL[key];
    return isManagementCo ? `KP: ${base}` : base;
  };

  const channels: IncomeChannel[] = [];
  for (const key of CHANNEL_ORDER) {
    if (key === "other") continue;
    const cents = channelCents.get(key) ?? 0;
    if (cents !== 0) channels.push({ key, label: channelLabel(key), cents });
  }
  // Residual accounts, largest first, each as its own clearly-named line.
  for (const [account, cents] of [...otherByAccount.entries()].sort((a, b) => b[1] - a[1])) {
    if (cents !== 0) channels.push({ key: `acct:${account}`, label: account, cents });
  }

  const totalCents = channels.reduce((s, c) => s + c.cents, 0);
  // "Real channel" = at least one matched booking channel — gates whether the
  // P&L shows this breakdown or falls back to the plain account list.
  const hasRealChannel = channelCents.size > 0;
  return { channels, totalCents, hasRealChannel };
}

// ============================================================================
// By-address (location dimension) P&L — for multi-unit entities whose journal
// lines carry a `location` tag (e.g. units 508/512/516/520). Directly-
// attributable income & expense show per address; lines with no location
// (shared/pooled opex) land in a "Pooled (LLC)" column. Pure read over the
// immutable journal; only periods/accounts with location data show columns.
// ============================================================================
export interface PlByLocation {
  start?: string;
  end?: string;
  locations: string[]; // ordered address columns, e.g. ["508","512","516","520"]
  hasPooled: boolean; // any null-location P&L activity in the period
  rows: {
    qboAccountId: string;
    name: string;
    classification: "revenue" | "expense";
    perLocation: Record<string, number>; // location → signed magnitude (rev +, exp +)
    pooledCents: number;
    totalCents: number;
  }[];
  /** Column totals keyed by location, plus `pooled` and `total`. */
  revenueTotals: Record<string, number>;
  expenseTotals: Record<string, number>;
  netTotals: Record<string, number>; // revenue − expense per column
}

/** True if any journal line for this entity carries a `location` tag (multi-unit). */
export async function entityHasLocations(entityId: string): Promise<boolean> {
  const r = await db
    .select({ n: sql<number>`COUNT(*)`.as("n") })
    .from(bkJournalLines)
    .innerJoin(bkJournalEntries, eq(bkJournalEntries.id, bkJournalLines.entryId))
    .where(sql`${eq(bkJournalEntries.entityId, entityId)} AND ${bkJournalLines.location} IS NOT NULL`)
    .limit(1);
  return Number(r[0]?.n ?? 0) > 0;
}

export async function profitAndLossByLocation(
  entityId: string,
  opts: { start?: string; end?: string } = {}
): Promise<PlByLocation> {
  const lo = opts.start
    ? sql`${bkJournalEntries.txnDate} >= ${opts.start}`
    : sql`TRUE`;
  const hi = opts.end
    ? sql`${bkJournalEntries.txnDate} <= ${opts.end}`
    : sql`TRUE`;

  const rows = await db
    .select({
      qboAccountId: bkAccounts.qboAccountId,
      name: bkAccounts.name,
      classification: bkAccounts.classification,
      location: bkJournalLines.location,
      netCents: sql<number>`COALESCE(SUM(${bkJournalLines.debitCents} - ${bkJournalLines.creditCents}), 0)::bigint`.as("net_cents"),
    })
    .from(bkJournalLines)
    .innerJoin(bkAccounts, eq(bkAccounts.id, bkJournalLines.accountId))
    .innerJoin(bkJournalEntries, eq(bkJournalEntries.id, bkJournalLines.entryId))
    .where(sql`${eq(bkAccounts.entityId, entityId)} AND ${lo} AND ${hi} AND ${bkAccounts.classification} IN ('revenue','expense') AND ${bkAccounts.activity} = 'Real Estate'`)
    .groupBy(bkAccounts.qboAccountId, bkAccounts.name, bkAccounts.classification, bkJournalLines.location);

  const locSet = new Set<string>();
  for (const r of rows) if (r.location) locSet.add(r.location);
  // numeric-ish address sort (508/512/516/520), fallback lexical
  const locations = [...locSet].sort((a, b) => (Number(a) || 0) - (Number(b) || 0) || a.localeCompare(b));

  const byAcct = new Map<string, PlByLocation["rows"][number]>();
  let hasPooled = false;
  for (const r of rows) {
    const net = Number(r.netCents);
    if (net === 0) continue;
    // revenue is credit-normal → magnitude = -net; expense debit-normal → +net
    const mag = r.classification === "revenue" ? -net : net;
    let row = byAcct.get(r.qboAccountId);
    if (!row) {
      row = {
        qboAccountId: r.qboAccountId,
        name: r.name,
        classification: r.classification as "revenue" | "expense",
        perLocation: {},
        pooledCents: 0,
        totalCents: 0,
      };
      byAcct.set(r.qboAccountId, row);
    }
    if (r.location) row.perLocation[r.location] = (row.perLocation[r.location] || 0) + mag;
    else {
      row.pooledCents += mag;
      hasPooled = true;
    }
    row.totalCents += mag;
  }

  const all = [...byAcct.values()].filter((r) => r.totalCents !== 0);
  all.sort((a, b) =>
    a.classification === b.classification
      ? b.totalCents - a.totalCents
      : a.classification === "revenue"
        ? -1
        : 1
  );

  const cols = [...locations, "pooled", "total"];
  const revenueTotals: Record<string, number> = Object.fromEntries(cols.map((c) => [c, 0]));
  const expenseTotals: Record<string, number> = Object.fromEntries(cols.map((c) => [c, 0]));
  for (const r of all) {
    const t = r.classification === "revenue" ? revenueTotals : expenseTotals;
    for (const loc of locations) t[loc] += r.perLocation[loc] || 0;
    t.pooled += r.pooledCents;
    t.total += r.totalCents;
  }
  const netTotals: Record<string, number> = Object.fromEntries(
    cols.map((c) => [c, revenueTotals[c] - expenseTotals[c]])
  );

  return { ...opts, locations, hasPooled, rows: all, revenueTotals, expenseTotals, netTotals };
}

// ============================================================================
// Entity helpers + statement/ledger/search builders for the UI.
// ============================================================================

import { bkLedgerEntities } from "@/lib/db/schema";
import { and, asc, desc, ilike, or } from "drizzle-orm";

export type ValuationMethod =
  | "income"
  | "market"
  | "equity_stake"
  | "net_asset"
  | "none";

export interface LedgerEntity {
  id: string;
  realmId: string;
  name: string | null;
  nickname: string | null;
  legalName: string | null;
  taxType: string | null;
  importedThrough: string | null;
  valuationMethod: ValuationMethod;
  marketValueCents: number | null;
  marketValueSource: string | null;
  marketValueAsOf: string | null;
  propertyAddress: string | null;
  valuationUrl: string | null;
  parentEntityId: string | null;
  ownershipPct: string | null; // numeric → string; parse at use site
  owners: { name: string; pct: number }[] | null;
}

/** The entity columns every entity read needs — shared by list & single fetch. */
const entityColumns = {
  id: bkLedgerEntities.id,
  realmId: bkLedgerEntities.realmId,
  name: bkLedgerEntities.name,
  nickname: bkLedgerEntities.nickname,
  legalName: bkLedgerEntities.legalName,
  taxType: bkLedgerEntities.taxType,
  importedThrough: bkLedgerEntities.importedThrough,
  valuationMethod: bkLedgerEntities.valuationMethod,
  marketValueCents: bkLedgerEntities.marketValueCents,
  marketValueSource: bkLedgerEntities.marketValueSource,
  marketValueAsOf: bkLedgerEntities.marketValueAsOf,
  propertyAddress: bkLedgerEntities.propertyAddress,
  valuationUrl: bkLedgerEntities.valuationUrl,
  parentEntityId: bkLedgerEntities.parentEntityId,
  ownershipPct: bkLedgerEntities.ownershipPct,
  owners: bkLedgerEntities.owners,
} as const;

/**
 * The ownership % for a person's FIRST NAME within an entity's `owners` list,
 * matched on the first word of each owner's name (case-insensitive). Owner names
 * are full names whose first word is the person's capital-account first name
 * (e.g. "Alice Example" → "Alice"), so this drives the Portfolio Comparison
 * "own share" view without hardcoding anyone. Returns null when the person is
 * not an owner of the entity (shown as none — NEVER falling back to another
 * owner). Shared by /ledger and /comparison; unit-tested.
 */
/**
 * One entry on bk_ledger_entities.owners. `prior` records earlier splits
 * after a buyout/transfer: this owner's pct for transaction dates BEFORE
 * `until` (entries ascending; the top-level pct applies from the last
 * `until` onward). Everything else in the app — true-up, holds, rosters —
 * reads the CURRENT pct and ignores `prior` by design.
 */
export interface OwnerRosterEntry {
  name: string;
  pct: number;
  reportingPct?: number;
  prior?: { until: string; pct: number; reportingPct?: number }[];
}

const basisPct = (
  v: { pct: number; reportingPct?: number },
  basis: "legal" | "reporting"
): number => (basis === "reporting" ? v.reportingPct ?? v.pct : v.pct);

/** The single roster entry matching a first name — or null (not an owner /
 * ambiguous). Never guess another owner's slice: the shared invariant. */
function ownerEntryForFirstName(
  owners: OwnerRosterEntry[] | null | undefined,
  firstName: string | null | undefined
): OwnerRosterEntry | null {
  const first = firstName?.trim().toLowerCase();
  if (!first || !owners) return null;
  const matches = owners.filter(
    (o) => o.name?.trim().split(/\s+/)[0]?.toLowerCase() === first
  );
  return matches.length === 1 ? matches[0] : null;
}

export function ownerPctForFirstName(
  owners: OwnerRosterEntry[] | null | undefined,
  firstName: string | null | undefined,
  // "legal" (default) = pct: the books/taxes/true-up number. "reporting" = the
  // owner's economic share (reportingPct ?? pct) for personal views like
  // /comparison — used when a legal split temporarily parks a partner's stake
  // with someone else (e.g. a member who can't yet legally hold US real estate).
  basis: "legal" | "reporting" = "legal"
): number | null {
  const me = ownerEntryForFirstName(owners, firstName);
  return me ? basisPct(me, basis) ?? null : null;
}

/** The owner's pct on a given date — `prior` entries cover dates before their
 * `until`; the top-level pct covers everything after the last one. */
export function ownerPctForFirstNameAsOf(
  owners: OwnerRosterEntry[] | null | undefined,
  firstName: string | null | undefined,
  basis: "legal" | "reporting",
  dateISO: string
): number | null {
  const me = ownerEntryForFirstName(owners, firstName);
  if (!me) return null;
  for (const p of me.prior ?? []) if (dateISO < p.until) return basisPct(p, basis);
  return basisPct(me, basis);
}

/**
 * A period split into pct-constant segments for one owner. Usually one
 * segment; more only when the period spans an ownership change. Null when
 * the viewer isn't (unambiguously) on the current roster. Pure — the
 * date-splitting is testable without a database.
 */
export function ownerShareSegments(
  owners: OwnerRosterEntry[] | null | undefined,
  firstName: string | null | undefined,
  basis: "legal" | "reporting",
  start: string,
  end: string
): { start: string; end: string; pct: number }[] | null {
  const me = ownerEntryForFirstName(owners, firstName);
  if (!me) return null;
  const cuts = [
    ...new Set((me.prior ?? []).map((p) => p.until).filter((u) => u > start && u <= end)),
  ].sort();
  const bounds = [start, ...cuts];
  return bounds.map((segStart, i) => ({
    start: segStart,
    end: i + 1 < bounds.length ? dayBefore(bounds[i + 1]) : end,
    pct: ownerPctForFirstNameAsOf(owners, firstName, basis, segStart)!,
  }));
}

/**
 * The signed-in owner's share of an entity's net profit over a period,
 * honoring dated ownership changes: each segment earns its era's pct.
 * Costs no extra queries unless the period actually spans a change (the
 * single-segment case reuses the caller's already-computed total).
 */
export async function ownerProfitShareCents(
  entityId: string,
  owners: OwnerRosterEntry[] | null | undefined,
  firstName: string | null | undefined,
  basis: "legal" | "reporting",
  period: { start: string; end: string; activity?: string; excludeDepreciation?: boolean },
  totalNetProfitCents: number
): Promise<number | null> {
  const segments = ownerShareSegments(owners, firstName, basis, period.start, period.end);
  if (!segments) return null;
  if (segments.length === 1) {
    return Math.round((totalNetProfitCents * segments[0].pct) / 100);
  }
  let share = 0;
  for (const seg of segments) {
    const pl = await plSummary(entityId, {
      start: seg.start,
      end: seg.end,
      activity: period.activity,
      excludeDepreciation: period.excludeDepreciation,
    });
    share += Math.round((pl.netProfitCents * seg.pct) / 100);
  }
  return share;
}

export async function listEntities(): Promise<LedgerEntity[]> {
  return db
    .select(entityColumns)
    .from(bkLedgerEntities)
    .orderBy(asc(bkLedgerEntities.name)) as Promise<LedgerEntity[]>;
}

export async function getEntity(id: string): Promise<LedgerEntity | null> {
  const r = await db
    .select(entityColumns)
    .from(bkLedgerEntities)
    .where(eq(bkLedgerEntities.id, id))
    .limit(1);
  return (r[0] as LedgerEntity | undefined) ?? null;
}

/** A balance-sheet account node, nested by QBO parent/child hierarchy. */
export interface BsNode {
  qboAccountId: string;
  name: string; // short account name
  accountType: string;
  accountSubtype: string | null; // QBO subtype — drives fixed-asset class grouping
  ownCents: number; // this account's own balance (normal-balance positive)
  rolledCents: number; // own + all descendants
  depth: number;
  children: BsNode[];
}
/** A labeled balance-sheet subsection (e.g. "Current assets") with a subtotal. */
export interface BsSubsection {
  label: string;
  nodes: BsNode[];
  totalCents: number;
}
export interface BalanceSheet {
  asOf: string;
  assets: BsNode[];
  /** Assets bucketed into standard subsections (Current / Fixed / Other) for a
   *  legible statement. Sums to totalAssetsCents. */
  assetSubsections: BsSubsection[];
  liabilities: BsNode[];
  equity: BsNode[];
  totalAssetsCents: number;
  totalLiabilitiesCents: number;
  equityBookedCents: number;
  netIncomeToDateCents: number; // unclosed, folded into equity
  totalEquityCents: number; // booked + net income
  balanced: boolean;
}

// Section ordering — mirrors how QuickBooks groups a balance sheet.
const BS_TYPE_ORDER = [
  "Bank",
  "Accounts Receivable",
  "Other Current Asset",
  "Fixed Asset",
  "Other Asset",
  "Credit Card",
  "Accounts Payable",
  "Other Current Liability",
  "Long Term Liability",
  "Equity",
];

/**
 * Build the parent/child account tree for one section, with rolled subtotals.
 * `displayCents` is already in normal-balance presentation (positive). Empty
 * subtrees (rolled to 0) are pruned. Returns roots + the section total.
 */
function buildAccountTree(
  accounts: {
    qboAccountId: string;
    name: string;
    accountType: string;
    accountSubtype: string | null;
    parentQboId: string | null;
    displayCents: number;
  }[]
): { roots: BsNode[]; total: number } {
  const nodes = new Map<string, BsNode>();
  for (const a of accounts) {
    nodes.set(a.qboAccountId, {
      qboAccountId: a.qboAccountId,
      name: a.name,
      accountType: a.accountType,
      accountSubtype: a.accountSubtype,
      ownCents: a.displayCents,
      rolledCents: 0,
      depth: 0,
      children: [],
    });
  }
  const roots: BsNode[] = [];
  for (const a of accounts) {
    const node = nodes.get(a.qboAccountId)!;
    const parent = a.parentQboId ? nodes.get(a.parentQboId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  const roll = (n: BsNode): number => {
    n.rolledCents = n.ownCents + n.children.reduce((s, c) => s + roll(c), 0);
    return n.rolledCents;
  };
  roots.forEach(roll);

  const cmp = (a: BsNode, b: BsNode) =>
    BS_TYPE_ORDER.indexOf(a.accountType) -
      BS_TYPE_ORDER.indexOf(b.accountType) || a.name.localeCompare(b.name);
  const sortRec = (arr: BsNode[], depth: number) => {
    arr.sort(cmp);
    for (const n of arr) {
      n.depth = depth;
      sortRec(n.children, depth + 1);
    }
  };
  sortRec(roots, 0);

  const prune = (arr: BsNode[]): BsNode[] =>
    arr
      .filter((n) => n.rolledCents !== 0)
      .map((n) => ({ ...n, children: prune(n.children) }));
  const pruned = prune(roots);
  return { roots: pruned, total: pruned.reduce((s, n) => s + n.rolledCents, 0) };
}

// Standard asset subsections, by QBO account type (universal, zero config). A
// flat list of bank/building/depreciation/land/FF&E/loan-cost accounts is hard
// to read; these headers + subtotals mirror a real balance sheet and naturally
// net accumulated depreciation inside "Fixed assets". Any unmapped type folds
// into "Other assets" so nothing is ever dropped (subtotals still tie to total).
const ASSET_SUBSECTIONS: { label: string; types: string[] }[] = [
  { label: "Current assets", types: ["Bank", "Accounts Receivable", "Other Current Asset"] },
  { label: "Fixed assets", types: ["Fixed Asset"] },
  { label: "Other assets", types: ["Other Asset"] },
];

// ── Fixed-asset class grouping (best-practice PP&E presentation) ──────────────
// A flat list of building / land / accumulated-depreciation / furniture accounts
// isn't how a balance sheet reads. Group them into Real estate (land + buildings
// & improvements, with the related accumulated depreciation nested as a "Less:"
// contra → net), Furniture, fixtures & equipment, and Other fixed assets (which
// also holds movable rental units — tiny houses, Airstreams — that aren't real
// property). Classification is by QBO subtype first, then a generic name
// heuristic, so it works whether the chart came from QBO (subtypes present) or
// Wave (subtypes null). When a single address-named building anchors the real-
// estate class, its land + improvements + depreciation nest under a property-
// address header (e.g. "915 SE 29th Ave" → Building / Land / Less: depreciation),
// matching how QBO sub-accounts already nest 3820. Totals are purely display.
type FaClass = "real-estate" | "ffe" | "other";
const FA_CLASS_LABEL: Record<FaClass, string> = {
  "real-estate": "Real estate",
  ffe: "Furniture, fixtures & equipment",
  other: "Other fixed assets",
};
const FA_CLASS_ORDER: FaClass[] = ["real-estate", "ffe", "other"];

// Movable, titled rental units — NOT real property. Land on wheels (tiny houses,
// Airstreams, trailers, park models) belongs in Other fixed assets, not real
// estate. Checked before the building/"house" keywords so "Tiny House" doesn't
// read as a structure.
const MOVABLE_UNIT = /tiny ?house|tiny ?home|airstream|\btrailer|\brv\b|park model|yurt|camper|motor ?home|mobile home/;

function isDeprecNode(n: BsNode): boolean {
  // Any accumulated-depreciation OR -amortization contra (subtype pattern
  // covers AccumulatedDepreciation + AccumulatedAmortizationOfOtherAssets;
  // the name fallback covers subtype-less Wave charts).
  return (
    /Accumulated(Depreciation|Amortization)/i.test(n.accountSubtype ?? "") ||
    /accumulated (deprec|amort)/i.test(n.name)
  );
}
function isAddressLike(name: string): boolean {
  return /^\s*\d+\s+\S/.test(name); // "915 SE 29th Ave", "3820 SE Belmont"
}

/** Classify a fixed-asset root into a presentation class. */
function faClassOf(n: BsNode): FaClass {
  const st = n.accountSubtype ?? "";
  const name = n.name.toLowerCase();
  if (isDeprecNode(n)) {
    // Net the contra under the class it depreciates — FF&E if it says so, else
    // real estate (buildings dominate and land isn't depreciated).
    return /furnitur|fixture|equipment|appliance/.test(name) ? "ffe" : "real-estate";
  }
  if (MOVABLE_UNIT.test(name)) return "other";
  // Prefix match (no trailing \b) so plurals/gerunds hit — "Buildings",
  // "Lands", "Appliances", "Improvements" would all miss a closing boundary.
  if (/Furniture/i.test(st) || /\b(furnitur|fixtur|applianc|hvac|equipment)/.test(name))
    return "ffe";
  if (
    /Land|Building/i.test(st) ||
    /\b(land|building|improvement|house|cabin|property|structure|real estate)/.test(name) ||
    isAddressLike(n.name)
  )
    return "real-estate";
  return "other";
}

/** Within-class display order: buildings/improvements → land → other → contra. */
function faRank(n: BsNode): number {
  if (isDeprecNode(n)) return 9;
  const name = n.name.toLowerCase();
  if (/\b(building|improvement|house|cabin|structure)/.test(name) || isAddressLike(n.name)) return 0;
  if (/\bland/.test(name)) return 1;
  return 2;
}

const byRank = (a: BsNode, b: BsNode) => faRank(a) - faRank(b) || a.name.localeCompare(b.name);

/** Reassign depths top-down so synthetic parents/children render consistently. */
function setDepths(n: BsNode, depth: number): BsNode {
  return { ...n, depth, children: n.children.map((c) => setDepths(c, depth + 1)) };
}

function makeClassParent(cls: FaClass, kids: BsNode[]): BsNode {
  const children = kids.slice().sort(byRank);
  return {
    qboAccountId: `fa:${cls}`,
    name: FA_CLASS_LABEL[cls],
    accountType: "Fixed Asset",
    accountSubtype: null,
    ownCents: 0,
    rolledCents: children.reduce((s, c) => s + c.rolledCents, 0),
    depth: 0,
    children,
  };
}

/** Build the real-estate class — nested under a property-address header when a
 *  single address-named building anchors it, else a flat "Real estate" group. */
function buildRealEstate(kids: BsNode[]): BsNode {
  const anchors = kids.filter((n) => !isDeprecNode(n) && isAddressLike(n.name) && !MOVABLE_UNIT.test(n.name.toLowerCase()));
  if (anchors.length !== 1) return makeClassParent("real-estate", kids);
  const anchor = anchors[0];
  const loose = kids.filter((n) => n !== anchor);
  // If the anchor already groups sub-accounts (QBO), fold the loose land/
  // depreciation in beside its children; else relabel the leaf to "Building".
  const children = (anchor.children.length ? [...anchor.children, ...loose] : [{ ...anchor, name: "Building" }, ...loose]).sort(byRank);
  const ownCents = anchor.children.length ? anchor.ownCents : 0;
  return {
    qboAccountId: `fa:re:${anchor.qboAccountId}`,
    name: anchor.name, // the property address becomes the group header
    accountType: "Fixed Asset",
    accountSubtype: null,
    ownCents,
    rolledCents: ownCents + children.reduce((s, c) => s + c.rolledCents, 0),
    depth: 0,
    children,
  };
}

/** Wrap flat fixed-asset roots into class-grouped synthetic parent nodes. */
function groupFixedAssets(nodes: BsNode[]): BsNode[] {
  const hasDeprec = nodes.some(isDeprecNode);
  const classes = new Set(nodes.map(faClassOf));
  // Nothing to gain from a single header with no contra to net — leave flat.
  if (classes.size < 2 && !hasDeprec) return nodes;

  const buckets = new Map<FaClass, BsNode[]>();
  for (const n of nodes) {
    const cls = faClassOf(n);
    (buckets.get(cls) ?? buckets.set(cls, []).get(cls)!).push(n);
  }
  const out: BsNode[] = [];
  for (const cls of FA_CLASS_ORDER) {
    const kids = buckets.get(cls);
    if (!kids?.length) continue;
    out.push(cls === "real-estate" ? buildRealEstate(kids) : makeClassParent(cls, kids));
  }
  return out.map((n) => setDepths(n, 0));
}

// Best-practice line-name cleanups (display only): standard contra wording and
// de-pluralized headers. Applied after grouping so classification sees originals.
function relabelAsset(n: BsNode): BsNode {
  let name = n.name;
  if (/^accumulated depreciation/i.test(name)) name = "Less: accumulated depreciation";
  else if (/^accumulated amortization/i.test(name)) name = "Less: accumulated amortization";
  else if (/^lands$/i.test(name)) name = "Land";
  return { ...n, name, children: n.children.map(relabelAsset) };
}

/** Bucket already-sorted asset roots into the standard subsections. */
function assetSubsections(roots: BsNode[]): BsSubsection[] {
  const out: BsSubsection[] = [];
  const used = new Set<BsNode>();
  for (const { label, types } of ASSET_SUBSECTIONS) {
    let nodes = roots.filter((n) => types.includes(n.accountType));
    nodes.forEach((n) => used.add(n));
    if (label === "Fixed assets") nodes = groupFixedAssets(nodes);
    nodes = nodes.map(relabelAsset);
    if (nodes.length)
      out.push({ label, nodes, totalCents: nodes.reduce((s, n) => s + n.rolledCents, 0) });
  }
  const leftover = roots.filter((n) => !used.has(n)).map(relabelAsset);
  if (leftover.length) {
    const other = out.find((s) => s.label === "Other assets");
    const sum = leftover.reduce((s, n) => s + n.rolledCents, 0);
    if (other) {
      other.nodes.push(...leftover);
      other.totalCents += sum;
    } else {
      out.push({ label: "Other assets", nodes: leftover, totalCents: sum });
    }
  }
  return out;
}

/** Balance sheet as of a date. Equity = booked equity + unclosed net income. */
export async function balanceSheet(
  entityId: string,
  asOf: string
): Promise<BalanceSheet> {
  const bals = await accountBalances(entityId, { end: asOf });
  const section = (cls: string, sign: 1 | -1) =>
    bals
      .filter((b) => b.classification === cls)
      .map((b) => ({
        qboAccountId: b.qboAccountId,
        name: b.name,
        accountType: b.accountType,
        accountSubtype: b.accountSubtype,
        parentQboId: b.parentQboId,
        displayCents: sign * b.netCents,
      }));

  const a = buildAccountTree(section("asset", 1));
  const l = buildAccountTree(section("liability", -1));
  const e = buildAccountTree(section("equity", -1));
  const netIncomeToDateCents = await netIncomeCents(entityId, { end: asOf });
  const totalEquityCents = e.total + netIncomeToDateCents;

  return {
    asOf,
    assets: a.roots,
    assetSubsections: assetSubsections(a.roots),
    liabilities: l.roots,
    equity: e.roots,
    totalAssetsCents: a.total,
    totalLiabilitiesCents: l.total,
    equityBookedCents: e.total,
    netIncomeToDateCents,
    totalEquityCents,
    balanced: a.total === l.total + totalEquityCents,
  };
}

export interface GlRow {
  entryId: string;
  txnDate: string;
  qboTxnType: string | null;
  qboTxnId: string | null;
  docNum: string | null;
  name: string | null;
  memo: string | null;
  lineMemo: string | null;
  debitCents: number;
  creditCents: number;
  runningCents: number; // running net (debit − credit)
  editedAt: string | null; // ISO ts of last in-product edit, or null
}

/** General ledger for one account (by qbo account id), chronological. */
export async function generalLedger(
  entityId: string,
  qboAccountId: string,
  opts: { start?: string; end?: string } = {}
): Promise<{ account: AccountBalance | null; rows: GlRow[] }> {
  const acct = (await accountBalances(entityId)).find(
    (a) => a.qboAccountId === qboAccountId
  );
  const lo = opts.start
    ? sql`${bkJournalEntries.txnDate} >= ${opts.start}`
    : sql`TRUE`;
  const hi = opts.end
    ? sql`${bkJournalEntries.txnDate} <= ${opts.end}`
    : sql`TRUE`;

  const rows = await db
    .select({
      entryId: bkJournalEntries.id,
      txnDate: bkJournalEntries.txnDate,
      qboTxnType: bkJournalEntries.qboTxnType,
      qboTxnId: bkJournalEntries.qboTxnId,
      docNum: bkJournalEntries.docNum,
      name: bkJournalEntries.name,
      memo: bkJournalEntries.memo,
      lineMemo: bkJournalLines.lineMemo,
      debitCents: bkJournalLines.debitCents,
      creditCents: bkJournalLines.creditCents,
      editedAt: bkJournalEntries.editedAt,
    })
    .from(bkJournalLines)
    .innerJoin(bkAccounts, eq(bkAccounts.id, bkJournalLines.accountId))
    .innerJoin(
      bkJournalEntries,
      eq(bkJournalEntries.id, bkJournalLines.entryId)
    )
    .where(
      and(
        eq(bkAccounts.entityId, entityId),
        eq(bkAccounts.qboAccountId, qboAccountId),
        sql`${lo} AND ${hi}`
      )
    )
    .orderBy(asc(bkJournalEntries.txnDate), asc(bkJournalEntries.id));

  let running = 0;
  const out: GlRow[] = rows.map((r) => {
    running += Number(r.debitCents) - Number(r.creditCents);
    return {
      ...r,
      debitCents: Number(r.debitCents),
      creditCents: Number(r.creditCents),
      runningCents: running,
      editedAt: r.editedAt ? r.editedAt.toISOString() : null,
    };
  });
  return { account: acct ?? null, rows: out };
}

// ============================================================================
// Full general ledger — every account with activity in the window, each with
// its postings and a running balance (QuickBooks' "General Ledger" report).
// Balance-sheet accounts carry an opening balance into the window; P&L
// accounts open at zero (nominal accounts are periodic). Period debits always
// equal period credits (every entry posts wholly on one date), so the report
// self-checks at the foot.
// ============================================================================

/** Day before `d` (YYYY-MM-DD), for opening-balance as-of queries. */
function dayBefore(d: string): string {
  const [y, m, day] = d.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, day));
  dt.setUTCDate(dt.getUTCDate() - 1);
  return dt.toISOString().slice(0, 10);
}

/** Chart-of-accounts display order for the full general ledger. */
const GL_CLASS_ORDER: Record<string, number> = {
  asset: 0,
  liability: 1,
  equity: 2,
  revenue: 3,
  expense: 4,
};

export interface GlAccountSection {
  qboAccountId: string;
  name: string;
  fullyQualifiedName: string | null;
  accountType: string;
  classification: string;
  /**
   * As-of balance the day before `start` — null for P&L accounts and for an
   * open-ended (all-time) report, where every account opens at zero.
   */
  openingCents: number | null;
  rows: GlRow[];
  debitCents: number; // period total
  creditCents: number; // period total
  endingCents: number; // (opening ?? 0) + period net
}

export async function generalLedgerReport(
  entityId: string,
  opts: { start?: string; end?: string } = {}
): Promise<{
  sections: GlAccountSection[];
  totalDebitCents: number;
  totalCreditCents: number;
}> {
  const lo = opts.start
    ? sql`${bkJournalEntries.txnDate} >= ${opts.start}`
    : sql`TRUE`;
  const hi = opts.end
    ? sql`${bkJournalEntries.txnDate} <= ${opts.end}`
    : sql`TRUE`;

  const lines = await db
    .select({
      qboAccountId: bkAccounts.qboAccountId,
      accountName: bkAccounts.name,
      fullyQualifiedName: bkAccounts.fullyQualifiedName,
      accountType: bkAccounts.accountType,
      classification: bkAccounts.classification,
      entryId: bkJournalEntries.id,
      txnDate: bkJournalEntries.txnDate,
      qboTxnType: bkJournalEntries.qboTxnType,
      qboTxnId: bkJournalEntries.qboTxnId,
      docNum: bkJournalEntries.docNum,
      name: bkJournalEntries.name,
      memo: bkJournalEntries.memo,
      lineMemo: bkJournalLines.lineMemo,
      debitCents: bkJournalLines.debitCents,
      creditCents: bkJournalLines.creditCents,
      editedAt: bkJournalEntries.editedAt,
    })
    .from(bkJournalLines)
    .innerJoin(bkAccounts, eq(bkAccounts.id, bkJournalLines.accountId))
    .innerJoin(
      bkJournalEntries,
      eq(bkJournalEntries.id, bkJournalLines.entryId)
    )
    .where(and(eq(bkAccounts.entityId, entityId), sql`${lo} AND ${hi}`))
    .orderBy(asc(bkJournalEntries.txnDate), asc(bkJournalEntries.id));

  // Opening balances (as of the day before `start`) for balance-sheet accounts.
  const opening = new Map<string, number>();
  if (opts.start) {
    for (const b of await accountBalances(entityId, {
      end: dayBefore(opts.start),
    })) {
      opening.set(b.qboAccountId, b.netCents);
    }
  }

  const byAccount = new Map<string, GlAccountSection>();
  for (const r of lines) {
    let s = byAccount.get(r.qboAccountId);
    if (!s) {
      const isBalanceSheet = !PL.has(r.classification);
      const openingCents =
        opts.start && isBalanceSheet ? (opening.get(r.qboAccountId) ?? 0) : null;
      s = {
        qboAccountId: r.qboAccountId,
        name: r.accountName,
        fullyQualifiedName: r.fullyQualifiedName,
        accountType: r.accountType,
        classification: r.classification,
        openingCents,
        rows: [],
        debitCents: 0,
        creditCents: 0,
        endingCents: openingCents ?? 0,
      };
      byAccount.set(r.qboAccountId, s);
    }
    const debit = Number(r.debitCents);
    const credit = Number(r.creditCents);
    s.debitCents += debit;
    s.creditCents += credit;
    s.endingCents += debit - credit;
    s.rows.push({
      entryId: r.entryId,
      txnDate: r.txnDate,
      qboTxnType: r.qboTxnType,
      qboTxnId: r.qboTxnId,
      docNum: r.docNum,
      name: r.name,
      memo: r.memo,
      lineMemo: r.lineMemo,
      debitCents: debit,
      creditCents: credit,
      runningCents: s.endingCents,
      editedAt: r.editedAt ? r.editedAt.toISOString() : null,
    });
  }

  const sections = [...byAccount.values()].sort(
    (a, b) =>
      (GL_CLASS_ORDER[a.classification] ?? 9) -
        (GL_CLASS_ORDER[b.classification] ?? 9) ||
      (a.fullyQualifiedName ?? a.name).localeCompare(
        b.fullyQualifiedName ?? b.name
      )
  );
  return {
    sections,
    totalDebitCents: sections.reduce((t, s) => t + s.debitCents, 0),
    totalCreditCents: sections.reduce((t, s) => t + s.creditCents, 0),
  };
}

// ============================================================================
// Category / line drill-down — the entries behind ANY P&L line, grouped by
// vendor. A P&L line is not always one account: an expense CATEGORY spans many
// accounts, a SUB-TYPE is derived from payee/memo, an income CHANNEL is parsed
// from the memo. So the drill target is a small descriptor and we re-apply the
// EXACT same classification logic (expenseCategory / expenseSubtype /
// belowLineBucket / classifyChannel) at the line level — the detail therefore
// ties out to the figure on the statement by construction. Pure read.
// ============================================================================
export type DetailTarget = {
  cat?: string; // expense category header (optionally narrowed by `sub`)
  sub?: string; // expense sub-type within `cat`
  acct?: string; // a single qboAccountId (income/expense/below-line line)
  channel?: string; // matched income channel key (airbnb, booking, …)
  racct?: string; // residual income account name (channel = "other")
  bucket?: BelowLineBucket; // a below-the-line bucket (interest, depreciation, …)
};

export interface DetailLine {
  entryId: string;
  txnDate: string;
  qboTxnType: string | null;
  qboTxnId: string | null;
  docNum: string | null;
  party: string | null; // counterparty (vendor for expense, customer for income)
  memo: string | null; // line memo, falling back to entry memo
  accountName: string;
  qboAccountId: string;
  amountCents: number; // P&L-sense magnitude (expense +, income +)
  editedAt: string | null; // ISO ts of last in-product edit, or null
}
export interface DetailPartyGroup {
  party: string; // display label; "(no customer)" / "(no vendor)" when unknown
  lines: DetailLine[];
  subtotalCents: number;
}
export interface CategoryDetail {
  label: string;
  kind: "category" | "subtype" | "account" | "channel" | "bucket";
  /** Income parties are customers; expense parties are vendors. */
  partyKind: "customer" | "vendor";
  parties: DetailPartyGroup[];
  totalCents: number;
  count: number;
}

export async function categoryDetail(
  entityId: string,
  target: DetailTarget,
  opts: { start?: string; end?: string } = {}
): Promise<CategoryDetail> {
  const lo = opts.start ? sql`${bkJournalEntries.txnDate} >= ${opts.start}` : sql`TRUE`;
  const hi = opts.end ? sql`${bkJournalEntries.txnDate} <= ${opts.end}` : sql`TRUE`;

  const rows = await db
    .select({
      entryId: bkJournalEntries.id,
      txnDate: bkJournalEntries.txnDate,
      qboTxnType: bkJournalEntries.qboTxnType,
      qboTxnId: bkJournalEntries.qboTxnId,
      docNum: bkJournalEntries.docNum,
      vendor: bkJournalEntries.name,
      memo: sql<string>`COALESCE(${bkJournalLines.lineMemo}, ${bkJournalEntries.memo}, '')`,
      accountName: bkAccounts.name,
      qboAccountId: bkAccounts.qboAccountId,
      accountType: bkAccounts.accountType,
      accountSubtype: bkAccounts.accountSubtype,
      classification: bkAccounts.classification,
      debitCents: bkJournalLines.debitCents,
      creditCents: bkJournalLines.creditCents,
      editedAt: bkJournalEntries.editedAt,
    })
    .from(bkJournalLines)
    .innerJoin(bkJournalEntries, eq(bkJournalEntries.id, bkJournalLines.entryId))
    .innerJoin(bkAccounts, eq(bkAccounts.id, bkJournalLines.accountId))
    .where(
      sql`${bkAccounts.entityId} = ${entityId} AND ${bkAccounts.classification} IN ('revenue','expense') AND ${lo} AND ${hi}`
    )
    .orderBy(asc(bkJournalEntries.txnDate), asc(bkJournalEntries.id));

  const matched: DetailLine[] = [];
  let label = "Detail";
  let kind: CategoryDetail["kind"] = "category";
  let partyKind: CategoryDetail["partyKind"] = "vendor";

  for (const r of rows) {
    const net = Number(r.debitCents) - Number(r.creditCents);
    if (net === 0) continue;
    let mag: number | null = null;

    if (target.cat) {
      kind = target.sub ? "subtype" : "category";
      if (r.classification !== "expense") continue;
      if (belowLineBucket({ accountSubtype: r.accountSubtype, accountType: r.accountType, name: r.accountName })) continue;
      const cat = expenseCategory({ name: r.accountName, accountSubtype: r.accountSubtype });
      if (cat !== target.cat) continue;
      if (target.sub) {
        const sub = expenseSubtype(cat, { payee: r.vendor, memo: r.memo });
        if (sub !== target.sub) continue;
        label = `${cat} · ${target.sub}`;
      } else {
        label = cat;
      }
      mag = net;
    } else if (target.bucket) {
      kind = "bucket";
      if (r.classification !== "expense") continue;
      const b = belowLineBucket({ accountSubtype: r.accountSubtype, accountType: r.accountType, name: r.accountName });
      if (b !== target.bucket) continue;
      label = BELOW_LINE_LABEL[target.bucket];
      mag = net;
    } else if (target.channel) {
      kind = "channel";
      if (r.classification !== "revenue") continue;
      if (classifyChannel(`${r.memo} ${r.vendor ?? ""} ${r.accountName}`) !== target.channel) continue;
      label = CHANNEL_LABEL[target.channel] ?? target.channel;
      mag = -net;
    } else if (target.racct) {
      kind = "account";
      if (r.classification !== "revenue") continue;
      if (r.accountName !== target.racct) continue;
      if (classifyChannel(`${r.memo} ${r.vendor ?? ""} ${r.accountName}`) !== "other") continue;
      label = target.racct;
      mag = -net;
    } else if (target.acct) {
      kind = "account";
      if (r.qboAccountId !== target.acct) continue;
      label = r.accountName;
      mag = r.classification === "revenue" ? -net : net;
    } else {
      continue;
    }

    if (mag === null || mag === 0) continue;
    partyKind = r.classification === "revenue" ? "customer" : "vendor";
    matched.push({
      entryId: r.entryId,
      txnDate: r.txnDate,
      qboTxnType: r.qboTxnType,
      qboTxnId: r.qboTxnId,
      docNum: r.docNum,
      party: extractParty({ name: r.vendor, lineMemo: r.memo }),
      memo: r.memo || null,
      accountName: r.accountName,
      qboAccountId: r.qboAccountId,
      amountCents: mag,
      editedAt: r.editedAt ? r.editedAt.toISOString() : null,
    });
  }

  // Group by party, alphabetical (A→Z), unknown party last; lines by date.
  const UNKNOWN = "￿"; // sorts last
  const unknownLabel = partyKind === "customer" ? "(no customer)" : "(no vendor)";
  const byParty = new Map<string, DetailLine[]>();
  for (const l of matched) {
    const key = l.party?.trim() || UNKNOWN;
    (byParty.get(key) ?? byParty.set(key, []).get(key)!).push(l);
  }
  const parties: DetailPartyGroup[] = [...byParty.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, lines]) => ({
      party: key === UNKNOWN ? unknownLabel : key,
      lines,
      subtotalCents: lines.reduce((s, l) => s + l.amountCents, 0),
    }));

  const totalCents = matched.reduce((s, l) => s + l.amountCents, 0);
  return { label, kind, partyKind, parties, totalCents, count: matched.length };
}

export interface TxnSearchRow {
  id: string;
  txnDate: string;
  qboTxnType: string | null;
  qboTxnId: string | null;
  docNum: string | null;
  name: string | null;
  memo: string | null;
  totalCents: number;
  /** ISO timestamp of the last in-product edit, or null if never edited. */
  editedAt: string | null;
  lines: {
    accountName: string;
    qboAccountId: string;
    accountType: string;
    debitCents: number;
    creditCents: number;
  }[];
}

/** Transaction list with optional free-text + account filter. */
export async function searchTransactions(
  entityId: string,
  opts: {
    q?: string;
    qboAccountId?: string;
    start?: string;
    end?: string;
    limit?: number;
  } = {}
): Promise<TxnSearchRow[]> {
  const limit = Math.min(opts.limit ?? 100, 10000);
  const conds = [eq(bkJournalEntries.entityId, entityId)];
  if (opts.q) {
    const like = `%${opts.q}%`;
    conds.push(
      or(
        ilike(bkJournalEntries.name, like),
        ilike(bkJournalEntries.memo, like),
        ilike(bkJournalEntries.docNum, like)
      )!
    );
  }
  if (opts.start) conds.push(sql`${bkJournalEntries.txnDate} >= ${opts.start}`);
  if (opts.end) conds.push(sql`${bkJournalEntries.txnDate} <= ${opts.end}`);

  // If filtering by account, restrict to entries that touch it.
  let entryIds: string[] | null = null;
  if (opts.qboAccountId) {
    const hits = await db
      .selectDistinct({ entryId: bkJournalLines.entryId })
      .from(bkJournalLines)
      .innerJoin(bkAccounts, eq(bkAccounts.id, bkJournalLines.accountId))
      .where(
        and(
          eq(bkAccounts.entityId, entityId),
          eq(bkAccounts.qboAccountId, opts.qboAccountId)
        )
      );
    entryIds = hits.map((h) => h.entryId);
    if (entryIds.length === 0) return [];
    conds.push(
      sql`${bkJournalEntries.id} IN (${sql.join(
        entryIds.map((id) => sql`${id}`),
        sql`, `
      )})`
    );
  }

  const entries = await db
    .select({
      id: bkJournalEntries.id,
      txnDate: bkJournalEntries.txnDate,
      qboTxnType: bkJournalEntries.qboTxnType,
      qboTxnId: bkJournalEntries.qboTxnId,
      docNum: bkJournalEntries.docNum,
      name: bkJournalEntries.name,
      memo: bkJournalEntries.memo,
      totalCents: bkJournalEntries.totalCents,
      editedAt: bkJournalEntries.editedAt,
    })
    .from(bkJournalEntries)
    .where(and(...conds))
    .orderBy(desc(bkJournalEntries.txnDate), desc(bkJournalEntries.id))
    .limit(limit);

  if (entries.length === 0) return [];

  const ids = entries.map((e) => e.id);
  const lines = await db
    .select({
      entryId: bkJournalLines.entryId,
      accountName: bkAccounts.name,
      qboAccountId: bkAccounts.qboAccountId,
      accountType: bkAccounts.accountType,
      debitCents: bkJournalLines.debitCents,
      creditCents: bkJournalLines.creditCents,
      lineNo: bkJournalLines.lineNo,
    })
    .from(bkJournalLines)
    .innerJoin(bkAccounts, eq(bkAccounts.id, bkJournalLines.accountId))
    .where(
      sql`${bkJournalLines.entryId} IN (${sql.join(
        ids.map((id) => sql`${id}`),
        sql`, `
      )})`
    )
    .orderBy(asc(bkJournalLines.lineNo));

  const byEntry = new Map<string, TxnSearchRow["lines"]>();
  for (const l of lines) {
    const arr = byEntry.get(l.entryId) ?? [];
    arr.push({
      accountName: l.accountName,
      qboAccountId: l.qboAccountId,
      accountType: l.accountType,
      debitCents: Number(l.debitCents),
      creditCents: Number(l.creditCents),
    });
    byEntry.set(l.entryId, arr);
  }

  return entries.map((e) => ({
    ...e,
    totalCents: Number(e.totalCents),
    editedAt: e.editedAt ? e.editedAt.toISOString() : null,
    lines: byEntry.get(e.id) ?? [],
  }));
}

/** Count of journal entries + min/max txn date for an entity. */
export async function ledgerStats(entityId: string): Promise<{
  entryCount: number;
  firstDate: string | null;
  lastDate: string | null;
}> {
  const r = await db
    .select({
      entryCount: sql<number>`COUNT(*)::int`,
      firstDate: sql<string | null>`MIN(${bkJournalEntries.txnDate})`,
      lastDate: sql<string | null>`MAX(${bkJournalEntries.txnDate})`,
    })
    .from(bkJournalEntries)
    .where(eq(bkJournalEntries.entityId, entityId));
  return {
    entryCount: Number(r[0]?.entryCount ?? 0),
    firstDate: r[0]?.firstDate ?? null,
    lastDate: r[0]?.lastDate ?? null,
  };
}

export interface AnnualOperatingRow {
  year: number;
  revenueCents: number;
  operatingExpenseCents: number;
  noiCents: number; // revenue − operating expenses
  /** Below-NOI: gains on sale, interest income — "Other Income" accounts. A
   * book gain on a disposal (e.g. a depreciated-out asset sold at break-even)
   * is not operating cash flow and must not inflate NOI. */
  otherIncomeCents: number;
  mortgageInterestCents: number; // below-NOI: debt service
  depreciationCents: number; // below-NOI: depreciation + amortization
  /** Below-NOI: non-operating / one-time expenses (QBO "Other Expense" type,
   * renovation/loan-cost/formation, §481(a) and similar catch-up adjustments).
   * Excluded from NOI so it reflects true operating result, but still subtracted
   * in net income so the bridge ties to QuickBooks. */
  belowLineOtherCents: number;
  netIncomeCents: number; // GAAP/tax net income (ties to QuickBooks)
}

/** Operating performance per year: NOI plus the bridge to GAAP net income. */
export async function annualOperating(
  entityId: string,
  years: number[],
  opts: { activity?: string } = {}
): Promise<AnnualOperatingRow[]> {
  // Each year is independent, so fetch them CONCURRENTLY rather than one query
  // per year in series — this is the dominant cost of the entity overview. The
  // per-year math and output order are unchanged (years.map preserves order).
  return Promise.all(
    years.map(async (y): Promise<AnnualOperatingRow> => {
      let bals = await accountBalances(entityId, {
        start: `${y}-01-01`,
        end: `${y}-12-31`,
      });
      if (opts.activity) {
        bals = bals.filter((b) => b.activity === opts.activity);
      }
      let revenueCents = 0;
      let otherIncomeCents = 0;
      let operatingExpenseCents = 0;
      let mortgageInterestCents = 0;
      let depreciationCents = 0;
      let belowLineOtherCents = 0;
      for (const b of bals) {
        if (b.classification === "revenue") {
          if (b.accountType === "Other Income") otherIncomeCents += -b.netCents;
          else revenueCents += -b.netCents;
        } else if (b.classification === "expense") {
          const amt = b.netCents; // debit-normal positive
          // Use the SAME below-the-line classifier as the P&L so the two views
          // agree. Routing only by subtype (the old behavior) left one-time and
          // "Other Expense"-type items — e.g. a §481(a) catch-up adjustment — in
          // operating expense, which could swing a year's NOI deeply negative.
          const bucket = belowLineBucket(b);
          if (bucket === "interest") mortgageInterestCents += amt;
          else if (bucket === "depreciation" || bucket === "amortization")
            depreciationCents += amt;
          else if (bucket) belowLineOtherCents += amt; // one-time, non-operating
          else operatingExpenseCents += amt;
        }
      }
      const noiCents = revenueCents - operatingExpenseCents;
      return {
        year: y,
        revenueCents,
        operatingExpenseCents,
        noiCents,
        otherIncomeCents,
        mortgageInterestCents,
        depreciationCents,
        belowLineOtherCents,
        netIncomeCents:
          noiCents +
          otherIncomeCents -
          mortgageInterestCents -
          depreciationCents -
          belowLineOtherCents,
      };
    })
  );
}

/** Lightweight P&L summary for a single entity + date range + optional activity. */
export async function plSummary(
  entityId: string,
  opts: { start: string; end: string; activity?: string; excludeDepreciation?: boolean }
): Promise<{
  revenueCents: number;
  operatingExpenseCents: number;
  noiCents: number;
  depreciationCents: number;
  interestCents: number;
  totalExpenseCents: number;
  netProfitCents: number;
}> {
  let bals = await accountBalances(entityId, opts);
  if (opts.activity) bals = bals.filter((b) => b.activity === opts.activity);
  let revenueCents = 0;
  let operatingExpenseCents = 0;
  let depreciationCents = 0;
  let interestCents = 0;
  let belowOther = 0;
  for (const b of bals) {
    if (b.classification === "revenue") {
      if (b.accountType !== "Other Income") revenueCents += -b.netCents;
    } else if (b.classification === "expense") {
      const bucket = belowLineBucket(b);
      if (bucket === "interest") interestCents += b.netCents;
      else if (bucket === "depreciation" || bucket === "amortization") depreciationCents += b.netCents;
      else if (bucket) belowOther += b.netCents;
      else operatingExpenseCents += b.netCents;
    }
  }
  const noiCents = revenueCents - operatingExpenseCents;
  const depIncluded = opts.excludeDepreciation ? 0 : depreciationCents;
  const totalExp = operatingExpenseCents + interestCents + depIncluded + belowOther;
  return {
    revenueCents: Number(revenueCents) || 0,
    operatingExpenseCents: Number(operatingExpenseCents) || 0,
    noiCents: Number(noiCents) || 0,
    depreciationCents: Number(depreciationCents) || 0,
    interestCents: Number(interestCents) || 0,
    totalExpenseCents: Number(totalExp) || 0,
    netProfitCents: Number(revenueCents - totalExp) || 0,
  };
}

// ============================================================================
// Capital events — split owner contributions into INITIAL capital (put in
// during the formation fiscal year) vs CAPITAL CALLS (later contributions), and
// list DISTRIBUTIONS separately. Universal: the formation cutoff comes from the
// entity's `formation_date` (UI-editable), falling back to its earliest journal
// txn so it works zero-config for any entity. Strips the "Partner's Equity - " /
// "Partner Distributions - " account-name prefixes to a clean owner label.
// ============================================================================
const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

/** End (inclusive) of the fiscal year that contains `date`, given a fiscal-year
 * start month name (defaults to January → calendar year). Returns YYYY-MM-DD. */
export function fiscalYearEnd(date: string, fiscalYearStart?: string | null): string {
  const startMonth = MONTHS[(fiscalYearStart ?? "January").toLowerCase()] ?? 1;
  const [y, m] = date.split("-").map(Number);
  // FY starts in `startMonth`. If the date's month is before the start month,
  // the FY began the previous calendar year.
  const fyStartYear = m >= startMonth ? y : y - 1;
  // FY end = (start + 12 months) − 1 day.
  const endYear = startMonth === 1 ? fyStartYear : fyStartYear + 1;
  const endMonth = startMonth === 1 ? 12 : startMonth - 1;
  const lastDay = new Date(Date.UTC(endYear, endMonth, 0)).getUTCDate(); // day 0 of next month
  return `${endYear}-${String(endMonth).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
}

const stripOwnerPrefix = (name: string) =>
  name
    .replace(/^Partner['’]?s Equity\s*[-–—]\s*/i, "")
    .replace(/^Partner Distributions\s*[-–—]\s*/i, "")
    .replace(/^Owner['’]?s\s+(Investment|Equity|Draw[s]?)\s*[-–—]?\s*/i, "Owner")
    .trim();

export interface CapitalOwnerEvent {
  name: string;
  qboAccountId: string;
  initialCents: number; // contributed during the formation fiscal year
  capitalCallCents: number; // contributed after the formation fiscal year
  totalContributedCents: number; // initial + capital calls
}
export interface CapitalEvents {
  formationDate: string; // resolved (entity.formation_date or earliest txn)
  formationDateExplicit: boolean; // false = fell back to earliest txn
  initialCutoff: string; // end of the formation fiscal year (initial ≤ this date)
  owners: CapitalOwnerEvent[]; // contribution owners, by total contributed desc
  distributions: { name: string; qboAccountId: string; cents: number }[];
  totalInitialCents: number;
  totalCapitalCallCents: number;
  totalContributedCents: number;
  totalDistributionsCents: number;
}

export async function capitalEvents(
  entityId: string,
  asOf: string
): Promise<CapitalEvents> {
  const ent = await db
    .select({
      formationDate: bkLedgerEntities.formationDate,
      fiscalYearStart: bkLedgerEntities.fiscalYearStart,
    })
    .from(bkLedgerEntities)
    .where(eq(bkLedgerEntities.id, entityId))
    .limit(1);
  const fyStart = ent[0]?.fiscalYearStart ?? "January";

  // Resolve formation date: explicit entity field, else earliest journal txn.
  let formationDate = ent[0]?.formationDate ?? null;
  const formationDateExplicit = !!formationDate;
  if (!formationDate) {
    const f = await db
      .select({ first: sql<string>`MIN(${bkJournalEntries.txnDate})`.as("first") })
      .from(bkJournalEntries)
      .where(eq(bkJournalEntries.entityId, entityId));
    formationDate = f[0]?.first ?? asOf;
  }
  const initialCutoff = fiscalYearEnd(formationDate, fyStart);

  // Per equity account, three figures:
  //   initialIn   — net capital in (credit − debit) through the formation FY,
  //                 ALL entries (so founder ownership reflects inter-partner
  //                 reshuffles like a loan that funds one partner's capital).
  //   cashCallIn  — post-formation real capital contributions. A real call is
  //                 new value in; an earnings allocation or tax-basis true-up is
  //                 not. Those non-contribution entries ALWAYS touch Retained
  //                 Earnings or the S-corp Accumulated Adjustments account, so we
  //                 exclude any entry that has an RE/AAA line. (Entry TYPE and
  //                 cash/bank movement are both unreliable — real contributions
  //                 are sometimes JournalEntries funded by a receivable, with no
  //                 bank line.) This is what kills the nonsensical "negative
  //                 capital calls" without dropping legitimate contributions.
  //   allIn       — net over all dates, used to total distribution accounts.
  const isEarningsAllocation = sql`EXISTS (SELECT 1
       FROM bk_journal_lines bl JOIN bk_accounts ba ON ba.id = bl.account_id
       WHERE bl.entry_id = ${bkJournalEntries.id}
         AND ba.account_subtype IN ('RetainedEarnings', 'AccumulatedAdjustment'))`;
  const rows = await db
    .select({
      qboAccountId: bkAccounts.qboAccountId,
      name: bkAccounts.name,
      accountSubtype: bkAccounts.accountSubtype,
      initialIn: sql<number>`COALESCE(SUM(CASE WHEN ${bkJournalEntries.txnDate} <= ${initialCutoff} THEN ${bkJournalLines.creditCents} - ${bkJournalLines.debitCents} ELSE 0 END), 0)::bigint`.as("initial_in"),
      cashCallIn: sql<number>`COALESCE(SUM(CASE WHEN ${bkJournalEntries.txnDate} > ${initialCutoff} AND NOT ${isEarningsAllocation} THEN ${bkJournalLines.creditCents} - ${bkJournalLines.debitCents} ELSE 0 END), 0)::bigint`.as("cash_call_in"),
      allIn: sql<number>`COALESCE(SUM(${bkJournalLines.creditCents} - ${bkJournalLines.debitCents}), 0)::bigint`.as("all_in"),
    })
    .from(bkAccounts)
    .innerJoin(bkJournalLines, eq(bkJournalLines.accountId, bkAccounts.id))
    .innerJoin(bkJournalEntries, eq(bkJournalEntries.id, bkJournalLines.entryId))
    .where(
      sql`${eq(bkAccounts.entityId, entityId)} AND ${bkAccounts.classification} = 'equity' AND ${bkJournalEntries.txnDate} <= ${asOf}`
    )
    .groupBy(bkAccounts.qboAccountId, bkAccounts.name, bkAccounts.accountSubtype);

  const owners: CapitalOwnerEvent[] = [];
  const distributions: CapitalEvents["distributions"] = [];
  for (const r of rows) {
    const initialIn = Number(r.initialIn);
    const cashCallIn = Number(r.cashCallIn);
    const allIn = Number(r.allIn);
    // Retained earnings, accumulated adjustments (S-corp AAA), and opening
    // balance are accumulated earnings / plugs — not capital owners put in.
    if (
      isAccumulatedEarningsEquity(r.accountSubtype) ||
      r.accountSubtype === "OpeningBalanceEquity"
    )
      continue;
    if (isDistributionEquity({ name: r.name, accountSubtype: r.accountSubtype })) {
      // Distribution accounts are debit-normal: capital OUT = −(net credit − debit).
      const out = -allIn;
      if (out !== 0)
        distributions.push({ name: stripOwnerPrefix(r.name), qboAccountId: r.qboAccountId, cents: out });
      continue;
    }
    if (initialIn === 0 && cashCallIn === 0) continue;
    // A post-formation NET WITHDRAWAL (cashCallIn < 0) is a return of capital —
    // a distribution booked straight into the partner's capital account, not a
    // "negative capital call." Route it to distributions so calls are never
    // negative, and don't let it reduce the contributed-capital basis.
    if (cashCallIn < 0) {
      distributions.push({
        name: stripOwnerPrefix(r.name),
        qboAccountId: r.qboAccountId,
        cents: -cashCallIn,
      });
      if (initialIn !== 0)
        owners.push({
          name: stripOwnerPrefix(r.name),
          qboAccountId: r.qboAccountId,
          initialCents: initialIn,
          capitalCallCents: 0,
          totalContributedCents: initialIn,
        });
      continue;
    }
    owners.push({
      name: stripOwnerPrefix(r.name),
      qboAccountId: r.qboAccountId,
      initialCents: initialIn,
      capitalCallCents: cashCallIn,
      totalContributedCents: initialIn + cashCallIn,
    });
  }
  owners.sort((a, b) => b.totalContributedCents - a.totalContributedCents);
  distributions.sort((a, b) => b.cents - a.cents);

  const totalInitialCents = owners.reduce((s, o) => s + o.initialCents, 0);
  const totalCapitalCallCents = owners.reduce((s, o) => s + o.capitalCallCents, 0);
  const totalDistributionsCents = distributions.reduce((s, d) => s + d.cents, 0);
  return {
    formationDate,
    formationDateExplicit,
    initialCutoff,
    owners,
    distributions,
    totalInitialCents,
    totalCapitalCallCents,
    totalContributedCents: totalInitialCents + totalCapitalCallCents,
    totalDistributionsCents,
  };
}

export interface CapitalStructure {
  asOf: string;
  totalLiabilitiesCents: number; // all debt
  mortgageDebtCents: number; // long-term liabilities
  otherDebtCents: number; // intercompany, security deposits, etc.
  contributedCapitalCents: number; // ORIGINAL capital owners put IN — contributions only, NOT net of distributions and NOT reduced by depreciation/losses (excludes Retained Earnings + unclosed net income). This is the invested basis.
  distributionsCents: number; // cumulative capital taken back OUT (distributions/draws), positive magnitude — tracked SEPARATELY, never netted into the basis
  netIncomeToDateCents: number; // the depreciation/loss erosion, shown separately
  bookEquityCents: number; // contributed − distributions + net income (GAAP)
  totalAssetsCents: number; // current depreciated book value
  totalInvestedCents: number; // debt + contributed capital — capital actually deployed
}

/**
 * Owner distributions / draws — equity accounts that take capital back OUT
 * (QBO subtype `PartnerDistributions`, or a draw/distribution-named account).
 * Kept separate from contributed capital so the invested BASIS stays the
 * ORIGINAL capital put in: distributions are a return OF capital (tracked on
 * their own line), and only the depreciation tax benefit reduces the basis.
 */
/**
 * Equity subtypes that represent accumulated EARNINGS, not capital the owners
 * contributed — excluded from contributed-capital / capital-by-owner the same
 * way Retained Earnings is. An S-corp's Accumulated Adjustments Account (AAA)
 * holds undistributed earnings, so counting it as "contributed capital" both
 * mislabels it and (when it carries a debit balance) drags the basis negative.
 */
export function isAccumulatedEarningsEquity(subtype: string | null): boolean {
  return subtype === "RetainedEarnings" || subtype === "AccumulatedAdjustment";
}

export function isDistributionEquity(b: {
  name: string;
  accountSubtype: string | null;
}): boolean {
  if (b.accountSubtype === "PartnerDistributions") return true;
  // Match singular OR plural ("Distribution", "Distributions", "Draw", "Draws").
  // QBO doesn't always stamp the PartnerDistributions subtype — some partner
  // distribution accounts come back nested under a Partner's Equity parent with
  // subtype `PartnersEquity` — so the name is the reliable fallback signal.
  return /\b(distributions?|draws?)\b/i.test(b.name);
}

/**
 * Capital by owner — ONE row per member showing actual capital CONTRIBUTED and
 * actual capital DISTRIBUTED, from current account balances (not the gross
 * date-split history `capitalEvents` uses for the invested-basis hero). Each
 * member's multiple equity accounts ("- Capital", "- Contributed Capital",
 * "Partner Distributions - X") collapse to a single owner; Retained Earnings,
 * Opening Balance Equity and any unassigned generic "Partner's Equity" header
 * fold into the separate accumulated-earnings line (never shown as an owner).
 * Deliberately net-balance based so it reads cleanly off a restated chart and
 * never double-counts a member who holds two accounts.
 */
const ownerKeyFromName = (name: string) =>
  name
    .replace(/^Partner Distributions\s*[-–—]\s*/i, "")
    .replace(/\s*[-–—]\s*(Contributed Capital|Capital Account|Capital)$/i, "")
    .trim();

export interface CapitalOwnerLine {
  name: string;
  contributedCents: number; // capital put in
  distributedCents: number; // capital taken out (positive magnitude)
}
export interface CapitalByOwner {
  owners: CapitalOwnerLine[];
  totalContributedCents: number;
  totalDistributedCents: number;
  accumulatedEarningsCents: number; // RE + opening + unassigned — not an owner
}

export async function capitalByOwner(
  entityId: string,
  asOf: string
): Promise<CapitalByOwner> {
  const bals = await accountBalances(entityId, { end: asOf });
  const owners = new Map<string, CapitalOwnerLine>();
  let accumulatedEarningsCents = 0;
  for (const b of bals) {
    if (b.classification !== "equity" || !b.active) continue;
    const creditPos = -b.netCents; // credit-normal positive
    const isHeaderOrEarnings =
      isAccumulatedEarningsEquity(b.accountSubtype) ||
      b.accountSubtype === "OpeningBalanceEquity" ||
      /^Partner['’]?s Equity$/i.test(b.name); // the generic unassigned header
    if (isHeaderOrEarnings) {
      accumulatedEarningsCents += creditPos;
      continue;
    }
    const key = ownerKeyFromName(b.name);
    const row = owners.get(key) ?? {
      name: key,
      contributedCents: 0,
      distributedCents: 0,
    };
    if (isDistributionEquity({ name: b.name, accountSubtype: b.accountSubtype })) {
      row.distributedCents += -creditPos; // debit-normal → magnitude out
    } else {
      row.contributedCents += creditPos;
    }
    owners.set(key, row);
  }
  const list = [...owners.values()]
    .filter((o) => o.contributedCents !== 0 || o.distributedCents !== 0)
    .sort((a, b) => b.contributedCents - a.contributedCents);
  return {
    owners: list,
    totalContributedCents: list.reduce((s, o) => s + o.contributedCents, 0),
    totalDistributedCents: list.reduce((s, o) => s + o.distributedCents, 0),
    accumulatedEarningsCents,
  };
}

/**
 * Capital deployed into the property: debt + ORIGINAL contributed equity.
 * Deliberately uses contributed capital (not book equity) so depreciation and
 * accumulated losses do NOT reduce "owner equity" / "total investment".
 */
export async function capitalStructure(
  entityId: string,
  asOf: string
): Promise<CapitalStructure> {
  // All three are independent — run concurrently instead of fetching net income
  // in a second round-trip after the first two.
  const [bals, capEvents, netIncomeToDateCents] = await Promise.all([
    accountBalances(entityId, { end: asOf }),
    capitalEvents(entityId, asOf),
    netIncomeCents(entityId, { end: asOf }),
  ]);
  let totalLiabilitiesCents = 0;
  let mortgageDebtCents = 0;
  let totalAssetsCents = 0;
  for (const b of bals) {
    if (b.classification === "liability") {
      const credit = -b.netCents;
      totalLiabilitiesCents += credit;
      if (b.accountType === "Long Term Liability") mortgageDebtCents += credit;
    } else if (b.classification === "asset") {
      totalAssetsCents += b.netCents;
    }
  }
  // Contributed capital + distributions come from capitalEvents (the single
  // source of truth) so the hero, the Capital-structure panel, and Capital-by-
  // owner always agree. Contributed = cash owners put in (initial + cash capital
  // calls); non-cash equity JEs (earnings allocations, basis true-ups) are NOT
  // contributed capital.
  const contributedCapitalCents = capEvents.totalContributedCents;
  const distributionsCents = capEvents.totalDistributionsCents;
  return {
    asOf,
    totalLiabilitiesCents,
    mortgageDebtCents,
    otherDebtCents: totalLiabilitiesCents - mortgageDebtCents,
    contributedCapitalCents,
    distributionsCents,
    netIncomeToDateCents,
    // GAAP book equity still nets distributions back out: in − out + earnings.
    bookEquityCents:
      contributedCapitalCents - distributionsCents + netIncomeToDateCents,
    totalAssetsCents,
    totalInvestedCents: totalLiabilitiesCents + contributedCapitalCents,
  };
}

export interface EquityCashFlows {
  /** Owner-perspective dated flows: contributions negative, distributions
   *  positive. Does NOT include the terminal equity value (added by the caller,
   *  where it depends on the live cap-rate / valuation). */
  flows: { date: string; amountCents: number }[];
  totalContributedCents: number; // cash in (positive magnitude)
  totalDistributedCents: number; // cash out (positive magnitude)
}

/**
 * Owner capital flows for an IRR — the value partners put in and took out, by
 * date. Per entry we take the net movement on owner-capital + distribution
 * accounts (credit − debit) and keep it UNLESS the entry is an earnings
 * allocation / tax-basis true-up — which always touch Retained Earnings or the
 * S-corp Accumulated Adjustments account. This excludes those reclasses (and,
 * naturally, inter-partner reshuffles and our own distribution reclass net to
 * zero), while keeping real contributions even when funded by a receivable
 * rather than cash. The caller appends the terminal equity value and runs xirr().
 */
export async function equityCashFlowSeries(
  entityId: string,
  asOf: string
): Promise<EquityCashFlows> {
  const isEarningsAllocation = sql`EXISTS (SELECT 1
       FROM bk_journal_lines bl JOIN bk_accounts ba ON ba.id = bl.account_id
       WHERE bl.entry_id = ${bkJournalEntries.id}
         AND ba.account_subtype IN ('RetainedEarnings', 'AccumulatedAdjustment'))`;
  const rows = await db
    .select({
      date: sql<string>`${bkJournalEntries.txnDate}::text`.as("d"),
      // credit − debit on owner-capital + distribution accounts for this entry.
      equityCmd: sql<number>`SUM(${bkJournalLines.creditCents} - ${bkJournalLines.debitCents})::bigint`.as("equity_cmd"),
    })
    .from(bkJournalEntries)
    .innerJoin(bkJournalLines, eq(bkJournalLines.entryId, bkJournalEntries.id))
    .innerJoin(bkAccounts, eq(bkAccounts.id, bkJournalLines.accountId))
    .where(
      sql`${eq(bkJournalEntries.entityId, entityId)}
        AND ${bkJournalEntries.txnDate} <= ${asOf}
        AND ${bkAccounts.classification} = 'equity'
        AND COALESCE(${bkAccounts.accountSubtype}, '') NOT IN ('RetainedEarnings', 'AccumulatedAdjustment', 'OpeningBalanceEquity')
        AND NOT ${isEarningsAllocation}`
    )
    .groupBy(bkJournalEntries.id, bkJournalEntries.txnDate);

  const flows: { date: string; amountCents: number }[] = [];
  let totalContributedCents = 0;
  let totalDistributedCents = 0;
  for (const r of rows) {
    const equityCmd = Number(r.equityCmd);
    if (equityCmd === 0) continue;
    // Owner flow is the opposite sign of the equity movement: a credit to capital
    // (equity up) is value IN from the owner → negative; a debit (equity down) is
    // value OUT to the owner → positive.
    const amountCents = -equityCmd;
    flows.push({ date: r.date, amountCents });
    if (amountCents < 0) totalContributedCents += -amountCents;
    else totalDistributedCents += amountCents;
  }
  flows.sort((a, b) => (a.date < b.date ? -1 : 1));
  return { flows, totalContributedCents, totalDistributedCents };
}
