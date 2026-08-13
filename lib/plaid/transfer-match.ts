import { and, eq } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";

/**
 * Two deterministic recognizers for money that MOVES BETWEEN ACCOUNTS rather than
 * being earned or spent — the bank-feed equivalents of QuickBooks' "transfer" and
 * "credit card payment", which are balance-sheet entries, not P&L categories.
 *
 *  #2 planInternalTransfer — QBO-parity matching. When two of an entity's OWN
 *     linked Plaid accounts both feed the same move (e.g. checking shows the
 *     payment going out, the card shows it coming in), QBO matches the two sides
 *     into ONE transfer so it's booked once. We do the same: pair an outflow with
 *     the unique opposite-sign, same-amount inflow in a different linked account
 *     within a tight window, post one entry (Dr destination / Cr source) from the
 *     outflow side, and mark the inflow counterpart resolved so it never gets
 *     categorized again. The amortization/owner-payout recognizers already own
 *     loans and trust deposits; this owns account-to-account moves.
 *
 *  #3 planCreditCardPayment — the unlinked-card fallback. Until a card is linked
 *     in Plaid there's only ONE side in the feed (the payment leaving checking),
 *     so there's nothing to match: we book it straight to the card liability
 *     (Dr card ↓ / Cr checking). Only fires when the entity has NO linked card
 *     (else #2 will own it once the card side syncs — never both) and the target
 *     card is unambiguous; a multi-card entity stays a human pick.
 *
 * Both reuse postPlaidTransaction (bank side + chosen account) — picking a
 * balance-sheet account as the "category" is exactly how a transfer is booked.
 */

// Same move can land a few days apart across two institutions.
const WINDOW_DAYS = 5;

export interface TransferTxn {
  id: string;
  plaidAccountId: string;
  amountCents: number; // Plaid: positive = money OUT of / charged to the account
  txnDate: string | Date;
  name: string | null;
  merchantName: string | null;
}

const ymd = (d: string | Date): string =>
  d instanceof Date
    ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
    : String(d).slice(0, 10);

const daysApart = (a: string, b: string): number =>
  Math.abs((Date.parse(a + "T00:00:00Z") - Date.parse(b + "T00:00:00Z")) / 86400000);

export interface InternalTransferPlan {
  /** the inflow counterpart line to resolve (mark ignored, linked to the JE) */
  counterpartTxnId: string;
  /** destination ledger account (the counterpart's mapped account) — the "category" */
  categoryAccountId: string;
}

/**
 * Plan an internal transfer for an OUTFLOW txn, or null. Acts only on the outflow
 * side (the source owns the post); the matching inflow is found among the same
 * entity's other linked accounts. Ambiguous (≠1 candidate) → null (defer).
 * `pending` is the entity's current pending_review set; `mappedByPlaidAcct` maps a
 * Plaid account to its ledger (bank) account.
 */
export function planInternalTransfer(
  txn: TransferTxn,
  pending: TransferTxn[],
  mappedByPlaidAcct: Map<string, string | null>,
  excludeIds?: Set<string>
): InternalTransferPlan | null {
  if (txn.amountCents <= 0) return null; // act on the money-OUT side only
  if (!mappedByPlaidAcct.get(txn.plaidAccountId)) return null; // source must be mapped
  const day = ymd(txn.txnDate);

  const candidates = pending.filter(
    (c) =>
      c.id !== txn.id &&
      !excludeIds?.has(c.id) &&
      c.plaidAccountId !== txn.plaidAccountId && // a different linked account
      c.amountCents === -txn.amountCents && // exact opposite (the inflow side)
      !!mappedByPlaidAcct.get(c.plaidAccountId) && // destination must be mapped
      daysApart(ymd(c.txnDate), day) <= WINDOW_DAYS
  );
  if (candidates.length !== 1) return null; // none or ambiguous → human call

  return {
    counterpartTxnId: candidates[0].id,
    categoryAccountId: mappedByPlaidAcct.get(candidates[0].plaidAccountId)!,
  };
}

/**
 * True when this INFLOW's exact opposite sits pending in another of the
 * entity's linked accounts — i.e. it is the counterpart half of a transfer
 * that `planInternalTransfer` will book from the outflow side (this pass or a
 * later one, resolving this row via linkTransferCounterpart). The inflow must
 * stay untouched until then: letting a rule categorize it first books the move
 * TWICE — once from each side (the 2026-08-06 KP 0209→2128 double-post, where
 * the inflow was processed ahead of its outflow and a catch-all income rule
 * claimed it). `some` rather than exactly-one on purpose: an ambiguous match
 * defers the outflow to a human, and the inflow must wait for that call too.
 */
