/**
 * Categorization rules engine — shared JSONB shapes + the field registry.
 *
 * PURE / client-safe: this module has no database import (only a type-only import
 * of `CanonicalKey`, erased at compile). It is shared verbatim by the structured
 * rule builder (client), the deterministic auto-poster (server), and the dry-run
 * preview, so the predicate the user authored is the exact predicate that runs.
 *
 * Two halves:
 *   • PREDICATE — a nestable ConditionGroup over a fixed registry of transaction
 *     FACTS (`TxnFacts`). The engine matches a rule when its predicate is true.
 *   • ACTION   — what to do when matched: categorize / split / leave / ignore /
 *     transfer(RESERVED). Account targets are canonical (global rules) or a
 *     concrete account (entity rules).
 */
import type { CanonicalKey } from "@/lib/ledger/canonical-accounts";

// ── Facts ────────────────────────────────────────────────────────────────────

/** Money direction, Plaid convention (positive amount = money OUT = outflow). */
export type Direction = "inflow" | "outflow";

/**
 * Every attribute a rule can test. Phase-1 LIVE fields are populated by
 * `extractFacts`; RESERVED fields are declared so a rule's shape is forward-
 * compatible (and the builder can show them as "coming soon") but carry
 * `undefined` until the underlying data is wired — a condition on a reserved
 * field never matches, it doesn't throw.
 */
export type FieldId =
  // live
  | "merchant" // normalized payee key (normalizeMerchant)
  | "rawName" // raw bank descriptor (Plaid `name`)
  | "amountCents" // signed cents, Plaid convention
  | "direction" // 'inflow' | 'outflow'
  | "plaidCategoryPrimary"
  | "plaidCategoryDetailed"
  | "bankAccountSubtype" // depository/checking, credit card, …
  | "isoCurrencyCode"
  | "dayOfMonth" // 1-31 of txnDate
  | "weekday" // 0 (Sun) – 6 (Sat) of txnDate
  // reserved (wired as the data lands)
  | "memo"
  | "checkNumber"
  | "accountLast4"
  | "location"
  | "entity"
  | "txnType";

/** The resolved fact bag for one transaction. */
export interface TxnFacts {
  merchant: string;
  rawName: string;
  amountCents: number;
  direction: Direction;
  plaidCategoryPrimary: string | null;
  plaidCategoryDetailed: string | null;
  bankAccountSubtype: string | null;
  isoCurrencyCode: string | null;
  dayOfMonth: number;
  weekday: number;
  // reserved — undefined until wired
  memo?: string | null;
  checkNumber?: string | null;
  accountLast4?: string | null;
  location?: string | null;
  entity?: string | null;
  txnType?: string | null;
}

/** A scalar fact value (or absent). */
export type FactValue = string | number | null | undefined;

export interface FieldDef {
  id: FieldId;
  label: string;
  kind: "string" | "number" | "enum";
  /** Allowed values for an enum field (powers the builder's value picker). */
  options?: readonly string[];
  /** Reserved fields render as disabled in the builder and never match yet. */
  reserved?: boolean;
  get: (f: TxnFacts) => FactValue;
}

/**
 * The single source of truth for which fields a rule may test, their kind (which
 * operators the builder offers), and how each is read off `TxnFacts`. Ordered for
 * the builder dropdown — live fields first.
 */
