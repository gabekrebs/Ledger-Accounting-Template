/**
 * Builder ↔ predicate conversion — PURE (types only). Shared by the structured
 * rule builder (client) and the rule server actions, so the predicate the user
 * sees in the form is exactly the predicate that gets saved and run.
 *
 * The builder is a flat list of condition ROWS combined by one top-level
 * AND/OR, with an optional NOT per row. That covers AND / OR / NOT (the agreed
 * phase-1 expressiveness) without a nested-group UI; the underlying
 * ConditionGroup is fully nestable, so richer builders can come later without a
 * schema change.
 */
import {
  FIELD_BY_ID,
  type Condition,
  type ConditionGroup,
  type ConditionOp,
  type ConditionValue,
  type FieldId,
} from "@/lib/rules/types";

export interface ConditionRow {
  field: FieldId;
  op: ConditionOp;
  /** Raw text from the form; `in` is comma-separated, `between` is "lo,hi". */
  value: string;
  negated?: boolean;
  caseInsensitive?: boolean;
}

/** Coerce a row's raw string into the typed value the operator expects. */
export function parseValue(
  field: FieldId,
  op: ConditionOp,
  raw: string
): ConditionValue {
  if (op === "in") {
    return raw.split(",").map((s) => s.trim()).filter(Boolean);
  }
  if (op === "between") {
    const [a, b] = raw.split(",").map((s) => Number(s.trim()));
    return [a, b];
  }
  if (FIELD_BY_ID.get(field)?.kind === "number") return Number(raw);
  return raw;
}

export function buildPredicate(
  combinator: "all" | "any",
  rows: ConditionRow[]
): ConditionGroup {
  const nodes = rows.map((r) => {
    const leaf: Condition = {
      field: r.field,
      op: r.op,
      value: parseValue(r.field, r.op, r.value),
      ...(r.caseInsensitive === false ? { caseInsensitive: false } : {}),
    };
    return r.negated ? ({ not: leaf } as ConditionGroup) : leaf;
  });
  return { [combinator]: nodes };
}

/** Flatten a saved predicate back into builder rows (best-effort, for editing). */
export function predicateToRows(group: ConditionGroup): {
  combinator: "all" | "any";
  rows: ConditionRow[];
} {
  const combinator: "all" | "any" = group.any ? "any" : "all";
  const nodes = group[combinator] ?? [];
  const rows: ConditionRow[] = [];
  for (const n of nodes) {
    const negated = "not" in n && !!(n as ConditionGroup).not;
    const leaf = (negated ? (n as ConditionGroup).not : n) as Condition;
    if (!leaf || !("field" in leaf)) continue;
    rows.push({
      field: leaf.field,
      op: leaf.op,
      value: Array.isArray(leaf.value) ? leaf.value.join(",") : String(leaf.value),
      negated,
      caseInsensitive: leaf.caseInsensitive,
    });
  }
  return { combinator, rows };
}
