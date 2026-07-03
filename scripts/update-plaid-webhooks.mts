/**
 * Re-register the webhook URL on every active Plaid Item.
 *
 * Run this ONCE after introducing or rotating PLAID_WEBHOOK_SECRET (the webhook
 * URL embeds the secret as its capability token, and Plaid stores the URL
 * per-Item at link time — existing Items keep POSTing to the old URL until
 * updated). Idempotent; safe to re-run.
 *
 *   node --env-file=.env.local ./node_modules/.bin/tsx scripts/update-plaid-webhooks.mts
 *
 * Requires PLAID_* + PLAID_WEBHOOK_SECRET in the loaded env. Prints the new URL
 * with the token REDACTED — never log the secret.
 */
import { ne } from "drizzle-orm";
import { db, schema } from "../lib/db/client";
import { getPlaid, plaidWebhookUrl } from "../lib/plaid/client";
import { decryptToken } from "../lib/plaid/crypto";

const url = plaidWebhookUrl();
if (!url) {
  console.error("PLAID_WEBHOOK_SECRET is not set — nothing to register.");
  process.exit(1);
}
console.log(`Registering webhook: ${url.replace(/token=[^&]+/, "token=<redacted>")}`);

const plaid = getPlaid();
const items = await db
  .select()
  .from(schema.bkPlaidItems)
  .where(ne(schema.bkPlaidItems.status, "replaced"));

let updated = 0;
let failed = 0;
for (const item of items) {
  try {
    await plaid.itemWebhookUpdate({
      access_token: decryptToken(item.accessToken),
      webhook: url,
    });
    updated++;
    console.log(`  updated item ${item.id} (${item.institutionName ?? "?"})`);
  } catch (e) {
    failed++;
    console.error(
      `  FAILED item ${item.id}:`,
      e instanceof Error ? e.message : e
    );
  }
}
console.log(`done: ${updated} updated, ${failed} failed, ${items.length} total`);
process.exit(failed ? 1 : 0);
