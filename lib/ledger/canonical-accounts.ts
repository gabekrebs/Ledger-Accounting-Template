import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { bkAccounts } from "@/lib/db/schema";

/**
 * Canonical chart-of-accounts taxonomy — the portfolio-wide "best practices"
 * standard every entity's idiosyncratic QBO/Wave chart maps onto, WITHOUT
 * touching the underlying books (no QBO edits, no reclass journal entries). It is
 * the multi-tenant resolution layer the deterministic Plaid recognizers and the
 * statements rely on, so a feature written once works on a brand-new customer
 * entity whose accounts are named differently ("Management Expense" vs
 * "Management", "Repair & Maintenance" vs "Repairs & Maintenance", etc.).
 *
 * Two jobs:
 *   1. RESOLVE — given an entity's accounts, find the single best existing
 *      account for each canonical key by name heuristics (most-specific first,
 *      with exclusions so "Cleaning Supplies" never resolves as "Cleaning").
 *   2. ENSURE — for the small set of CORE keys an automated posting needs a home
 *      for (rental-income channels, property tax, the headline operating costs),
 *      create an app-native account when the entity genuinely has none. App-
 *      native accounts use a stable `canon:<key>` id so the nightly QBO sync
 *      (which upserts by QBO id) never clobbers them.
 *
 * The DISPLAY-side P&L grouping already lives in reports.ts (`expenseCategory`,
 * `EXPENSE_CATEGORY_ORDER`) and is also name/subtype driven — this module is its
 * resolution counterpart (canonical key → concrete account), not a replacement.
 */

export type CanonicalKey =
  // rental income, by booking channel
  | "income.airbnb"
  | "income.bookingcom"
  | "income.vrbo"
  | "income.marriott"
  | "income.capitalone"
  | "income.direct"
  | "income.other"
  // operating expenses the owner-statement gross-up + categorization need
  | "expense.management"
  | "expense.cleaning"
  | "expense.repairs"
  | "expense.hospitality"
  | "expense.supplies"
  | "expense.garbage"
  | "expense.utilities"
  | "expense.insurance"
  | "expense.property_tax"
  | "expense.other";

interface CanonicalDef {
  key: CanonicalKey;
  /** the standard display name — used verbatim when ENSURE creates the account */
  label: string;
  classification: "revenue" | "expense";
  accountType: string; // QBO AccountType (drives classification/normal balance on create)
  subtype: string | null; // QBO subtype → reports.ts display grouping
  normalBalance: "debit" | "credit";
  /** ordered name matchers, most-specific first (index = specificity rank) */
  match: RegExp[];
  /** if the name matches this, it is NOT this key (disambiguation) */
  exclude?: RegExp;
  /** create an app-native account when the entity has no match (core posting targets) */
  ensure: boolean;
  /**
   * Portability fallback. If this key has no DIRECT match for an entity, resolve
   * to this parent key's account instead (chain-followed, cycle-guarded) — so a
   * global rule targeting a specific channel/subcategory (e.g. income.airbnb)
   * still posts for an entity that keeps only the generic account (e.g. a single
   * "Rental Income"). Never overrides a direct match. Only categories with a
   * genuinely SAFE generic parent declare one; the rest deliberately stay
   * unmatched (→ human review) rather than risk mis-posting to a catch-all.
   */
  fallback?: CanonicalKey;
}

