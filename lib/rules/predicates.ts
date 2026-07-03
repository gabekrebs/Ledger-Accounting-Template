/**
 * Predicate evaluation + validation — PURE (types only, no db, no facts
 * extraction). The same `matches` runs in the auto-poster, the dry-run preview,
 * and any test. Determinism is the whole point: given a rule's predicate and a
 * transaction's facts, the answer is a stable boolean.
 *
 * Missing-fact rule: when a field's value is absent (null/undefined — e.g. a
 * RESERVED field not yet wired), every operator evaluates FALSE. So a reserved
 * field never matches, and "absence" is expressed explicitly with a NOT group
 * rather than leaking through a stray `neq`.
 */
import {
  type Condition,
  type ConditionGroup,
  type ConditionNode,
  type ConditionValue,
  type TxnFacts,
  type FactValue,
  NUMBER_OPS,
  STRING_OPS,
  FIELD_BY_ID,
  isCondition,
} from "@/lib/rules/types";

// ── Evaluation ───────────────────────────────────────────────────────────────

function asString(v: FactValue): string | null {
  if (v === null || v === undefined) return null;
  return String(v);
}
function asNumber(v: FactValue): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}
const fold = (s: string, ci: boolean) => (ci ? s.toLowerCase() : s);

function evalStringOp(
  op: Condition["op"],
  actual: string,
  value: ConditionValue,
  ci: boolean
): boolean {
  const a = fold(actual, ci);
  if (op === "in") {
    const arr = Array.isArray(value) ? (value as unknown[]) : [value];
    return arr.some((v) => fold(String(v), ci) === a);
  }
  if (op === "matches") {
    try {
      return new RegExp(String(value), ci ? "i" : "").test(actual);
    } catch {
      return false; // an invalid regex never matches (validation surfaces it)
    }
  }
  const b = fold(String(value), ci);
  switch (op) {
    case "eq":
      return a === b;
    case "neq":
      return a !== b;
    case "contains":
      return a.includes(b);
    case "startsWith":
      return a.startsWith(b);
    case "endsWith":
      return a.endsWith(b);
    default:
      return false;
  }
}

function evalNumberOp(
  op: Condition["op"],
  actual: number,
  value: ConditionValue
): boolean {
  if (op === "between") {
    if (!Array.isArray(value) || value.length !== 2) return false;
    const lo = Number(value[0]);
    const hi = Number(value[1]);
    return actual >= Math.min(lo, hi) && actual <= Math.max(lo, hi);
  }
  const b = Array.isArray(value) ? Number(value[0]) : Number(value);
  if (!Number.isFinite(b)) return false;
  switch (op) {
    case "eq":
      return actual === b;
    case "neq":
      return actual !== b;
    case "gt":
      return actual > b;
    case "gte":
      return actual >= b;
    case "lt":
      return actual < b;
    case "lte":
      return actual <= b;
    default:
      return false;
  }
}

/** Evaluate one leaf condition against the facts. */
export function evaluateCondition(cond: Condition, facts: TxnFacts): boolean {
  const def = FIELD_BY_ID.get(cond.field);
  if (!def) return false; // unknown field → never matches
  const raw = def.get(facts);
  if (raw === null || raw === undefined) return false; // missing fact → false

  // Branch on the FIELD kind, never the operator (eq/neq belong to both op
  // sets). Numeric fields compare numerically; string + enum fields textually.
  if (def.kind === "number") {
    const n = asNumber(raw);
    return n === null ? false : evalNumberOp(cond.op, n, cond.value);
  }
  const s = asString(raw);
  // String fields default to case-insensitive; honor an explicit false.
  const ci = cond.caseInsensitive ?? true;
  return s === null ? false : evalStringOp(cond.op, s, cond.value, ci);
}

/** Evaluate a predicate node (leaf or group) against the facts. */
export function matches(node: ConditionNode, facts: TxnFacts): boolean {
  if (isCondition(node)) return evaluateCondition(node, facts);
  const g = node as ConditionGroup;
  // all: vacuously true; any: vacuously false; not: negate the child.
  if (g.all && !g.all.every((n) => matches(n, facts))) return false;
  if (g.any && !g.any.some((n) => matches(n, facts))) return false;
  if (g.not && matches(g.not, facts)) return false;
  return true;
}

// ── Specificity (engine tie-break: more conditions = more specific) ──────────

/** Count of leaf conditions in a predicate — the "specificity" the engine sorts by. */
export function predicateSpecificity(node: ConditionNode): number {
  if (isCondition(node)) return 1;
  const g = node as ConditionGroup;
  let n = 0;
  for (const child of g.all ?? []) n += predicateSpecificity(child);
  for (const child of g.any ?? []) n += predicateSpecificity(child);
  if (g.not) n += predicateSpecificity(g.not);
  return n;
}

// ── Validation ───────────────────────────────────────────────────────────────

/**
 * Structural validation of a predicate — returns human-readable errors (empty =
 * valid). The builder calls this before save; the store calls it as a backstop.
 */
export function validatePredicate(node: ConditionNode, path = "predicate"): string[] {
  if (isCondition(node)) return validateCondition(node, path);
  const g = node as ConditionGroup;
  const branches = [g.all, g.any, g.not].filter((b) => b !== undefined);
  if (branches.length === 0) {
    return [`${path}: a group must have one of all / any / not`];
  }
  const errs: string[] = [];
  g.all?.forEach((n, i) => errs.push(...validatePredicate(n, `${path}.all[${i}]`)));
  g.any?.forEach((n, i) => errs.push(...validatePredicate(n, `${path}.any[${i}]`)));
  if (g.not) errs.push(...validatePredicate(g.not, `${path}.not`));
  return errs;
}

function validateCondition(c: Condition, path: string): string[] {
  const def = FIELD_BY_ID.get(c.field);
  if (!def) return [`${path}: unknown field "${c.field}"`];
  const errs: string[] = [];
  const numeric = def.kind === "number";
  const allowed = numeric ? NUMBER_OPS : STRING_OPS;
  if (!(allowed as readonly string[]).includes(c.op)) {
    errs.push(`${path}: operator "${c.op}" is not valid for field "${c.field}"`);
  }
  if (c.op === "in" && !Array.isArray(c.value)) {
    errs.push(`${path}: "in" requires a list value`);
  }
  if (c.op === "between") {
    if (!Array.isArray(c.value) || c.value.length !== 2) {
      errs.push(`${path}: "between" requires a [low, high] pair`);
    } else if (!c.value.every((v) => Number.isFinite(Number(v)))) {
      // Without this, a single number typed for a range yields [10, NaN] and the
      // rule saves clean but silently matches nothing (NaN comparisons are false).
      errs.push(`${path}: "between" bounds must both be numbers`);
    }
  }
  if (numeric && c.op !== "between" && c.op !== "in") {
    const n = Array.isArray(c.value) ? c.value[0] : c.value;
    if (n === "" || n === null || n === undefined || !Number.isFinite(Number(n))) {
      errs.push(`${path}: numeric field needs a number value`);
    }
  }
  if (c.op === "matches") {
    try {
      new RegExp(String(c.value));
    } catch {
      errs.push(`${path}: invalid regular expression`);
    }
  }
  return errs;
}
