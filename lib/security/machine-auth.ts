/**
 * Fail-closed shared-secret checks for the machine endpoints (the Vercel cron
 * and the Plaid webhook receiver).
 *
 * Why this exists: the old inline checks compared the raw header against a
 * template literal (`Bearer ${process.env.CRON_SECRET}`), so an UNSET secret
 * produced the literal string "Bearer undefined" — which an attacker could
 * simply send. These helpers fail CLOSED instead: a missing or blank configured
 * secret rejects every request, and the comparison is constant-time.
 *
 * Two secrets, two jobs — deliberately not shared:
 *   • CRON_SECRET          — authorizes Vercel Cron → /api/cron/* only.
 *   • PLAID_WEBHOOK_SECRET — capability token in the per-Item webhook URL
 *     Plaid POSTs to (see lib/plaid/client.ts plaidWebhookUrl). Kept separate
 *     so the cron credential never rides in a URL registered with a third
 *     party, and either secret can rotate without breaking the other.
 *
 * Pure module: no db, reads env at CALL time (so it's unit-testable by setting
 * process.env). Secrets must never be logged or sent to the client.
 */
import { timingSafeEqual } from "crypto";

/** Constant-time equality that never throws on length mismatch. */
function secretsEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * True only when a non-blank secret is configured AND the provided credential
 * matches it exactly. Blank/whitespace configuration = deny-all (fail closed).
 */
export function isValidSecret(
  provided: string | null | undefined,
  configured: string | null | undefined
): boolean {
  const expected = typeof configured === "string" ? configured.trim() : "";
  if (!expected) return false; // unset/blank config can never authorize
  if (typeof provided !== "string" || provided.length === 0) return false;
  return secretsEqual(provided, expected);
}

/** Vercel Cron authorization: the exact header `Bearer <CRON_SECRET>`. */
export function isAuthorizedCron(authorizationHeader: string | null): boolean {
  const match = /^Bearer (.+)$/.exec(authorizationHeader ?? "");
  return isValidSecret(match?.[1], process.env.CRON_SECRET);
}

/** Plaid webhook authorization: the `token` query param vs PLAID_WEBHOOK_SECRET. */
export function isAuthorizedPlaidWebhook(token: string | null): boolean {
  return isValidSecret(token, process.env.PLAID_WEBHOOK_SECRET);
}
