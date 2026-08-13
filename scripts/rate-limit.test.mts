/**
 * Deterministic unit tests for the targeted rate limiter. No DB / network:
 *
 *   SUPABASE_DB_URL=postgres://u:p@127.0.0.1:5432/none npx tsx scripts/rate-limit.test.mts
 *
 * A concurrency test for the durable PostgresStore upsert is included but only
 * runs when RL_TEST_DB_URL points at a DISPOSABLE database (never production).
 */
import { readFileSync } from "node:fs";
import {
  checkRateLimit,
  limitRoute,
  limitAction,
  clientIp,
  normalizeEmail,
  identityFor,
  loginIdentity,
  hashIdentity,
  POLICIES,
  type Decision,
} from "../lib/security/rate-limit";
import { MemoryStore, type RateLimitStore } from "../lib/security/rate-limit-store";

let pass = 0;
const fails: string[] = [];
const ok = (c: boolean, m: string) => (c ? pass++ : fails.push(m));

const H = (h: Record<string, string>) => ({ get: (k: string) => h[k.toLowerCase()] ?? null });
const store = (clock?: { t: number }, max = 1000): RateLimitStore =>
  new MemoryStore(max, clock ? () => clock.t : undefined);

// ── MemoryStore: below / at / over the limit ─────────────────────────────────
{
  const s = new MemoryStore();
  let last = 0;
  for (let i = 1; i <= 5; i++) last = (await s.hit("k", 60_000)).count;
  ok(last === 5, "5 hits reach the limit (count == 5)");
  const sixth = await s.hit("k", 60_000);
  ok(sixth.count === 6, "the 6th hit exceeds the limit (count == 6 > 5)");
}

// ── Window expiration restores access ────────────────────────────────────────
{
  const clock = { t: 1_000_000 };
  const s = new MemoryStore(1000, () => clock.t);
  for (let i = 0; i < 6; i++) await s.hit("k", 10_000); // over the limit now
  const overNow = (await s.hit("k", 10_000)).count;
  ok(overNow > 5, "still over the limit within the same window");
  clock.t += 10_001; // advance past the window
  const after = await s.hit("k", 10_000);
  ok(after.count === 1, "a new window resets the counter to 1");
}

// ── Different keys have separate allowances ──────────────────────────────────
{
  const s = new MemoryStore();
  for (let i = 0; i < 6; i++) await s.hit("A", 60_000);
  const b = await s.hit("B", 60_000);
  ok(b.count === 1, "key B is unaffected by key A's exhausted budget");
}

// ── Internal storage stays bounded under a key flood ─────────────────────────
{
  const s = new MemoryStore(50);
  for (let i = 0; i < 5000; i++) await s.hit(`flood-${i}`, 60_000);
  ok(s.size() <= 50, `memory bounded under flood (size ${s.size()} <= 50)`);
}

// ── Trusted IP extraction (Vercel proxy) ─────────────────────────────────────
ok(clientIp(H({ "x-real-ip": "9.9.9.9" })) === "9.9.9.9", "x-real-ip is used");
ok(
  clientIp(H({ "x-real-ip": "9.9.9.9", "x-forwarded-for": "1.1.1.1, 2.2.2.2" })) === "9.9.9.9",
  "spoofed x-forwarded-for is IGNORED when x-real-ip is present"
);
ok(
  clientIp(H({ "x-forwarded-for": "3.3.3.3, 4.4.4.4" })) === "3.3.3.3",
  "falls back to leftmost x-forwarded-for only when x-real-ip is absent"
);
ok(clientIp(H({})) === "unknown", "no headers → 'unknown' (never throws)");

// ── Email normalization cannot create fresh buckets ──────────────────────────
ok(normalizeEmail("  User@X.COM ") === "user@x.com", "email normalized (case+trim)");
ok(
  identityFor("  User@X.COM ", H({})) === identityFor("user@x.com", H({})),
  "email variants map to the SAME identity (can't bypass by re-casing)"
);
ok(
  hashIdentity("ai", identityFor("User@X.com", H({}))) ===
    hashIdentity("ai", identityFor("user@x.com ", H({}))),
  "normalized email variants hash identically"
);

