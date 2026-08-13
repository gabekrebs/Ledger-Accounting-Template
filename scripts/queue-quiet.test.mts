/**
 * /review card-payment quieting — pure-logic tests for
 * isLikelyCardPaymentSide / hiddenFromReviewQueue (lib/plaid/transfer-match).
 * Fixtures are real production descriptors (amounts changed). The NEGATIVE
 * cases are the contract: Zelle rent, inter-property management transfers and
 * owner draws must NEVER be quieted — only card-payment halves.
 *
 *   SUPABASE_DB_URL=postgres://u:p@127.0.0.1:5432/none npx tsx scripts/queue-quiet.test.mts
 *
 * (Dummy URL satisfies the db client's load-time check; no connection opens.)
 */
import {
  isLikelyCardPaymentSide,
  hiddenFromReviewQueue,
  QUEUE_HIDE_DAYS,
} from "../lib/plaid/transfer-match";

let pass = 0;
const fails: string[] = [];
function ok(cond: boolean, msg: string) {
  if (cond) pass++;
  else fails.push(msg);
}

const txn = (
  amountCents: number,
  name: string,
  accountType: string | null,
  detailed?: string,
  merchantName: string | null = null
) => ({
  amountCents,
  name,
  merchantName,
  plaidCategory: detailed ? { detailed } : null,
  accountType,
});

// ── card-feed side: the payment ARRIVING on the card (inflow) ────────────────
const cardInflows: [string, string?][] = [
  ["Payment Thank You - Web", "LOAN_DISBURSEMENTS_OTHER_DISBURSEMENT"], // Chase mislabel
  ["Payment Received", "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT"],
  ["AUTOMATIC PAYMENT - THANK", "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT"],
  ["ONLINE PAYMENT - THANK YOU", "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT"],
  ["PAYMENT RECEIVED -- THANK"],
  ["ELECTRONIC PAYMENT RECEIVED-THANK"],
];
for (const [name, det] of cardInflows)
  ok(
    isLikelyCardPaymentSide(txn(-27389, name, "credit", det)),
    `card inflow should quiet: ${name}`
  );

// Card inflows that are NOT payments (refunds / statement credits) stay visible.
ok(
  !isLikelyCardPaymentSide(
    txn(-3800, "Target", "credit", "GENERAL_MERCHANDISE_SUPERSTORES")
  ),
  "card refund (Target) must NOT quiet"
);
ok(
  !isLikelyCardPaymentSide(txn(-800, "AMEX RIDESHARE CREDIT", "credit")),
  "statement credit must NOT quiet"
);
// A PURCHASE on the card (outflow) never qualifies, whatever it says.
ok(
  !isLikelyCardPaymentSide(txn(3800, "AUTOPAY PAYMENT SERVICES LLC", "credit")),
  "card outflow (purchase) must NOT quiet"
);

// ── checking side: the payment LEAVING the bank account (outflow) ────────────
const checkingOutflows: [string, string?][] = [
  [
    "ORIG CO NAME:BARCLAYCARD US ORIG ID:2510407970 DESC DATE: CO ENTRY DESCR:CREDITCARDSEC:WEB TRACE#:026002573942530 IND NAME:ALICE M EXAMPLE",
    "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT",
  ],
  [
    "ORIG CO NAME:AMERICAN EXPRESS ORIG ID:2005032111 CO ENTRY DESCR:ACH PMT SEC:CCD IND NAME:ALICE M EXAMPLE ER AM",
  ],
  [
    "ORIG CO NAME:CHASE CREDIT CRD ORIG ID:4760039224 CO ENTRY DESCR:AUTOPAYBUSSEC:PPD IND NAME:JORDAN GWEN S",
  ],
  ["Payment to Chase card ending in 6440 07/08"],
  ["Online Payment 29482107783 To BARCLAYCARD 06/04"],
];
for (const [name, det] of checkingOutflows)
  ok(
    isLikelyCardPaymentSide(txn(27389, name, "depository", det)),
    `checking outflow should quiet: ${name.slice(0, 50)}…`
  );

// ── the flows the owner said must NEVER be hidden ────────────────────────────
const protectedFlows: [number, string][] = [
  // Rent / management income arriving (inflow on checking).
  [-250000, "Zelle payment from JOHN DOE 12345678"],
  [-180000, "ORIG CO NAME:AIRBNB PAYMENTS CO ENTRY DESCR:PAYMENTS"],
  [-95000, "Online Transfer from CHK ...0209 transaction#: 12345"],
  // Management expense / inter-property transfer leaving (outflow on checking).
  [120000, "Online Transfer to CHK ...2128 transaction#: 67890"],
  [80000, "Zelle payment to Alice Example 98765432"],
  // Owner withdrawal.
  [500000, "WITHDRAWAL TRANSFER TO SAV ...1234"],
  // Mortgage/loan payment (owned by the loan recognizer, not card quieting).
  [310000, "ORIG CO NAME:SHELLPOINT MTG CO ENTRY DESCR:MTG PYMT SEC:PPD"],
];
for (const [amt, name] of protectedFlows)
  ok(
    !isLikelyCardPaymentSide(txn(amt, name, "depository")),
    `protected flow must NOT quiet: ${name.slice(0, 50)}`
  );

// ── the QUEUE_HIDE_DAYS window (first-seen clock) ────────────────────────────
const now = Date.UTC(2026, 6, 25, 12);
const day = 86400000;
const fresh = {
  ...txn(-27389, "Payment Thank You - Web", "credit"),
  createdAt: new Date(now - 1 * day),
  txnDate: "2026-07-23",
};
ok(hiddenFromReviewQueue(fresh, now), "1-day-old card payment is hidden");
ok(
  !hiddenFromReviewQueue(
    { ...fresh, createdAt: new Date(now - (QUEUE_HIDE_DAYS + 0.5) * day) },
    now
  ),
  "past the window it surfaces (unmatched half must not hide forever)"
);
ok(
  !hiddenFromReviewQueue(
    {
      ...txn(-250000, "Zelle payment from JOHN DOE", "depository"),
      createdAt: new Date(now),
      txnDate: "2026-07-25",
    },
    now
  ),
  "freshness never hides a non-card-payment row"
);
// Missing created_at falls back to the bank date — old row shows immediately.
ok(
  !hiddenFromReviewQueue({ ...fresh, createdAt: null, txnDate: "2026-07-01" }, now),
  "null created_at + old txn date → not hidden"
);

// ── report ───────────────────────────────────────────────────────────────────
if (fails.length) {
  console.error(`\n❌ ${fails.length} failed (${pass} passed):`);
  for (const f of fails) console.error("  • " + f);
  process.exit(1);
}
console.log(`✅ all ${pass} assertions passed`);
