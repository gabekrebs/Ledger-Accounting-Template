/**
 * Unit tests for the fail-closed machine-endpoint secret checks
 * (lib/security/machine-auth.ts). Pure logic — no database, no network.
 *
 *   npx tsx scripts/machine-auth.test.mts
 *
 * Covers, for both the cron header and the Plaid webhook token: missing
 * credential, blank credential, wrong credential, correct credential — and the
 * fail-closed cases where the CONFIGURED secret is absent or blank.
 */
import {
  isValidSecret,
  isAuthorizedCron,
  isAuthorizedPlaidWebhook,
} from "../lib/security/machine-auth";

let pass = 0;
const fails: string[] = [];
function ok(cond: boolean, msg: string) {
  if (cond) pass++;
  else fails.push(msg);
}

// ── isValidSecret core semantics ─────────────────────────────────────────────
ok(!isValidSecret("anything", undefined), "unset configured secret rejects");
ok(!isValidSecret("anything", ""), "blank configured secret rejects");
ok(!isValidSecret("anything", "   "), "whitespace configured secret rejects");
ok(!isValidSecret(undefined, "s3cret"), "missing provided rejects");
ok(!isValidSecret(null, "s3cret"), "null provided rejects");
ok(!isValidSecret("", "s3cret"), "blank provided rejects");
ok(!isValidSecret("wrong", "s3cret"), "wrong provided rejects");
ok(!isValidSecret("s3cret ", "s3cret"), "trailing-space provided rejects");
ok(!isValidSecret("undefined", undefined), 'literal "undefined" vs unset rejects (the old fail-open)');
ok(isValidSecret("s3cret", "s3cret"), "exact match accepts");
ok(isValidSecret("s3cret", " s3cret "), "configured value is trimmed (env quoting tolerance)");

// ── cron header (CRON_SECRET) ────────────────────────────────────────────────
function withEnv(name: string, value: string | undefined, fn: () => void) {
  const prev = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env[name];
    else process.env[name] = prev;
  }
}

withEnv("CRON_SECRET", undefined, () => {
  ok(!isAuthorizedCron(null), "cron: no header + unset secret rejects");
  ok(!isAuthorizedCron("Bearer undefined"), "cron: 'Bearer undefined' + unset secret rejects (regression)");
  ok(!isAuthorizedCron("Bearer whatever"), "cron: any bearer + unset secret rejects");
});
withEnv("CRON_SECRET", "", () => {
  ok(!isAuthorizedCron("Bearer "), "cron: blank secret rejects blank bearer");
  ok(!isAuthorizedCron("Bearer x"), "cron: blank secret rejects any bearer");
});
withEnv("CRON_SECRET", "topsecret", () => {
  ok(!isAuthorizedCron(null), "cron: missing header rejects");
  ok(!isAuthorizedCron(""), "cron: empty header rejects");
  ok(!isAuthorizedCron("topsecret"), "cron: bare secret without Bearer prefix rejects");
  ok(!isAuthorizedCron("Bearer wrong"), "cron: wrong secret rejects");
  ok(!isAuthorizedCron("bearer topsecret"), "cron: lowercase scheme rejects (exact header format)");
  ok(isAuthorizedCron("Bearer topsecret"), "cron: correct secret accepts");
});

// ── Plaid webhook token (PLAID_WEBHOOK_SECRET) ───────────────────────────────
withEnv("PLAID_WEBHOOK_SECRET", undefined, () => {
  ok(!isAuthorizedPlaidWebhook(null), "webhook: no token + unset secret rejects");
  ok(!isAuthorizedPlaidWebhook("undefined"), "webhook: 'undefined' token + unset secret rejects");
});
withEnv("PLAID_WEBHOOK_SECRET", "", () => {
  ok(!isAuthorizedPlaidWebhook(""), "webhook: blank secret rejects blank token");
});
withEnv("PLAID_WEBHOOK_SECRET", "hooksecret", () => {
  ok(!isAuthorizedPlaidWebhook(null), "webhook: missing token rejects");
  ok(!isAuthorizedPlaidWebhook(""), "webhook: blank token rejects");
  ok(!isAuthorizedPlaidWebhook("wrong"), "webhook: wrong token rejects");
  ok(isAuthorizedPlaidWebhook("hooksecret"), "webhook: correct token accepts");
});
// Isolation: the webhook must NOT accept the cron secret and vice versa.
withEnv("CRON_SECRET", "cron-s", () => {
  withEnv("PLAID_WEBHOOK_SECRET", "hook-s", () => {
    ok(!isAuthorizedPlaidWebhook("cron-s"), "webhook: CRON_SECRET does not authorize webhook");
    ok(!isAuthorizedCron("Bearer hook-s"), "cron: PLAID_WEBHOOK_SECRET does not authorize cron");
  });
});

if (fails.length) {
  console.error(`FAIL (${fails.length}):`);
  for (const f of fails) console.error("  ✗ " + f);
  process.exit(1);
}
console.log(`machine-auth: ${pass} assertions passed`);