// Order matters only for readability; resolution is per-key independent.
const CANONICAL: CanonicalDef[] = [
  { key: "income.airbnb", label: "Rental Income - Airbnb", classification: "revenue", accountType: "Income", subtype: "SalesOfProductIncome", normalBalance: "credit", match: [/airbnb/i], fallback: "income.other", ensure: true },
  { key: "income.bookingcom", label: "Rental Income - Booking.com", classification: "revenue", accountType: "Income", subtype: "SalesOfProductIncome", normalBalance: "credit", match: [/booking\.?com/i, /\bbooking\b/i], fallback: "income.other", ensure: true },
  { key: "income.vrbo", label: "Rental Income - VRBO", classification: "revenue", accountType: "Income", subtype: "SalesOfProductIncome", normalBalance: "credit", match: [/vrbo/i, /homeaway/i], fallback: "income.other", ensure: true },
  { key: "income.marriott", label: "Rental Income - Marriott", classification: "revenue", accountType: "Income", subtype: "SalesOfProductIncome", normalBalance: "credit", match: [/marriott/i, /homes\s*&\s*villas/i], fallback: "income.other", ensure: true },
  { key: "income.capitalone", label: "Rental Income - Capital One", classification: "revenue", accountType: "Income", subtype: "SalesOfProductIncome", normalBalance: "credit", match: [/capital\s*one/i], fallback: "income.other", ensure: true },
  { key: "income.direct", label: "Rental Income - Direct", classification: "revenue", accountType: "Income", subtype: "SalesOfProductIncome", normalBalance: "credit", match: [/rental income\s*-\s*direct/i, /\bdirect\b/i], fallback: "income.other", ensure: true },
  // The last matcher is a deliberate weakest-case CONTAINS: entity charts carry
  // decorated variants ("A: Rental Income - Main St") that the exact form
  // missed, stranding Airbnb deposits unresolvable. Channel-specific names
  // ("Rental Income - Airbnb") still win their own keys first — this only
  // catches what nothing more specific claimed.
  { key: "income.other", label: "Rental Income - Other", classification: "revenue", accountType: "Income", subtype: "SalesOfProductIncome", normalBalance: "credit", match: [/rental income\s*-\s*other/i, /^rental income$/i, /\brental income\b/i], ensure: false },

  { key: "expense.management", label: "Management Expense", classification: "expense", accountType: "Expense", subtype: "CostOfLabor", normalBalance: "debit", match: [/\bmanagement\b/i, /\bmgmt\b/i, /property manager/i], ensure: true },
  { key: "expense.cleaning", label: "Cleaning Expense", classification: "expense", accountType: "Expense", subtype: "CostOfLabor", normalBalance: "debit", match: [/\bcleaning\b/i, /\bturnover\b/i, /\blaundry\b/i], exclude: /suppl/i, ensure: true },
  { key: "expense.repairs", label: "Repairs & Maintenance", classification: "expense", accountType: "Expense", subtype: "RepairMaintenance", normalBalance: "debit", match: [/repairs?\s*&?\s*maintenance/i, /\brepair/i, /\bmaintenance\b/i, /handyman/i], ensure: true },
  { key: "expense.hospitality", label: "Hospitality Essentials", classification: "expense", accountType: "Expense", subtype: "SuppliesMaterials", normalBalance: "debit", match: [/hospitality/i], ensure: true },
  { key: "expense.supplies", label: "Supplies", classification: "expense", accountType: "Expense", subtype: "SuppliesMaterials", normalBalance: "debit", match: [/unit supplies/i, /\bsupplies\b/i, /\bsupply\b/i], ensure: false },
  { key: "expense.garbage", label: "Garbage", classification: "expense", accountType: "Expense", subtype: "Utilities", normalBalance: "debit", match: [/\bgarbage\b/i, /\btrash\b/i, /\b(waste|refuse|recycl)/i, /disposal\s*(fee|service|&)/i], fallback: "expense.utilities", ensure: false },
  { key: "expense.utilities", label: "Utilities", classification: "expense", accountType: "Expense", subtype: "Utilities", normalBalance: "debit", match: [/^utilities$/i, /\butilit/i], ensure: false },
  { key: "expense.insurance", label: "Insurance", classification: "expense", accountType: "Expense", subtype: "Insurance", normalBalance: "debit", match: [/\binsurance\b/i], ensure: false },
  { key: "expense.property_tax", label: "Property Taxes", classification: "expense", accountType: "Expense", subtype: "TaxesPaid", normalBalance: "debit", match: [/property\s*tax/i, /real estate tax/i], ensure: true },
  { key: "expense.other", label: "Other Business Expenses", classification: "expense", accountType: "Expense", subtype: "OtherMiscellaneousServiceCost", normalBalance: "debit", match: [/other business expenses?/i, /other (general|misc)/i], ensure: true },
];

const DEF_BY_KEY = new Map(CANONICAL.map((d) => [d.key, d]));

export interface ResolvedAccount {
  id: string;
  qboAccountId: string;
  name: string;
}
type AcctRow = { id: string; qboAccountId: string; name: string; active: boolean | null; classification: string };

