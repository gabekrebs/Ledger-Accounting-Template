/**
 * Pure-logic unit tests for the rules engine — predicates, facts, split cents,
 * specificity, precedence ordering. No database is touched (the db client is
 * imported lazily by some modules, so a dummy SUPABASE_DB_URL keeps the import
 * from throwing; no connection is ever opened).
 *
 *   SUPABASE_DB_URL=postgres://u:p@127.0.0.1:5432/none npx tsx scripts/rules-engine.test.mts
 *
 * (The dummy URL only satisfies the db client's load-time check; no connection
 * is opened. ESM import hoisting means the env must be set on the command line,
 * before this module's imports evaluate.)
 *
 * No framework (repo convention — see scripts/test-parser.ts): a tiny assert
 * harness that exits non-zero on the first failure batch.
 */

import {
  matches,
  evaluateCondition,
  validatePredicate,
  predicateSpecificity,
} from "../lib/rules/predicates";
import { extractFacts } from "../lib/rules/facts";
import { computeSplitCents } from "../lib/rules/actions";
import { compareRules, type RuleRow } from "../lib/rules/engine";
import { coverageFor } from "../lib/rules/learner";
import { ruleAppliesToEntity, ruleMutableBy } from "../lib/rules/authz";
import { normalizeMerchant, candidateKeys, extractParty } from "../lib/ledger/merchant";
import type { Condition, ConditionGroup, TxnFacts } from "../lib/rules/types";

