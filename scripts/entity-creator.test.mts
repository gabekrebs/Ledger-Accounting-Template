/**
 * Unit tests for the owner-only entity-creation policy
 * (lib/ledger/access.ts isEntityCreator). Pure identity check — roles,
 * bk_app_users rows, and env admin lists must not widen it, which holds by
 * construction: the function reads nothing but the email string vs OWNER_EMAIL.
 *
 *   OWNER_EMAIL=owner@example.com SUPABASE_DB_URL=postgres://u:p@127.0.0.1:5432/none \
 *     npx tsx scripts/entity-creator.test.mts
 *
 * (Dummy db URL only satisfies the db client's load-time check via access.ts's
 * import chain; no connection is opened.)
 *
 * Request-level coverage: `createEntity` calls `assertEntityCreator()` (which
 * 404s via notFound()) before touching form data, and /ledger/new's server
 * page does the same — both resolve the email from the SERVER-SIDE Supabase
 * session (getCurrentUser), never from client input. These tests pin the
 * policy function those guards delegate to, for every caller class:
 * owner, other admin, ordinary member, unauthenticated.
 */
process.env.OWNER_EMAIL = "owner@example.com";
import { isEntityCreator } from "../lib/ledger/access";

let pass = 0;
const fails: string[] = [];
function ok(cond: boolean, msg: string) {
  if (cond) pass++;
  else fails.push(msg);
}

// Owner (OWNER_EMAIL) — the only identity that may create entities.
ok(isEntityCreator("owner@example.com"), "owner email accepts");
ok(isEntityCreator("Owner@Example.com"), "owner email accepts case-insensitively");
ok(isEntityCreator("  owner@example.com  "), "owner email accepts with whitespace");

// Another ADMIN (full entity access) — must still be rejected: creation is an
// identity capability, not a role capability.
ok(!isEntityCreator("otheradmin@example.com"), "other admin email rejects");

// Ordinary member with entity grants.
ok(!isEntityCreator("member@example.com"), "ordinary member rejects");

// Unauthenticated (no session → no email).
ok(!isEntityCreator(null), "null (unauthenticated) rejects");
ok(!isEntityCreator(undefined), "undefined (unauthenticated) rejects");
ok(!isEntityCreator(""), "empty email rejects");

// Near-miss identities must not pass.
ok(!isEntityCreator("owner@example.com.evil.com"), "suffixed domain rejects");
ok(!isEntityCreator("xowner@example.com"), "prefixed local part rejects");
ok(!isEntityCreator("owner+entity@example.com"), "plus-alias rejects");

if (fails.length) {
  console.error(`FAIL (${fails.length}):`);
  for (const f of fails) console.error("  ✗ " + f);
  process.exit(1);
}
console.log(`entity-creator: ${pass} assertions passed`);
