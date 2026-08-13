/**
 * Deterministic unit tests for official Plaid webhook JWT verification.
 * No production credentials, data, or network — the verification-key endpoint is
 * MOCKED and ES256 JWTs are minted locally with jose:
 *
 *   npx tsx scripts/plaid-webhook-verify.test.mts
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import {
  verifyPlaidWebhook,
  _resetKeyCache,
  type PlaidJwk,
  type KeyFetcher,
} from "../lib/plaid/webhook-verify";

let pass = 0;
const fails: string[] = [];
const ok = (c: boolean, m: string) => (c ? pass++ : fails.push(m));

const bodyHash = (b: string) => createHash("sha256").update(b, "utf8").digest("hex");

async function makeKey(kid: string) {
  const { publicKey, privateKey } = await generateKeyPair("ES256", { extractable: true });
  const jwk = (await exportJWK(publicKey)) as PlaidJwk;
  jwk.kid = kid;
  jwk.alg = "ES256";
  return { privateKey, jwk };
}
async function sign(
  privateKey: CryptoKey,
  kid: string | undefined,
  body: string,
  opts: { iat?: number; sha?: string } = {}
) {
  const s = new SignJWT({ request_body_sha256: opts.sha ?? bodyHash(body) }).setProtectedHeader({
    alg: "ES256",
    ...(kid ? { kid } : {}),
  });
  s.setIssuedAt(opts.iat); // undefined → now
  return s.sign(privateKey);
}
const fetcherFor = (jwk: PlaidJwk | null): KeyFetcher => async () => jwk;

const BODY = JSON.stringify({ webhook_type: "TRANSACTIONS", webhook_code: "SYNC_UPDATES_AVAILABLE" });

// ── Valid signed webhook passes ──────────────────────────────────────────────
{
  _resetKeyCache();
  const { privateKey, jwk } = await makeKey("kid1");
  const jwt = await sign(privateKey, "kid1", BODY);
  const r = await verifyPlaidWebhook(jwt, BODY, { keyFetcher: fetcherFor(jwk) });
  ok(r.ok === true, "valid signed webhook passes");
}

// ── Missing signature fails ──────────────────────────────────────────────────
ok((await verifyPlaidWebhook(null, BODY)).ok === false, "null signature fails");
ok(
  (await verifyPlaidWebhook(null, BODY) as { reason?: string }).reason === "missing_signature",
  "null signature → missing_signature"
);
ok(
  (await verifyPlaidWebhook("   ", BODY) as { reason?: string }).reason === "missing_signature",
  "blank signature → missing_signature"
);

// ── Wrong algorithm fails (algorithm substitution rejected) ──────────────────
{
  _resetKeyCache();
  const { jwk } = await makeKey("kid1");
  // Craft an HS256 token — must be rejected without ever fetching a key.
  const hs = await new SignJWT({ request_body_sha256: bodyHash(BODY) })
    .setProtectedHeader({ alg: "HS256", kid: "kid1" })
    .setIssuedAt()
    .sign(new TextEncoder().encode("this-is-a-32-byte-minimum-secret-value"));
  const r = await verifyPlaidWebhook(hs, BODY, { keyFetcher: fetcherFor(jwk) });
  ok(r.ok === false && (r as { reason: string }).reason === "wrong_algorithm", "HS256 → wrong_algorithm");
}

// ── Unknown key ID fails safely ──────────────────────────────────────────────
{
  _resetKeyCache();
  const { privateKey } = await makeKey("kidX");
  const jwt = await sign(privateKey, "kidX", BODY);
  const r = await verifyPlaidWebhook(jwt, BODY, { keyFetcher: fetcherFor(null) });
  ok(r.ok === false && (r as { reason: string }).reason === "unknown_key", "no key for kid → unknown_key");
}

// ── Invalid signature fails (key mismatch) ───────────────────────────────────
{
  _resetKeyCache();
  const A = await makeKey("kid1");
  const B = await makeKey("kid1"); // different keypair, same kid
  const jwt = await sign(A.privateKey, "kid1", BODY);
  const r = await verifyPlaidWebhook(jwt, BODY, { keyFetcher: fetcherFor(B.jwk) });
  ok(r.ok === false && (r as { reason: string }).reason === "invalid_signature", "wrong public key → invalid_signature");
}

// ── Expired token fails (iat > 5 min old) ────────────────────────────────────
{
  _resetKeyCache();
  const { privateKey, jwk } = await makeKey("kid1");
  const old = Math.floor(Date.now() / 1000) - 360; // 6 minutes ago
  const jwt = await sign(privateKey, "kid1", BODY, { iat: old });
  const r = await verifyPlaidWebhook(jwt, BODY, { keyFetcher: fetcherFor(jwk) });
  ok(r.ok === false && (r as { reason: string }).reason === "expired_token", "6-min-old iat → expired_token");
}

// ── Modified body fails body-hash verification ───────────────────────────────
{
  _resetKeyCache();
  const { privateKey, jwk } = await makeKey("kid1");
  // (a) JWT claims a hash of a DIFFERENT body.
  const jwtBadClaim = await sign(privateKey, "kid1", BODY, { sha: bodyHash("something-else") });
  const r1 = await verifyPlaidWebhook(jwtBadClaim, BODY, { keyFetcher: fetcherFor(jwk) });
  ok(r1.ok === false && (r1 as { reason: string }).reason === "body_hash_mismatch", "claim≠body → body_hash_mismatch");
  // (b) Valid JWT for BODY, but the delivered body was tampered with.
  _resetKeyCache();
  const jwtGood = await sign(privateKey, "kid1", BODY);
  const r2 = await verifyPlaidWebhook(jwtGood, BODY + " ", { keyFetcher: fetcherFor(jwk) });
  ok(r2.ok === false && (r2 as { reason: string }).reason === "body_hash_mismatch", "tampered body → body_hash_mismatch");
}

// ── Malformed JWT fails safely ───────────────────────────────────────────────
{
  ok((await verifyPlaidWebhook("not-a-jwt", BODY) as { reason: string }).reason === "malformed_signature", "garbage → malformed_signature");
  _resetKeyCache();
  const { privateKey, jwk } = await makeKey("nokid");
  const jwtNoKid = await sign(privateKey, undefined, BODY); // no kid in header
  const r = await verifyPlaidWebhook(jwtNoKid, BODY, { keyFetcher: fetcherFor(jwk) });
  ok(r.ok === false && (r as { reason: string }).reason === "malformed_signature", "missing kid → malformed_signature");
}

// ── Verification-key caching works ───────────────────────────────────────────
{
  _resetKeyCache();
  const { privateKey, jwk } = await makeKey("kidCache");
  const jwt = await sign(privateKey, "kidCache", BODY);
  let calls = 0;
  const counting: KeyFetcher = async () => {
    calls++;
    return jwk;
  };
  await verifyPlaidWebhook(jwt, BODY, { keyFetcher: counting });
  await verifyPlaidWebhook(jwt, BODY, { keyFetcher: counting });
  ok(calls === 1, "key fetched once, then served from cache");
}

// ── Key rotation is handled (new kid fetched; both verify) ───────────────────
{
  _resetKeyCache();
  const k1 = await makeKey("kidR1");
  const k2 = await makeKey("kidR2");
  const jwt1 = await sign(k1.privateKey, "kidR1", BODY);
  const jwt2 = await sign(k2.privateKey, "kidR2", BODY);
  let calls = 0;
  const f: KeyFetcher = async (kid) => {
    calls++;
    return kid === "kidR1" ? k1.jwk : k2.jwk;
  };
  const r1 = await verifyPlaidWebhook(jwt1, BODY, { keyFetcher: f });
  const r2 = await verifyPlaidWebhook(jwt2, BODY, { keyFetcher: f });
  ok(r1.ok === true && r2.ok === true && calls === 2, "rotation: each kid fetched once, both verify");
}

// ── An already-expired KEY is not usable ─────────────────────────────────────
{
  _resetKeyCache();
  const { privateKey, jwk } = await makeKey("kidExp");
  jwk.expired_at = Math.floor(Date.now() / 1000) - 10; // key retired
  const jwt = await sign(privateKey, "kidExp", BODY);
  const r = await verifyPlaidWebhook(jwt, BODY, { keyFetcher: fetcherFor(jwk) });
  ok(r.ok === false && (r as { reason: string }).reason === "unknown_key", "expired key → unknown_key");
}

// ── Sensitive verification data is NOT logged ────────────────────────────────
{
  _resetKeyCache();
  const { privateKey, jwk } = await makeKey("kidLog");
  const jwt = await sign(privateKey, "kidLog", BODY);
  const logs: string[] = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = (...a: unknown[]) => logs.push(a.join(" "));
  try {
    await verifyPlaidWebhook(jwt, BODY, { keyFetcher: fetcherFor(jwk) });
    await verifyPlaidWebhook("malformed", BODY);
    await verifyPlaidWebhook(jwt, BODY + "x", { keyFetcher: fetcherFor(jwk) });
  } finally {
    Object.assign(console, orig);
  }
  ok(!logs.some((l) => l.includes(jwt)), "verifier never logs the JWT");
  ok(!logs.some((l) => l.includes(BODY)), "verifier never logs the raw body");
}

// ── Static: route preserves secret + item behavior; gated; raw-body-before-parse
{
  const route = readFileSync("app/api/plaid/webhook/route.ts", "utf8");
  ok(route.includes("isAuthorizedPlaidWebhook"), "shared-secret belt-and-braces retained");
  ok(route.includes("PLAID_WEBHOOK_SECRET") || route.includes("isAuthorizedPlaidWebhook"), "dedicated webhook secret still used");
  ok(route.includes("unknown item_id"), "unknown-item behavior preserved");
  ok(route.includes("replaced item"), "replaced-item behavior preserved");
  ok(route.includes("PLAID_WEBHOOK_VERIFY"), "JWT verification is gated by its env flag");
  ok(route.includes("await request.text()"), "raw body is read (for the body hash) before parsing");
  ok(/JSON\.parse\(raw\)/.test(route), "JSON is parsed only from the already-read raw body");
  const abuseAt = route.indexOf('limitRoute("webhookAbuse"');
  const verifyAt = route.indexOf("verifyPlaidWebhook(");
  const dbAt = route.indexOf(".from(bkPlaidItems)");
  ok(abuseAt > 0 && abuseAt < verifyAt, "IP abuse cap runs before JWT verification");
  ok(verifyAt > 0 && verifyAt < dbAt, "JWT verification runs before the DB item lookup");
}

// ── Report ───────────────────────────────────────────────────────────────────
console.log(`\nplaid-webhook-verify: ${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log("  ✗ " + f);
process.exit(fails.length ? 1 : 0);
