/**
 * `extractFacts` — collapse a staged Plaid transaction into the `TxnFacts` bag
 * the predicate engine tests.
 *
 * Reuses the SAME `normalizeMerchant` / `extractParty` the statistical
 * fingerprint uses (both now in the neutral pure module lib/ledger/merchant.ts),
 * on purpose: a rule the user authors from a transaction ("merchant is comcast")
 * must normalize identically to how that merchant is keyed everywhere else, or
 * the rule would silently fail to match its own transaction. Those helpers are
 * db-free, so this module is now PURE / client-safe too.
 */
import { normalizeMerchant, extractParty } from "@/lib/ledger/merchant";
import type { TxnFacts } from "@/lib/rules/types";

/** The transaction fields `extractFacts` needs (a subset of bk_plaid_transactions). */
export interface FactsInput {
  name: string | null;
  merchantName: string | null;
  amountCents: number;
  isoCurrencyCode: string | null;
  plaidCategory: unknown; // jsonb: { primary?, detailed?, … }
  txnDate: string; // ISO yyyy-mm-dd
  plaidAccountId: string;
}

export interface FactsContext {
  /** plaidAccountId → bank account subtype (checking, credit card, …). */
  subtypeByPlaidAcct?: Map<string, string | null>;
  /** plaidAccountId → account mask (last four), for per-account routing. */
  last4ByPlaidAcct?: Map<string, string | null>;
}

/** Strongest normalized merchant key, mirroring the fingerprint's first candidate. */
function merchantKey(input: FactsInput): string {
  const fromMerchant = normalizeMerchant(input.merchantName);
  if (fromMerchant.length >= 3) return fromMerchant;
  // Imported bank-feed lines often carry the payee only in the NACHA descriptor.
  const fromParty = normalizeMerchant(extractParty({ memo: input.name }));
  if (fromParty.length >= 3) return fromParty;
  return normalizeMerchant(input.name);
}

export function extractFacts(input: FactsInput, ctx: FactsContext = {}): TxnFacts {
  const cat = input.plaidCategory as
    | { primary?: string | null; detailed?: string | null }
    | null;

  // Parse the ISO date without a timezone round-trip (avoid off-by-one).
  const [y, m, d] = input.txnDate.split("-").map((n) => parseInt(n, 10));
  const dayOfMonth = Number.isFinite(d) ? d : 0;
  const weekday =
    Number.isFinite(y) && Number.isFinite(m) && Number.isFinite(d)
      ? new Date(Date.UTC(y, m - 1, d)).getUTCDay()
      : 0;

  return {
    merchant: merchantKey(input),
    rawName: input.name ?? "",
    amountCents: input.amountCents,
    // Plaid convention: positive = money OUT of a depository account.
    direction: input.amountCents < 0 ? "inflow" : "outflow",
    plaidCategoryPrimary: cat?.primary ?? null,
    plaidCategoryDetailed: cat?.detailed ?? null,
    bankAccountSubtype: ctx.subtypeByPlaidAcct?.get(input.plaidAccountId) ?? null,
    accountLast4: ctx.last4ByPlaidAcct?.get(input.plaidAccountId) ?? null,
    isoCurrencyCode: input.isoCurrencyCode,
    dayOfMonth,
    weekday,
    // remaining reserved fields stay undefined until the underlying data is wired
  };
}