// ── Identity fallback + login keying ─────────────────────────────────────────
ok(identityFor(null, H({ "x-real-ip": "5.5.5.5" })).startsWith("ip:"), "no user → IP identity");
ok(identityFor("a@b.com", H({})).startsWith("u:"), "user present → user identity");
ok(
  loginIdentity(H({ "x-real-ip": "7.7.7.7" })) === "ip:7.7.7.7",
  "login is keyed on IP only (email cannot shift the bucket)"
);

// ── Identifiers are non-reversible (no raw email/IP stored) ───────────────────
{
  const h = hashIdentity("login", "ip:5.5.5.5");
  ok(/^[0-9a-f]{64}$/.test(h), "identity hash is a 64-hex sha256");
  ok(!h.includes("5.5.5.5"), "hash does not contain the raw IP");
  ok(!hashIdentity("ai", "u:secret@x.com").includes("secret@x.com"), "hash hides the raw email");
  ok(hashIdentity("ai", "u:x") !== hashIdentity("login", "u:x"), "same identity, different policy → different key");
}

// ── Route handler: 429 + Retry-After + generic body ──────────────────────────
{
  const s = store();
  let resp: Response | null = null;
  for (let i = 0; i < 6; i++) resp = await limitRoute("login", "ip:1.2.3.4", s);
  ok(resp !== null && resp.status === 429, "route over-limit → HTTP 429");
  const ra = Number(resp!.headers.get("Retry-After"));
  ok(Number.isFinite(ra) && ra > 0 && ra <= 15 * 60, `Retry-After present & reasonable (${ra}s)`);
  ok(resp!.headers.get("Cache-Control") === "no-store", "429 is no-store");
  const bodyText = await resp!.text();
  ok(!/1\.2\.3\.4/.test(bodyText), "429 body reveals no identity/IP");
  ok(/too many/i.test(bodyText), "429 body is a generic message");
}
ok((await limitRoute("login", "ip:unused-under-limit", store())) === null, "route under-limit → null (continue)");

// ── Server action: safe structured error ─────────────────────────────────────
{
  const s = store();
  let r = null as Awaited<ReturnType<typeof limitAction>>;
  for (let i = 0; i < 6; i++) r = await limitAction("ai", "u:a@b.com", s);
  ok(r !== null && r.ok === false && r.rateLimited === true, "action over-limit → structured error");
  ok(typeof r!.retryAfterSec === "number" && r!.retryAfterSec > 0, "action error carries retryAfterSec");
  ok(!/a@b\.com/.test(r!.error), "action error message reveals no identity");
}
ok((await limitAction("ai", "u:fresh@b.com", store())) === null, "action under-limit → null (continue)");

// ── Different identities isolated at the enforcement layer ───────────────────
{
  const s = store();
  for (let i = 0; i < 6; i++) await limitAction("ai", "u:heavy@b.com", s);
  ok((await limitAction("ai", "u:light@b.com", s)) === null, "one identity's overage doesn't limit another");
}

// ── Storage failure FAILS OPEN (availability first) ──────────────────────────
{
  const failing: RateLimitStore = {
    async hit() {
      throw new Error("store down");
    },
  };
  const d: Decision = await checkRateLimit("login", "ip:1.2.3.4", failing);
  ok(d.allowed === true, "store error → fail OPEN (request allowed)");
  ok((await limitRoute("login", "ip:1.2.3.4", failing)) === null, "route: store error → no 429");
  ok((await limitAction("ai", "u:a@b.com", failing)) === null, "action: store error → no block");
}

