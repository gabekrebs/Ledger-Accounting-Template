/**
 * Action resolution — turn a rule's `ActionSpec` into the concrete inputs the
 * ledger writers (`lib/plaid/post.ts`) accept, resolving canonical keys to the
 * entity's actual accounts and computing split cents that sum EXACTLY to the
 * transaction amount.
 *
 * Resolution is read-only; it never posts. It also reports which canonical keys
 * have no home in the entity (the dry-run preview surfaces these) and validates
 * an action at author time.
 */
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import {
  resolveCanonicalAccounts,
  type CanonicalKey,
  type ResolvedAccount,
} from "@/lib/ledger/canonical-accounts";
import type { PostSplit } from "@/lib/plaid/post";
import type { AccountTarget, ActionSpec, SplitLeg } from "@/lib/rules/types";

// ── Canonical-resolution cache (one map per entity, shared across a sweep) ────

export type CanonCache = Map<string, Map<CanonicalKey, ResolvedAccount>>;
export const newCanonCache = (): CanonCache => new Map();

export async function getCanon(
  entityId: string,
  cache: CanonCache
): Promise<Map<CanonicalKey, ResolvedAccount>> {
  let m = cache.get(entityId);
  if (!m) {
    m = await resolveCanonicalAccounts(entityId);
    cache.set(entityId, m);
  }
  return m;
}

// ── Split cents (PURE — testable without a db) ───────────────────────────────

/**
 * Compute per-leg cents that sum to exactly `absAmount`. A leg is either a fixed
 * `amountCents` or a `percent` of the amount. Percent legs are rounded; the
 * residual (rounding drift, or a deliberate "remainder" leg) is absorbed by the
 * LAST percent leg so the total is exact — which is what `postPlaidTransactionSplit`
 * requires. An all-fixed set that doesn't sum to the amount is a configuration
 * error and throws (nothing to absorb the difference).
 */
export function computeSplitCents(legs: SplitLeg[], absAmount: number): number[] {
  const cents = legs.map((l) =>
    l.amountCents != null
      ? Math.round(l.amountCents)
      : l.percent != null
        ? Math.round((l.percent / 100) * absAmount)
        : 0
  );
  const diff = absAmount - cents.reduce((a, b) => a + b, 0);
  if (diff !== 0) {
    const lastPercent = legs.reduce(
      (idx, l, i) => (l.percent != null ? i : idx),
      -1
    );
    if (lastPercent < 0) {
      throw new Error("split legs do not sum to the transaction amount");
    }
    cents[lastPercent] += diff;
  }
  if (cents.some((c) => c <= 0)) {
    throw new Error("a split leg resolved to a non-positive amount");
  }
  if (cents.reduce((a, b) => a + b, 0) !== absAmount) {
    throw new Error("split does not sum to the transaction amount");
  }
  return cents;
}

// ── Resolution ───────────────────────────────────────────────────────────────

export type ResolvedAction =
  | { kind: "categorize"; categoryAccountId: string; payee?: string | null }
  | { kind: "split"; splits: PostSplit[] }
  | { kind: "leave" }
  | { kind: "ignore" };

export interface ResolveResult {
  resolved?: ResolvedAction;
  /** Canonical keys with no matching account in this entity (preview surfaces these). */
  unresolved: CanonicalKey[];
  error?: string;
}

function resolveTarget(
  target: AccountTarget,
  canon: Map<CanonicalKey, ResolvedAccount>,
  unresolved: CanonicalKey[]
): string | null {
  if (target.by === "account") return target.accountId;
  const hit = canon.get(target.key);
  if (!hit) {
    if (!unresolved.includes(target.key)) unresolved.push(target.key);
    return null;
  }
  return hit.id;
}

/**
 * Resolve a rule action for a transaction of magnitude `absAmountCents`. Returns
 * the writer-ready inputs, or an `error` (and/or `unresolved` keys) when it can't
 * be applied. Pure of writes.
 */
