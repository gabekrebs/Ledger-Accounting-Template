/**
 * Account-type classification — QBO's AccountType vocabulary is the chart's
 * lingua franca (imported books carry it; new accounts pick from it), so
 * classification + normal balance derive from it in one place.
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