export function awaitingTransferOutflow(
  txn: TransferTxn,
  pending: TransferTxn[],
  mappedByPlaidAcct: Map<string, string | null>,
  excludeIds?: Set<string>
): boolean {
  if (txn.amountCents >= 0) return false;
  if (!mappedByPlaidAcct.get(txn.plaidAccountId)) return false;
  const day = ymd(txn.txnDate);
  return pending.some(
    (c) =>
      c.id !== txn.id &&
      !excludeIds?.has(c.id) &&
      c.plaidAccountId !== txn.plaidAccountId &&
      c.amountCents === -txn.amountCents &&
      !!mappedByPlaidAcct.get(c.plaidAccountId) &&
      daysApart(ymd(c.txnDate), day) <= WINDOW_DAYS
  );
}

// Looks like a credit-card PAYMENT (a card token AND a payment token), not a
// purchase. Covers Chase/Amex/Capital One/Discover/Citi/BoA/WF/etc. autopays.
const CARD_TOKEN =
  /credit crd|credit card|card ?member|mastercard|amex|american express|discover|capital one|chase credit|citi ?card|barclay|synchrony|comenity|usaa.*credit|wf credit|bank of america.*credit|boa credit|\bcardpay/i;
const PAY_TOKEN =
  /payment|\bpmt\b|e-?pay|auto ?pay|e-?payment|online pmt|web pmt|bill ?pay|epayment/i;

export interface CardContext {
  /** the entity already links a card in Plaid → defer to #2, never book #3 */
  hasLinkedCard: boolean;
  /** real card-liability accounts (intercompany/AP-style ones excluded) */
  realCardAccountIds: string[];
}

/** Load the card-payment context for an entity (one extra read). */
export async function loadCardContext(entityId: string): Promise<CardContext> {
  const plaidAccts = await db
    .select({ type: schema.bkPlaidAccounts.type })
    .from(schema.bkPlaidAccounts)
    .where(eq(schema.bkPlaidAccounts.entityId, entityId));
  const hasLinkedCard = plaidAccts.some((a) => (a.type ?? "").toLowerCase() === "credit");

  const cards = await db
    .select({ id: schema.bkAccounts.id, name: schema.bkAccounts.name })
    .from(schema.bkAccounts)
    .where(
      and(
        eq(schema.bkAccounts.entityId, entityId),
        eq(schema.bkAccounts.active, true),
        eq(schema.bkAccounts.accountType, "Credit Card")
      )
    );
  // A "Credit Card"-typed account that's really an A/P or intercompany clearing
  // (e.g. "Acme - Invoices") isn't a payable card — exclude it.
  const realCardAccountIds = cards
    .filter((c) => !/invoice|payable|loan|note|clearing/i.test(c.name ?? ""))
    .map((c) => c.id);

  return { hasLinkedCard, realCardAccountIds };
}

export interface CreditCardPaymentPlan {
  categoryAccountId: string; // the card liability to pay down
}

/**
 * Review-Queue quieting (/review only). Both halves of a card payment
 * auto-match via #2 as soon as the SECOND institution's feed syncs — usually
 * 0–2 days after the first half lands. Until then the early half sits in the
 * cross-entity queue as noise the owner would never act on. So /review hides a
 * LIKELY card-payment half for QUEUE_HIDE_DAYS after we first stored it
 * (created_at, not txn_date — the wait is for the other FEED, and a backfilled
 * row's counterpart syncs relative to when we saw it). The entity Review tab
 * never hides anything, and matching/posting is untouched — an unmatched half
 * simply surfaces in the queue once the window lapses.
 *
 * This is RECOGNITION ONLY — nothing books off it, so the net is deliberately
 * wider than the booking recognizer above (a false positive costs a 5-day
 * queue delay, not a wrong entry). Safety against the flows that must NEVER
 * be hidden (Zelle rent, inter-property management transfers, owner draws) is
 * structural, not just lexical: an inflow only qualifies on a credit-card
 * feed (income lands in checking), and a checking outflow needs BOTH card
 * language and payment language — plain "Online Transfer"/Zelle descriptors
 * have neither.
 */