/** Score an account for a def: lower = better match; Infinity = no match. */
function scoreFor(def: CanonicalDef, a: AcctRow): number {
  // A canonical key only ever resolves to an account on the SAME side of the
  // books — an expense key never grabs "Loans to Others - … Hospitality" (asset)
  // or "Direct Deposit Payable" (liability) just because the name matches.
  if (a.classification !== def.classification) return Infinity;
  if (def.exclude && def.exclude.test(a.name)) return Infinity;
  if (/\(deleted/i.test(a.name)) return Infinity; // never resolve to a QBO tombstone
  for (let i = 0; i < def.match.length; i++) if (def.match[i].test(a.name)) {
    // specificity rank + tie-breakers: prefer active, exact label, then shorter name
    const inactive = a.active === false ? 0.5 : 0;
    const exact = a.name.trim().toLowerCase() === def.label.toLowerCase() ? -0.25 : 0;
    return i + inactive + exact + Math.min(0.2, a.name.length / 1000);
  }
  return Infinity;
}

/**
 * Resolve each canonical key to the single best existing account for an entity.
 * Keys with no match are absent from the map (callers ensure/fallback as needed).
 */
export async function resolveCanonicalAccounts(
  entityId: string
): Promise<Map<CanonicalKey, ResolvedAccount>> {
  const rows = (await db
    .select({ id: bkAccounts.id, qboAccountId: bkAccounts.qboAccountId, name: bkAccounts.name, active: bkAccounts.active, classification: bkAccounts.classification })
    .from(bkAccounts)
    .where(eq(bkAccounts.entityId, entityId))) as AcctRow[];

  const out = new Map<CanonicalKey, ResolvedAccount>();
  for (const def of CANONICAL) {
    let best: AcctRow | null = null;
    let bestScore = Infinity;
    for (const a of rows) {
      const s = scoreFor(def, a);
      if (s < bestScore) { bestScore = s; best = a; }
    }
    if (best) out.set(def.key, { id: best.id, qboAccountId: best.qboAccountId, name: best.name });
  }

  // Portability fallback pass: a key that got NO direct match inherits the
  // account of its declared parent (chain-followed, cycle-guarded). This makes a
  // global rule targeting a specific channel (income.airbnb) resolve for an
  // entity that keeps only the generic account ("Rental Income" → income.other).
  // Runs after all direct matches, so it never overrides one.
  for (const def of CANONICAL) {
    if (out.has(def.key) || !def.fallback) continue;
    const seen = new Set<CanonicalKey>([def.key]);
    let fk: CanonicalKey | undefined = def.fallback;
    while (fk && !seen.has(fk)) {
      const hit = out.get(fk);
      if (hit) { out.set(def.key, hit); break; }
      seen.add(fk);
      fk = DEF_BY_KEY.get(fk)?.fallback;
    }
  }
  return out;
}

/**
 * Ensure the CORE canonical accounts exist for an entity, creating app-native
 * ones (`canon:<key>` id, sync-proof) for any `ensure` key with no resolved
 * match. Idempotent. Returns the keys it created. `only` restricts to a subset.
 */
export async function ensureCanonicalAccounts(
  entityId: string,
  only?: CanonicalKey[],
  opts: { live?: boolean } = {}
): Promise<{ created: CanonicalKey[]; resolved: Map<CanonicalKey, ResolvedAccount> }> {
  const resolved = await resolveCanonicalAccounts(entityId);
  const keys = (only ?? CANONICAL.filter((d) => d.ensure).map((d) => d.key)).filter(
    (k) => DEF_BY_KEY.get(k)?.ensure
  );
  const created: CanonicalKey[] = [];
  for (const key of keys) {
    if (resolved.has(key)) continue;
    const def = DEF_BY_KEY.get(key)!;
    const qboId = `canon:${key}`;
    if (opts.live) {
      const ins = await db
        .insert(bkAccounts)
        .values({
          entityId,
          qboAccountId: qboId,
          name: def.label,
          fullyQualifiedName: def.label,
          accountType: def.accountType,
          accountSubtype: def.subtype,
          normalBalance: def.normalBalance,
          classification: def.classification,
          active: true,
        })
        .onConflictDoNothing({ target: [bkAccounts.entityId, bkAccounts.qboAccountId] })
        .returning({ id: bkAccounts.id });
      if (ins[0]) resolved.set(key, { id: ins[0].id, qboAccountId: qboId, name: def.label });
    }
    created.push(key);
  }
  return { created, resolved };
}

/**
 * Booking-channel source string → canonical income key. 6-bucket model
 * (VRBO, then Marriott + Capital One, broken out of
 * Direct): Airbnb, Booking.com, VRBO/HomeAway/Expedia, Marriott (Homes &
 * Villas), and Capital One Travel get their own line; everything else (direct,
 * BE-API, website, whimstay, manual, unresolved codes) rolls into Direct. All
 * six targets are `ensure:true`, so a channel always resolves — a stray source
 * never leaves a payout un-grossable. The income.other def remains for
 * RESOLVING entities that already keep that line; it's not a routing target.
 */
export function incomeKeyForChannel(source: string | null | undefined): CanonicalKey {
  const s = (source || "").toLowerCase();
  if (s.includes("airbnb")) return "income.airbnb";
  if (s.includes("booking")) return "income.bookingcom";
  if (s.includes("vrbo") || s.includes("homeaway") || s.includes("expedia")) return "income.vrbo";
  if (s.includes("marriott") || s.includes("homes & villas") || s.includes("homesvillas")) return "income.marriott";
  if (s.includes("capital one")) return "income.capitalone";
  return "income.direct";
}

/** Owner-statement expense category string → canonical expense key. */
export function expenseKeyForCategory(category: string | null | undefined): CanonicalKey {
  const c = (category || "").toLowerCase();
  if (/manage|mgmt/.test(c)) return "expense.management";
  if (/clean/.test(c) && !/suppl/.test(c)) return "expense.cleaning";
  if (/repair|maintenance/.test(c)) return "expense.repairs";
  if (/hospitality/.test(c)) return "expense.hospitality";
  if (/suppl|purchase|material/.test(c)) return "expense.supplies";
  if (/trash|garbage|waste|disposal/.test(c)) return "expense.garbage";
  if (/insurance/.test(c)) return "expense.insurance";
  if (/property\s*tax|real estate tax/.test(c)) return "expense.property_tax";
  return "expense.other";
}

export { CANONICAL };
