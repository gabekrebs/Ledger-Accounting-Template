/**
 * Net-asset-value (NAV) for holding / operating entities that don't own a single
 * income property — the `valuation_method = 'net_asset'` case.
 *
 * A rental property values on a cap rate or comps; a holding company is worth the
 * sum of what it HOLDS, net of its debt: cash, the loans it has made to others,
 * its equity investments in other entities, and any physical/real-estate assets
 * (carried at a stated value, since their book is depreciated or zero) — minus
 * the real long-term debt against the company.
 *
 * Everything is pulled from the entity's OWN books by account subtype (no
 * hardcoded ids), so any entity flipped to 'net_asset' values itself with zero
 * code edits. The only manual input is a stated value for physical assets, kept
 * as valuation components on the entity.
 */
import { accountBalances } from "./reports";
import { getValuationComponents, componentChosenCents } from "./valuation";

export interface NavLine {
  label: string;
  cents: number;
  note?: string;
}

export interface NavGroup {
  title: string;
  lines: NavLine[];
  subtotalCents: number;
}

export interface NetAssetValue {
  asOf: string;
  groups: NavGroup[];
  totalAssetsCents: number;
  debt: NavLine[];
  totalDebtCents: number;
  navCents: number;
  /** Stale balances on CLOSED bank accounts, surfaced (not counted) for honesty. */
  excludedCashCents: number;
}

// Money this entity has lent out — a receivable, book balance ≈ value.
const RECEIVABLE_SUBTYPES = new Set(["LoansToOthers", "LoansToStockholders"]);
// Equity investments in other entities (book).
const INVESTMENT_SUBTYPES = new Set(["OtherLongTermAssets", "OtherFixedAssets"]);

export async function netAssetValue(
  entityId: string,
  asOf: string
): Promise<NetAssetValue> {
  const [bals, components] = await Promise.all([
    accountBalances(entityId, { end: asOf }),
    getValuationComponents(entityId),
  ]);

  // Cash — only ACTIVE bank accounts. Closed/deleted accounts can carry stale
  // closing-transfer artifact balances that would overstate value, so they're
  // excluded here and surfaced separately as `excludedCashCents`.
  const cashLines = bals
    .filter((b) => b.accountType === "Bank" && b.active && b.netCents !== 0)
    .map((b) => ({ label: b.name, cents: b.netCents }));

  const loanLines = bals
    .filter(
      (b) => RECEIVABLE_SUBTYPES.has(b.accountSubtype ?? "") && b.netCents !== 0
    )
    .map((b) => ({ label: b.name, cents: b.netCents }));

  const investmentLines = bals
    .filter(
      (b) => INVESTMENT_SUBTYPES.has(b.accountSubtype ?? "") && b.netCents !== 0
    )
    .map((b) => ({ label: b.name, cents: b.netCents }));

  // Physical / real-estate assets carried at a stated value (book is depreciated
  // or zero), entered as valuation components on the entity.
  const physicalLines = components
    .map((c) => ({
      label: c.label,
      cents: componentChosenCents(c),
      note: "stated value",
    }))
    .filter((l) => l.cents !== 0);

  const groups: NavGroup[] = [
    { title: "Cash", lines: cashLines },
    { title: "Loans receivable", lines: loanLines },
    { title: "Equity investments", lines: investmentLines },
    { title: "Property & equipment", lines: physicalLines },
  ]
    .map((g) => ({
      ...g,
      subtotalCents: g.lines.reduce((s, l) => s + l.cents, 0),
    }))
    .filter((g) => g.lines.length > 0);

  const totalAssetsCents = groups.reduce((s, g) => s + g.subtotalCents, 0);

  // Real debt = long-term liabilities with a live balance (the SBA EIDL etc.);
  // zero-balance / closed notes are hidden. Operating working capital (A/P,
  // credit cards, payroll) nets out and is left out of the holdings view.
  const debt = bals
    .filter((b) => b.accountType === "Long Term Liability" && b.netCents !== 0)
    .map((b) => ({ label: b.name, cents: -b.netCents }));
  const totalDebtCents = debt.reduce((s, l) => s + l.cents, 0);

  const excludedCashCents = bals
    .filter((b) => b.accountType === "Bank" && !b.active && b.netCents !== 0)
    .reduce((s, b) => s + b.netCents, 0);

  return {
    asOf,
    groups,
    totalAssetsCents,
    debt,
    totalDebtCents,
    navCents: totalAssetsCents - totalDebtCents,
    excludedCashCents,
  };
}