// 5 on purpose: the same span as WINDOW_DAYS above, so a half stays quiet for
// exactly as long as the matcher could still pair it.
export const QUEUE_HIDE_DAYS = 5;

// Card-feed inflow descriptors seen in production: "Payment Thank You - Web",
// "Payment Received", "AUTOMATIC PAYMENT - THANK", "ONLINE PAYMENT - THANK
// YOU", "ELECTRONIC PAYMENT RECEIVED-THANK", "PAYMENT RECEIVED -- THANK".
// Refunds/statement credits (the other card inflows) read as merchant names
// ("Target", "AMEX RIDESHARE CREDIT") and don't match.
const CARD_INFLOW_PAY =
  /payment[\s-]*(received|thank)|(automatic|online|electronic|mobile|web)\s+payment|auto\s*-?pay|payment\s+thank\s+you|received\s*-+\s*thank/i;

// Checking-side extras beyond CARD_TOKEN: bank-ACH descriptors run words
// together ("CREDITCARDSEC:WEB") and bill-pay memos name the card without
// "credit" ("Payment to Chase card ending in 6440").
const QUEUE_CARD_TOKEN = /creditcard|\bcard ending\b|to\s+\w+\s+card\b/i;

// Plaid's own verdict — strong when present, but NOT sufficient alone for
// hiding (it also stamps some card-feed payments LOAN_DISBURSEMENTS) nor
// required (descriptors carry the cases it mislabels).
const PFC_CARD_PAYMENT = "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT";

/**
 * Does this pending row read as ONE HALF of a credit-card payment? `accountType`
 * is the source feed's bk_plaid_accounts.type ("credit" = a card feed).
 */
export function isLikelyCardPaymentSide(txn: {
  amountCents: number;
  name: string | null;
  merchantName: string | null;
  plaidCategory: unknown;
  accountType: string | null;
}): boolean {
  const label = `${txn.name ?? ""} ${txn.merchantName ?? ""}`;
  const detailed =
    (txn.plaidCategory as { detailed?: string } | null)?.detailed ?? "";
  const onCard = (txn.accountType ?? "").toLowerCase() === "credit";
  // The payment ARRIVING on the card (inflow on a credit feed).
  if (onCard && txn.amountCents < 0)
    return detailed === PFC_CARD_PAYMENT || CARD_INFLOW_PAY.test(label);
  // The payment LEAVING checking (outflow on a non-card feed).
  if (!onCard && txn.amountCents > 0)
    return (
      detailed === PFC_CARD_PAYMENT ||
      ((CARD_TOKEN.test(label) || QUEUE_CARD_TOKEN.test(label)) &&
        PAY_TOKEN.test(label))
    );
  return false;
}

/** Hide this row from the cross-entity /review queue? True while a likely
 * card-payment half is still inside its match window. */
export function hiddenFromReviewQueue(
  txn: {
    amountCents: number;
    name: string | null;
    merchantName: string | null;
    plaidCategory: unknown;
    accountType: string | null;
    createdAt: Date | null;
    txnDate: string | Date;
  },
  now: number = Date.now()
): boolean {
  if (!isLikelyCardPaymentSide(txn)) return false;
  // First-seen clock; a row missing created_at (shouldn't happen) falls back
  // to its bank date so it can never be hidden indefinitely.
  const firstSeen = txn.createdAt
    ? txn.createdAt.getTime()
    : Date.parse(ymd(txn.txnDate) + "T00:00:00Z");
  return now - firstSeen < QUEUE_HIDE_DAYS * 86400000;
}

/**
 * Plan a credit-card payment for an OUTFLOW txn whose descriptor reads as a card
 * payment, or null. Only when the entity has NO linked card (so there's no second
 * feed side #2 should own) and exactly one real card account exists.
 */
export function planCreditCardPayment(
  txn: TransferTxn,
  ctx: CardContext
): CreditCardPaymentPlan | null {
  if (txn.amountCents <= 0) return null; // a payment leaves the account
  if (ctx.hasLinkedCard) return null; // the card side will sync → let #2 match it
  if (ctx.realCardAccountIds.length !== 1) return null; // 0 or ambiguous → human pick
  const label = `${txn.name ?? ""} ${txn.merchantName ?? ""}`;
  if (!CARD_TOKEN.test(label) || !PAY_TOKEN.test(label)) return null;
  return { categoryAccountId: ctx.realCardAccountIds[0] };
}
