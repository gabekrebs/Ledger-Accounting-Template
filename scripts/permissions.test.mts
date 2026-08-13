/**
 * Unit tests for the role-based write guard.
 *
 *   SUPABASE_DB_URL=postgres://u:p@127.0.0.1:5432/none npx tsx scripts/permissions.test.mts
 *
 * Two layers:
 *  1. The PURE decision (writeGuardOutcome) — exhaustive: read-only and no-access
 *     can NEVER resolve to 'allow', which is the whole point of the feature.
 *  2. A static regression anchor over the server actions — every mutation file
 *     must reference the write/admin guard, so a future write action can't
 *     silently ship on the read-only guard.
 */
import { readFileSync } from "node:fs";
import { writeGuardOutcome } from "../lib/ledger/access";

let pass = 0;
const fails: string[] = [];
const ok = (c: boolean, m: string) => (c ? pass++ : fails.push(m));

// ── 1. Pure decision ────────────────────────────────────────────────────────
ok(writeGuardOutcome("write") === "allow", "write access allows the mutation");
ok(writeGuardOutcome("read") === "forbidden", "read-only is forbidden (403) from writing");
ok(writeGuardOutcome("none") === "not_found", "no access is 404 (hides existence)");
// The security invariant, stated directly:
for (const level of ["read", "none"] as const) {
  ok(writeGuardOutcome(level) !== "allow", `${level} can never write (server-side)`);
}

// ── 2. Static guard coverage over the server actions ────────────────────────
const A = "app/ledger/[entityId]";
// (file, required guard string, why)
const anchors: Array<[string, string, string]> = [
  [`${A}/bank/actions.ts`, "assertEntityWrite", "posting/reversing is write-gated"],
  [`${A}/transactions/actions.ts`, "assertEntityWrite", "manual JE create/delete is write-gated"],
  [`${A}/accounts/actions.ts`, "assertEntityWrite", "chart edits are write-gated"],
  [`${A}/loans/actions.ts`, "assertEntityWrite", "loan config is write-gated"],
  [`${A}/reconcile/actions.ts`, "assertEntityWrite", "reconciliation is write-gated"],
  [`${A}/valuation/actions.ts`, "assertEntityWrite", "valuation edits are write-gated"],
  [`${A}/rules/actions.ts`, "assertEntityWrite", "rule changes are write-gated"],
  [`${A}/actions.ts`, "assertEntityWrite", "transaction edits are write-gated"],
  // Admin-only surfaces:
  [`${A}/documents/actions.ts`, "assertAdmin", "document DELETE is admin-only"],
  // OWNER-only surfaces (the owner's identity, not the admin role tier):
  [`${A}/bank/actions.ts`, "assertOwner", "AI suggestion spend is owner-only"],
  [`${A}/rules/actions.ts`, "assertOwner", "AI rule authoring/drafting is owner-only"],
  [`${A}/valuation/actions.ts`, "assertOwner", "AI valuation estimate is owner-only"],
  ["app/ledger/connections/actions.ts", "assertOwner", "bank-connection management is owner-only"],
  ["app/api/plaid/sync/route.ts", "currentUserIsOwner", "manual Plaid sync is owner-only"],
  ["app/api/plaid/link-token/route.ts", "currentUserIsOwner", "bank linking is owner-only"],
  ["app/api/plaid/exchange/route.ts", "currentUserIsOwner", "token exchange is owner-only"],
  ["app/api/plaid/refresh-accounts/route.ts", "currentUserIsOwner", "account refresh is owner-only"],
  // Role assignment from the browser is allowlisted server-side:
  ["app/ledger/users/actions.ts", "assertAssignableRole", "owner/admin roles can't be minted from the client"],
  // Every write action logs to the review log:
  [`${A}/bank/actions.ts`, "logAudit", "writes are recorded for review"],
  [`${A}/documents/actions.ts`, "logAudit", "uploads/downloads are recorded for review"],
];
for (const [file, needle, why] of anchors) {
  let src = "";
  try {
    src = readFileSync(file, "utf8");
  } catch {
    fails.push(`could not read ${file}`);
    continue;
  }
  ok(src.includes(needle), `${file} references ${needle} — ${why}`);
}

// The write guard and the audit logger are wired into the same access module /
// audit module the actions import (sanity that the imports resolve).
ok(typeof writeGuardOutcome === "function", "writeGuardOutcome is exported");

if (fails.length) {
  console.error(`FAIL (${fails.length}):`);
  for (const f of fails) console.error("  ✗ " + f);
  process.exit(1);
}
console.log(`permissions: ${pass} assertions passed`);
