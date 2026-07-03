import {
  Configuration,
  PlaidApi,
  PlaidEnvironments,
  Products,
  CountryCode,
} from "plaid";

/**
 * Plaid API client for the custom ledger's bank-feed ingest (Phase 6b).
 *
 * Sandbox by default (fake banks, zero compliance). Set PLAID_ENV=production and
 * swap PLAID_SECRET for the production secret once app auth + Plaid's security
 * attestations are done. Server-only — the secret and access tokens must never
 * reach the browser.
 */
function env(): keyof typeof PlaidEnvironments {
  const e = (process.env.PLAID_ENV ?? "sandbox").trim();
  return e === "production" ? "production" : "sandbox";
}

let cached: PlaidApi | undefined;

export function getPlaid(): PlaidApi {
  if (cached) return cached;
  const clientId = process.env.PLAID_CLIENT_ID?.trim();
  const secret = process.env.PLAID_SECRET?.trim();
  if (!clientId || !secret) {
    throw new Error("PLAID_CLIENT_ID / PLAID_SECRET not set");
  }
  const config = new Configuration({
    basePath: PlaidEnvironments[env()],
    baseOptions: {
      headers: {
        "PLAID-CLIENT-ID": clientId,
        "PLAID-SECRET": secret,
      },
    },
  });
  cached = new PlaidApi(config);
  return cached;
}

export const PLAID_ENV = env();
export const PLAID_PRODUCTS = [Products.Transactions];
export const PLAID_COUNTRY_CODES = [CountryCode.Us];

/**
 * The public URL Plaid POSTs transaction-update webhooks to, so a freshly linked
 * bank backfills the moment Plaid finishes its async extraction (instead of only
 * on a manual "Sync all"). Plaid stores this per-Item at link time.
 *
 * Must be a STABLE, public HTTPS URL — the production domain, never a per-deploy
 * preview alias — so override with PLAID_WEBHOOK_URL if the domain ever changes.
 * The dedicated PLAID_WEBHOOK_SECRET in the query string is the capability that
 * gates the receiver (the endpoint only triggers an idempotent sync of an Item
 * we already own and returns no data, so a shared secret is sufficient — full
 * Plaid JWT verification is the documented follow-up). Deliberately NOT
 * CRON_SECRET: the cron credential must never ride in a URL registered with a
 * third party. Returns null when no secret is configured (e.g. local dev) — we
 * then link without a webhook. After rotating/introducing the secret, run
 * `scripts/update-plaid-webhooks.mts` to re-register existing Items' URLs.
 */
export function plaidWebhookUrl(): string | null {
  const secret = process.env.PLAID_WEBHOOK_SECRET?.trim();
  if (!secret) return null;
  const base = (
    process.env.PLAID_WEBHOOK_URL?.trim() ||
    "https://your-app.example.com/api/plaid/webhook"
  ).replace(/\/$/, "");
  return `${base}?token=${encodeURIComponent(secret)}`;
}

/**
 * The OAuth redirect URI Plaid returns the user to after an OAuth bank login
 * (Chase and most large banks). Required for those institutions; credential-flow
 * banks don't need it.
 *
 * Sourced ONLY from PLAID_REDIRECT_URI — a deliberate production setting that
 * MUST exactly match an "Allowed redirect URI" registered in the Plaid dashboard
 * (e.g. https://<domain>/ledger/connections). Intentionally NOT derived from
 * NEXT_PUBLIC_APP_URL: on localhost that would be an http URL Plaid rejects, and
 * passing an unregistered redirect_uri makes EVERY linkTokenCreate fail. Returns
 * null when unset (local dev) → we link without OAuth support, so credential-flow
 * banks still work locally and only OAuth banks need the production URL.
 */
export function plaidRedirectUri(): string | null {
  const uri = process.env.PLAID_REDIRECT_URI?.trim();
  return uri ? uri.replace(/\/$/, "") : null;
}