export const FIELD_REGISTRY: readonly FieldDef[] = [
  { id: "merchant", label: "Merchant (normalized)", kind: "string", get: (f) => f.merchant },
  { id: "rawName", label: "Bank descriptor", kind: "string", get: (f) => f.rawName },
  { id: "amountCents", label: "Amount (cents)", kind: "number", get: (f) => f.amountCents },
  { id: "direction", label: "Direction", kind: "enum", options: ["inflow", "outflow"], get: (f) => f.direction },
  { id: "plaidCategoryPrimary", label: "Plaid category (primary)", kind: "string", get: (f) => f.plaidCategoryPrimary },
  { id: "plaidCategoryDetailed", label: "Plaid category (detailed)", kind: "string", get: (f) => f.plaidCategoryDetailed },
  { id: "bankAccountSubtype", label: "Bank account type", kind: "string", get: (f) => f.bankAccountSubtype },
  { id: "isoCurrencyCode", label: "Currency", kind: "string", get: (f) => f.isoCurrencyCode },
  { id: "dayOfMonth", label: "Day of month", kind: "number", get: (f) => f.dayOfMonth },
  { id: "weekday", label: "Weekday (0=Sun)", kind: "number", get: (f) => f.weekday },
  // reserved
  { id: "memo", label: "Memo", kind: "string", reserved: true, get: (f) => f.memo },
  { id: "checkNumber", label: "Check #", kind: "string", reserved: true, get: (f) => f.checkNumber },
  { id: "accountLast4", label: "Account ··last4", kind: "string", reserved: true, get: (f) => f.accountLast4 },
  { id: "location", label: "Property / location", kind: "string", reserved: true, get: (f) => f.location },
  { id: "entity", label: "Entity", kind: "string", reserved: true, get: (f) => f.entity },
  { id: "txnType", label: "Transaction type", kind: "string", reserved: true, get: (f) => f.txnType },
] as const;

export const FIELD_BY_ID: ReadonlyMap<FieldId, FieldDef> = new Map(
  FIELD_REGISTRY.map((d) => [d.id, d])
);

// ── Predicate ────────────────────────────────────────────────────────────────

export type StringOp =
  | "eq"
  | "neq"
  | "contains"
  | "startsWith"
  | "endsWith"
  | "matches" // regex
  | "in"; // value is string[]
export type NumberOp = "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "between"; // between: value is [lo, hi]
export type ConditionOp = StringOp | NumberOp;

export const STRING_OPS: readonly StringOp[] = [
  "eq", "neq", "contains", "startsWith", "endsWith", "matches", "in",
] as const;
export const NUMBER_OPS: readonly NumberOp[] = [
  "eq", "neq", "gt", "gte", "lt", "lte", "between",
] as const;

/** A scalar value a condition tests against. `in` → string[]; `between` → [lo,hi]. */
export type ConditionValue = string | number | string[] | number[];

export interface Condition {
  field: FieldId;
  op: ConditionOp;
  value: ConditionValue;
  /** String comparisons fold case when true (default true for string fields). */
  caseInsensitive?: boolean;
}

/**
 * A boolean combinator over conditions and sub-groups. Exactly one of
 * `all`/`any`/`not` is meaningful per node (the builder emits one); an empty
 * `all` is vacuously TRUE, an empty `any` is vacuously FALSE.
 */
export interface ConditionGroup {
  all?: ConditionNode[];
  any?: ConditionNode[];
  not?: ConditionNode;
}

export type ConditionNode = Condition | ConditionGroup;

/** Runtime discriminator: a leaf Condition carries `field`; a group does not. */
export function isCondition(n: ConditionNode): n is Condition {
  return typeof (n as Condition).field === "string";
}

// ── Action ───────────────────────────────────────────────────────────────────

/**
 * Where a rule posts. Global rules MUST use canonical keys (resolved per-entity);
 * entity rules may target a concrete account in that entity.
 */
export type AccountTarget =
  | { by: "canonical"; key: CanonicalKey }
  | { by: "account"; accountId: string };

/** One leg of a split. Exactly one of `amountCents` / `percent` is set. */
export interface SplitLeg {
  target: AccountTarget;
  amountCents?: number; // fixed cents
  percent?: number; // 0–100 of |amount|
  memo?: string | null;
}

export type ActionSpec =
  | { kind: "categorize"; target: AccountTarget; payee?: string | null }
  | { kind: "split"; legs: SplitLeg[] }
  | { kind: "leave_uncategorized" }
  | { kind: "ignore" }
  | { kind: "transfer" }; // RESERVED — never auto_apply; not resolvable this phase

export type ActionKind = ActionSpec["kind"];

// ── Decision-log vocab (kept here so server + UI agree on the strings) ───────

export type DecisionSource = "rule" | "fingerprint" | "recognizer" | "ai" | "manual";
export type Outcome =
  | "auto_posted"
  | "proposed"
  | "applied_manual"
  | "corrected"
  | "skipped"
  | "ignored"
  | "leave_uncategorized";
