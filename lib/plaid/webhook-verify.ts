import { createHash, timingSafeEqual } from "node:crypto";
import { decodeProtectedHeader, importJWK, jwtVerify } from "jose";
import { getPlaid } from "@/lib/plaid/client";

/**
 * Official Plaid webhook verification (per plaid.com/docs/api/webhooks/
 * webhook-verification): Plaid signs EVERY outgoing webhook with an ES256 JWT
 * in the `Plaid-Verification` header — automatically, with no Dashboard setting.
 *
 * Procedure:
 *  1. Decode the JWT header (no signature check yet); require alg === "ES256"
 *     (reject algorithm substitution) and read the `kid`.
 *  2. Fetch the matching public key via /webhook_verification_key/get (cached,
 *     bounded, rotation-aware).
 *  3. Verify the ES256 signature with that JWK.
 *  4. Reject if the token is > 5 minutes old (iat).
 *  5. Compute SHA-256 of the RAW request body and constant-time-compare it to
 *     the `request_body_sha256` claim (Plaid: whitespace-sensitive → must hash
 *     the exact received bytes, never a re-serialized object).
 *
 * Returns a structured reason category on failure and NEVER logs or returns the
 * JWT, raw body, secret, access tokens, transactions, or claim values.
 */

export type WebhookVerifyReason =
  | "missing_signature"
  | "malformed_signature"
  | "wrong_algorithm"
  | "unknown_key"
  | "invalid_signature"
  | "expired_token"
  | "body_hash_mismatch";

export type WebhookVerifyResult =
  | { ok: true }
  | { ok: false; reason: WebhookVerifyReason };

/** A JWK as returned by /webhook_verification_key/get. */
export interface PlaidJwk {
  kty?: string;
  kid?: string;
  alg?: string;
  crv?: string;
  x?: string;
  y?: string;
  use?: string;
  created_at?: number;
  expired_at?: number | null;
}

export type KeyFetcher = (kid: string) => Promise<PlaidJwk | null>;

/** Default: fetch from Plaid via the installed SDK. Errors → null (→ unknown_key). */
async function plaidKeyFetcher(kid: string): Promise<PlaidJwk | null> {
  try {
    const res = await getPlaid().webhookVerificationKeyGet({ key_id: kid });
    return (res.data.key as PlaidJwk) ?? null;
  } catch {
    return null;
  }
}

// ── Bounded, TTL, rotation-aware key cache ───────────────────────────────────
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // refetch a key at least daily
const MAX_KEYS = 32; // bound cache size (Plaid rotates rarely)
const keyCache = new Map<string, { jwk: PlaidJwk; fetchedAt: number }>();

function cacheGet(kid: string, now: number): PlaidJwk | undefined {
  const e = keyCache.get(kid);
  if (!e) return undefined;
  // Expire on TTL or on Plaid's own expiry (expired_at is epoch SECONDS).
  const expired =
    now - e.fetchedAt > CACHE_TTL_MS ||
    (e.jwk.expired_at != null && e.jwk.expired_at * 1000 <= now);
  if (expired) {
    keyCache.delete(kid);
    return undefined;
  }
  return e.jwk;
}

function cacheSet(kid: string, jwk: PlaidJwk, now: number): void {
  if (keyCache.size >= MAX_KEYS) {
    const oldest = keyCache.keys().next().value;
    if (oldest !== undefined) keyCache.delete(oldest);
  }
  keyCache.set(kid, { jwk, fetchedAt: now });
}

/** Test-only: clear the module key cache. */
export function _resetKeyCache(): void {
  keyCache.clear();
}

function bodyHashHex(rawBody: string): string {
  return createHash("sha256").update(rawBody, "utf8").digest("hex");
}

function hashesEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export async function verifyPlaidWebhook(
  jwtHeader: string | null | undefined,
  rawBody: string,
  opts: { keyFetcher?: KeyFetcher; now?: number } = {}
): Promise<WebhookVerifyResult> {
  const now = opts.now ?? Date.now();
  const fetchKey = opts.keyFetcher ?? plaidKeyFetcher;

  if (!jwtHeader || !jwtHeader.trim()) {
    return { ok: false, reason: "missing_signature" };
  }

  // 1. Header: require ES256, read kid.
  let kid: string | undefined;
  try {
    const header = decodeProtectedHeader(jwtHeader);
    if (header.alg !== "ES256") return { ok: false, reason: "wrong_algorithm" };
    kid = header.kid;
  } catch {
    return { ok: false, reason: "malformed_signature" };
  }
  if (!kid) return { ok: false, reason: "malformed_signature" };

  // 2. Key (cache → fetch on miss/rotation).
  let jwk = cacheGet(kid, now);
  if (!jwk) {
    const fetched = await fetchKey(kid);
    if (!fetched) return { ok: false, reason: "unknown_key" };
    // An already-expired key is not usable.
    if (fetched.expired_at != null && fetched.expired_at * 1000 <= now) {
      return { ok: false, reason: "unknown_key" };
    }
    cacheSet(kid, fetched, now);
    jwk = fetched;
  }

  // 3 + 4. Verify signature (ES256 only) and freshness (iat ≤ 5 min old).
  let payload: Record<string, unknown>;
  try {
    const key = await importJWK(jwk as Parameters<typeof importJWK>[0], "ES256");
    const res = await jwtVerify(jwtHeader, key, {
      algorithms: ["ES256"],
      maxTokenAge: "5m",
      clockTolerance: 5, // small skew allowance
    });
    payload = res.payload as Record<string, unknown>;
  } catch (e) {
    const code = (e as { code?: string })?.code ?? "";
    if (code === "ERR_JWT_EXPIRED" || code === "ERR_JWT_CLAIM_VALIDATION_FAILED") {
      return { ok: false, reason: "expired_token" };
    }
    return { ok: false, reason: "invalid_signature" };
  }

  // 5. Body integrity — exact raw bytes, constant-time compare.
  const claim = payload["request_body_sha256"];
  if (typeof claim !== "string" || !hashesEqual(claim, bodyHashHex(rawBody))) {
    return { ok: false, reason: "body_hash_mismatch" };
  }

  return { ok: true };
}