// ── Policy sanity: stricter for login/AI/credentials ─────────────────────────
ok(POLICIES.login.limit <= 5 && POLICIES.ai.limit <= 5, "login/AI are strict");
ok(POLICIES.webhookAbuse.limit >= 200, "webhook cap is generous (won't block Plaid)");
ok(POLICIES.partnerIp.limit >= POLICIES.partner.limit, "partner pre-auth IP cap sits above the per-key budget");

// ── Static: login response does not reveal account existence ─────────────────
{
  const src = readFileSync("app/login/actions.ts", "utf8");
  ok(/const GENERIC\s*=/.test(src), "login uses a single GENERIC failure message");
  ok(
    !/isn't authorized for this app|not authorized for this app/i.test(src),
    "login no longer emits an account-existence-revealing message"
  );
  ok(/!allowed \|\| error/.test(src), "not-allowed and bad-credential funnel to the SAME generic error");
  ok(src.includes("randomUUID"), "auth round-trip runs even for disallowed emails (timing-equalized; throwaway pw → no session)");
}

// ── Static: integration anchors (each surface references the limiter) ─────────
{
  const A = "app/ledger/[entityId]";
  const anchors: Array<[string, string]> = [
    ["app/api/plaid/webhook/route.ts", "webhookAbuse"],
    ["app/api/plaid/link-token/route.ts", "plaidCredential"],
    ["app/api/plaid/exchange/route.ts", "plaidCredential"],
    ["app/api/plaid/refresh-accounts/route.ts", "plaidCredential"],
    ["app/api/plaid/sync/route.ts", "manualSync"],
    // Partner API: IP cap BEFORE auth + per-authenticated-key budget AFTER.
    ["lib/partner/http.ts", '"partnerIp"'],
    ["lib/partner/http.ts", "pk:${principal.keyId}"],
    ["app/login/actions.ts", '"login"'],
    [`${A}/valuation/actions.ts`, '"ai"'],
    [`${A}/rules/actions.ts`, '"ai"'],
    [`${A}/bank/actions.ts`, '"ai"'],
    [`${A}/documents/actions.ts`, '"document"'],
  ];
  for (const [file, needle] of anchors) {
    ok(readFileSync(file, "utf8").includes(needle), `${file} wires ${needle}`);
  }
}

// ── OPTIONAL: PostgresStore atomic-upsert concurrency (disposable DB only) ────
if (process.env.RL_TEST_DB_URL) {
  const { default: postgres } = await import("postgres");
  const sql = postgres(process.env.RL_TEST_DB_URL, { ssl: "require", max: 20 });
  try {
    await sql.unsafe(`CREATE TABLE IF NOT EXISTS bk_rate_limits (
      key text NOT NULL, window_start bigint NOT NULL, count integer NOT NULL DEFAULT 0,
      reset_at timestamptz NOT NULL, PRIMARY KEY (key, window_start))`);
    const k = `concurrency-${Date.now()}`;
    const N = 50;
    const bucket = 1;
    const resetAt = new Date(Date.now() + 60_000).toISOString();
    await Promise.all(
      Array.from({ length: N }, () =>
        sql`INSERT INTO bk_rate_limits (key, window_start, count, reset_at)
            VALUES (${k}, ${bucket}, 1, ${resetAt})
            ON CONFLICT (key, window_start) DO UPDATE SET count = bk_rate_limits.count + 1`
      )
    );
    const [row] = await sql`SELECT count FROM bk_rate_limits WHERE key = ${k} AND window_start = ${bucket}`;
    ok(Number(row.count) === N, `atomic upsert lost no increments under ${N} concurrent hits (got ${row?.count})`);
    await sql`DELETE FROM bk_rate_limits WHERE key = ${k}`;
  } finally {
    await sql.end();
  }
} else {
  console.log("  (skipped PostgresStore concurrency test — set RL_TEST_DB_URL to a disposable DB to run it)");
}

// ── Report ───────────────────────────────────────────────────────────────────
console.log(`\nrate-limit: ${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log("  ✗ " + f);
process.exit(fails.length ? 1 : 0);