let pass = 0;
const fails: string[] = [];
function ok(cond: boolean, msg: string) {
  if (cond) pass++;
  else fails.push(msg);
}
function eq<T>(a: T, b: T, msg: string) {
  ok(JSON.stringify(a) === JSON.stringify(b), `${msg} — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
}

// ── fixtures ──────────────────────────────────────────────────────────────────
const facts: TxnFacts = {
  merchant: "comcast",
  rawName: "COMCAST CABLE #1234 PORTLAND OR",
  amountCents: 8999,
  direction: "outflow",
  plaidCategoryPrimary: "UTILITIES",
  plaidCategoryDetailed: "UTILITIES_CABLE_INTERNET",
  bankAccountSubtype: "checking",
  isoCurrencyCode: "USD",
  dayOfMonth: 15,
  weekday: 3,
};
const cond = (c: Partial<Condition> & Pick<Condition, "field" | "op" | "value">): Condition => c as Condition;

// ── string ops ────────────────────────────────────────────────────────────────
ok(evaluateCondition(cond({ field: "merchant", op: "eq", value: "comcast" }), facts), "eq match");
ok(!evaluateCondition(cond({ field: "merchant", op: "eq", value: "verizon" }), facts), "eq miss");
ok(evaluateCondition(cond({ field: "merchant", op: "neq", value: "verizon" }), facts), "neq");
ok(evaluateCondition(cond({ field: "rawName", op: "contains", value: "portland" }), facts), "contains (ci default)");
ok(!evaluateCondition(cond({ field: "rawName", op: "contains", value: "portland", caseInsensitive: false }), facts), "contains case-sensitive miss");
ok(evaluateCondition(cond({ field: "merchant", op: "startsWith", value: "com" }), facts), "startsWith");
ok(evaluateCondition(cond({ field: "merchant", op: "endsWith", value: "cast" }), facts), "endsWith");
ok(evaluateCondition(cond({ field: "merchant", op: "in", value: ["verizon", "comcast"] }), facts), "in match");
ok(!evaluateCondition(cond({ field: "merchant", op: "in", value: ["verizon", "att"] }), facts), "in miss");
ok(evaluateCondition(cond({ field: "rawName", op: "matches", value: "comcast.*\\bOR\\b" }), facts), "matches regex");
ok(!evaluateCondition(cond({ field: "rawName", op: "matches", value: "(" }), facts), "invalid regex → false");

// ── number ops ────────────────────────────────────────────────────────────────
ok(evaluateCondition(cond({ field: "amountCents", op: "gt", value: 8000 }), facts), "gt");
ok(evaluateCondition(cond({ field: "amountCents", op: "gte", value: 8999 }), facts), "gte");
ok(evaluateCondition(cond({ field: "amountCents", op: "lt", value: 9000 }), facts), "lt");
ok(!evaluateCondition(cond({ field: "amountCents", op: "lt", value: 8999 }), facts), "lt boundary");
ok(evaluateCondition(cond({ field: "amountCents", op: "between", value: [8000, 9000] }), facts), "between in");
ok(!evaluateCondition(cond({ field: "amountCents", op: "between", value: [9000, 9999] }), facts), "between out");
ok(evaluateCondition(cond({ field: "dayOfMonth", op: "eq", value: 15 }), facts), "day eq");
ok(evaluateCondition(cond({ field: "direction", op: "eq", value: "outflow" }), facts), "direction eq");

// ── missing / reserved field ─────────────────────────────────────────────────
ok(!evaluateCondition(cond({ field: "memo", op: "eq", value: "x" }), facts), "reserved/missing → false (eq)");
ok(!evaluateCondition(cond({ field: "memo", op: "neq", value: "x" }), facts), "reserved/missing → false (neq)");

// ── groups: AND / OR / NOT ────────────────────────────────────────────────────
const AND: ConditionGroup = {
  all: [
    cond({ field: "merchant", op: "eq", value: "comcast" }),
    cond({ field: "direction", op: "eq", value: "outflow" }),
  ],
};
ok(matches(AND, facts), "AND true");
ok(!matches({ all: [...AND.all!, cond({ field: "amountCents", op: "gt", value: 100000 })] }, facts), "AND false");
ok(matches({ any: [cond({ field: "merchant", op: "eq", value: "x" }), cond({ field: "merchant", op: "eq", value: "comcast" })] }, facts), "OR true");
ok(!matches({ any: [cond({ field: "merchant", op: "eq", value: "x" })] }, facts), "OR false");
ok(matches({ not: cond({ field: "merchant", op: "eq", value: "verizon" }) }, facts), "NOT true");
ok(!matches({ not: cond({ field: "merchant", op: "eq", value: "comcast" }) }, facts), "NOT false");
ok(matches({ all: [] }, facts), "empty all → vacuously true");
ok(!matches({ any: [] }, facts), "empty any → vacuously false");

// ── validation ───────────────────────────────────────────────────────────────
eq(validatePredicate(AND), [], "valid predicate → no errors");
ok(validatePredicate(cond({ field: "merchant", op: "gt" as never, value: 1 })).length > 0, "string field + numeric op → error");
ok(validatePredicate(cond({ field: "nope" as never, op: "eq", value: 1 })).length > 0, "unknown field → error");
ok(validatePredicate({} as ConditionGroup).length > 0, "empty group → error");
ok(validatePredicate(cond({ field: "rawName", op: "matches", value: "(" })).length > 0, "invalid regex → validation error");

// ── specificity ──────────────────────────────────────────────────────────────
eq(predicateSpecificity(AND), 2, "specificity counts leaves");
eq(predicateSpecificity({ all: [AND, cond({ field: "merchant", op: "eq", value: "x" })] }), 3, "nested specificity");

// ── facts extraction ─────────────────────────────────────────────────────────
const f1 = extractFacts({
  name: "COMCAST CABLE #1234 PORTLAND OR",
  merchantName: "Comcast",
  amountCents: 8999,
  isoCurrencyCode: "USD",
  plaidCategory: { primary: "UTILITIES", detailed: "UTILITIES_CABLE_INTERNET" },
  txnDate: "2026-06-15",
  plaidAccountId: "acct_1",
}, { subtypeByPlaidAcct: new Map([["acct_1", "checking"]]) });
eq(f1.merchant, "comcast", "merchant normalized");
eq(f1.direction, "outflow", "positive amount → outflow");
eq(f1.plaidCategoryPrimary, "UTILITIES", "plaid primary");
eq(f1.bankAccountSubtype, "checking", "subtype from ctx");
eq(f1.dayOfMonth, 15, "dayOfMonth");
eq(f1.weekday, 1, "weekday (2026-06-15 is Monday)");
const f2 = extractFacts({
  name: "PAYROLL DEPOSIT", merchantName: null, amountCents: -250000,
  isoCurrencyCode: "USD", plaidCategory: null, txnDate: "2026-06-01", plaidAccountId: "x",
});
eq(f2.direction, "inflow", "negative amount → inflow");

// ── split cents ──────────────────────────────────────────────────────────────
eq(computeSplitCents([{ target: { by: "canonical", key: "expense.utilities" }, percent: 70 }, { target: { by: "canonical", key: "expense.other" }, percent: 30 }], 10000), [7000, 3000], "percent split");
eq(computeSplitCents([{ target: { by: "canonical", key: "expense.utilities" }, percent: 33.3334 }, { target: { by: "canonical", key: "expense.other" }, percent: 66.6666 }], 10001).reduce((a, b) => a + b, 0), 10001, "percent split sums exactly with rounding");
eq(computeSplitCents([{ target: { by: "account", accountId: "a" }, amountCents: 6000 }, { target: { by: "account", accountId: "b" }, amountCents: 4000 }], 10000), [6000, 4000], "fixed split");
let threw = false;
try { computeSplitCents([{ target: { by: "account", accountId: "a" }, amountCents: 6000 }], 10000); } catch { threw = true; }
ok(threw, "all-fixed not summing → throws");

// ── precedence comparator ────────────────────────────────────────────────────
const mk = (o: Partial<RuleRow>): RuleRow =>
  ({ id: o.id, scope: o.scope ?? "entity", rank: o.rank ?? 100, predicate: o.predicate ?? { all: [] }, createdAt: o.createdAt ?? new Date(0) } as RuleRow);
const entityRule = mk({ id: "e", scope: "entity", rank: 100 });
const globalRule = mk({ id: "g", scope: "global", rank: 100 });
ok(compareRules(entityRule, globalRule) < 0, "entity before global");
ok(compareRules(mk({ id: "lo", rank: 10 }), mk({ id: "hi", rank: 200 })) < 0, "lower rank wins");
const specific = mk({ id: "spec", rank: 100, predicate: AND });
const broad = mk({ id: "broad", rank: 100, predicate: { all: [cond({ field: "merchant", op: "eq", value: "x" })] } });
ok(compareRules(specific, broad) < 0, "more specific wins ties");

// ── merchant normalization (relocated to lib/ledger/merchant.ts) ─────────────
eq(normalizeMerchant("COMCAST #1234 PORTLAND OR"), "comcast portland or", "normalize strips digits/punct");
eq(normalizeMerchant("NW Natural"), "northwest natural", "token canon nw→northwest");
eq(normalizeMerchant("City of Portland"), "city portland", "drops stop token 'of'");
eq(normalizeMerchant("CTY PORTLAND"), "city portland", "cty→city");
eq(normalizeMerchant(null), "", "null → empty");
eq(extractParty({ name: "Clean Co" }), "Clean Co", "extractParty passes clean name");
eq(extractParty({ memo: "AIRBNB 4977 DES:AIRBNB" }), "AIRBNB", "extractParty ACH originator");
ok(candidateKeys("Comcast", "COMCAST CABLE DES:BILLPAY").includes("comcast"), "candidateKeys includes merchant key");
ok(candidateKeys("Quantum Fiber 55").includes("centurylink"), "candidateKeys rebrand bridge");

// ── fingerprint parity coverage classification ───────────────────────────────
{
  const activeRule = mk({ id: "a", predicate: { all: [cond({ field: "merchant", op: "eq", value: "comcast" })] } });
  const proposedRule = mk({ id: "p", predicate: { all: [cond({ field: "merchant", op: "eq", value: "verizon" })] } });
  const sets = { active: [activeRule], proposed: [proposedRule] };
  eq(coverageFor("comcast", sets), "active", "parity: active rule covers");
  eq(coverageFor("verizon", sets), "proposed", "parity: proposed rule covers");
  eq(coverageFor("att", sets), "uncovered", "parity: neither → uncovered");
}

// ── authorization: rule entity-binding (Finding 1) ──────────────────────────
{
  const globalRule = { scope: "global", entityId: null };
  const ruleA = { scope: "entity", entityId: "A" };
  const ruleB = { scope: "entity", entityId: "B" };

  // POSITIVE — intended design: a global rule applies to EVERY entity.
  ok(ruleAppliesToEntity(globalRule, "A"), "authz: global rule applies to A");
  ok(ruleAppliesToEntity(globalRule, "B"), "authz: global rule applies to B");
  // POSITIVE: an entity rule applies to its own entity.
  ok(ruleAppliesToEntity(ruleA, "A"), "authz: A's rule applies to A");
  // NEGATIVE: an entity rule NEVER applies to another entity.
  ok(!ruleAppliesToEntity(ruleA, "B"), "authz: A's rule must NOT apply to B");
  ok(!ruleAppliesToEntity(ruleB, "A"), "authz: B's rule must NOT apply to A");

  // POSITIVE: an admin may modify a global rule; an entity user may modify their own.
  ok(ruleMutableBy(globalRule, "A", true), "authz: admin may modify global rule");
  ok(ruleMutableBy(ruleA, "A", false), "authz: A-user may modify A's own rule");
  // NEGATIVE: a non-admin may NOT modify a global rule; and a user acting in
  // entity A may NEVER modify entity B's rule — even as an admin via A's context
  // (the binding is to the request's entity, not to admin power).
  ok(!ruleMutableBy(globalRule, "A", false), "authz: non-admin may NOT modify global rule");
  ok(!ruleMutableBy(ruleB, "A", false), "authz: A-user may NOT modify B's rule");
  ok(!ruleMutableBy(ruleB, "A", true), "authz: B's rule not mutable via A's context");
}

// ── report ────────────────────────────────────────────────────────────────────
if (fails.length) {
  console.error(`\n❌ ${fails.length} failed (${pass} passed):`);
  for (const f of fails) console.error("  • " + f);
  process.exit(1);
}
console.log(`✅ all ${pass} assertions passed`);