export async function resolveAction(
  action: ActionSpec,
  entityId: string,
  absAmountCents: number,
  cache: CanonCache
): Promise<ResolveResult> {
  const unresolved: CanonicalKey[] = [];

  if (action.kind === "leave_uncategorized") {
    return { resolved: { kind: "leave" }, unresolved };
  }
  if (action.kind === "ignore") {
    return { resolved: { kind: "ignore" }, unresolved };
  }
  if (action.kind === "transfer") {
    return { unresolved, error: "transfer actions are not supported in this phase" };
  }

  const canon = await getCanon(entityId, cache);

  if (action.kind === "categorize") {
    const id = resolveTarget(action.target, canon, unresolved);
    if (!id) {
      return { unresolved, error: `unresolved category for keys: ${unresolved.join(", ")}` };
    }
    return {
      resolved: { kind: "categorize", categoryAccountId: id, payee: action.payee ?? null },
      unresolved,
    };
  }

  // split
  const ids = action.legs.map((l) => resolveTarget(l.target, canon, unresolved));
  if (ids.some((id) => id === null)) {
    return { unresolved, error: `unresolved split target(s): ${unresolved.join(", ")}` };
  }
  let cents: number[];
  try {
    cents = computeSplitCents(action.legs, absAmountCents);
  } catch (e) {
    return { unresolved, error: e instanceof Error ? e.message : String(e) };
  }
  const splits: PostSplit[] = action.legs.map((l, i) => ({
    accountId: ids[i]!,
    amountCents: cents[i],
    memo: l.memo ?? null,
  }));
  return { resolved: { kind: "split", splits }, unresolved };
}

// ── Validation (author time) ─────────────────────────────────────────────────

/**
 * Validate an action for a rule of the given scope. Global rules may only target
 * canonical keys; entity `by:'account'` targets must belong to the entity;
 * `transfer` is rejected (reserved). Returns human-readable errors (empty = ok).
 */
export async function validateAction(
  action: ActionSpec,
  scope: "global" | "entity",
  entityId: string | null
): Promise<string[]> {
  const errs: string[] = [];
  const targets: AccountTarget[] = [];
  if (action.kind === "categorize") targets.push(action.target);
  if (action.kind === "split") {
    if (!action.legs.length) errs.push("a split needs at least one leg");
    for (const l of action.legs) {
      targets.push(l.target);
      const hasFixed = l.amountCents != null;
      const hasPct = l.percent != null;
      if (hasFixed === hasPct) {
        errs.push("each split leg needs exactly one of amount or percent");
      }
      if (hasPct && (l.percent! <= 0 || l.percent! > 100)) {
        errs.push("split percent must be between 0 and 100");
      }
      if (hasFixed && l.amountCents! <= 0) {
        errs.push("split amount must be positive");
      }
    }
    // All-percent splits must sum to 100. Otherwise computeSplitCents silently
    // dumps the residual on the last percent leg (a balanced but WRONG split,
    // e.g. an authored [30%,30%] posting as [30%,70%]). Catch it at author time.
    const allPercent =
      action.legs.length > 0 &&
      action.legs.every((l) => l.percent != null && l.amountCents == null);
    if (allPercent) {
      const sum = action.legs.reduce((s, l) => s + (l.percent ?? 0), 0);
      if (Math.abs(sum - 100) > 0.001) errs.push("split percents must sum to 100");
    }
  }
  if (action.kind === "transfer") {
    errs.push("transfer actions are reserved and cannot be saved yet");
  }

  for (const t of targets) {
    if (scope === "global" && t.by !== "canonical") {
      errs.push("global rules may only target canonical category keys");
    }
  }

  // Entity account targets must belong to the entity.
  if (scope === "entity" && entityId) {
    const acctIds = targets
      .filter((t): t is { by: "account"; accountId: string } => t.by === "account")
      .map((t) => t.accountId);
    for (const accountId of acctIds) {
      const [a] = await db
        .select({ id: schema.bkAccounts.id })
        .from(schema.bkAccounts)
        .where(
          and(
            eq(schema.bkAccounts.id, accountId),
            eq(schema.bkAccounts.entityId, entityId)
          )
        );
      if (!a) errs.push("a target account does not belong to this entity");
    }
  }
  return errs;
}
