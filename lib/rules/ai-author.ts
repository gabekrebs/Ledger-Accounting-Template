/**
 * AI as a rule AUTHOR — never an executor.
 *
 * The model proposes deterministic categorization rules; it never categorizes a
 * transaction directly. Two entry points, both writing only PROPOSED rules (or a
 * draft for the builder) that a human approves:
 *   • proposeRulesFromAI(entityId) — scan recurring pending merchants and propose
 *     merchant → canonical-category rules (with reasoning + confidence).
 *   • draftRuleFromNL(entityId, phrase) — turn a natural-language phrase into a
 *     draft predicate/action for the structured builder (zero write).
 *
 * Model output is strictly validated against the live field registry + canonical
 * keys, so a hallucinated field/category is dropped, never saved. Once approved,
 * the deterministic engine — not the model — drives every future decision.
 */
import Anthropic from "@anthropic-ai/sdk";
import { listPendingTransactions } from "@/lib/plaid/data";
import { extractParty, normalizeMerchant } from "@/lib/ledger/merchant";
import { CANONICAL, type CanonicalKey } from "@/lib/ledger/canonical-accounts";
import { loadRules, selectRule } from "@/lib/rules/engine";
import { proposeLearnedRule, listProposedForEntity } from "@/lib/rules/store";
import { buildPredicate, type ConditionRow } from "@/lib/rules/build";
import {
  FIELD_REGISTRY,
  type ActionSpec,
  type ConditionGroup,
  type ConditionOp,
  type FieldId,
  type TxnFacts,
} from "@/lib/rules/types";

const MODEL = "claude-haiku-4-5";

let client: Anthropic | null = null;
function getClient(): Anthropic | null {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!client) client = new Anthropic();
  return client;
}

// The model may only use LIVE fields and valid canonical keys.
const LIVE_FIELDS = FIELD_REGISTRY.filter((f) => !f.reserved).map((f) => f.id);
const CANON_KEYS = new Set(CANONICAL.map((d) => d.key));
const FIELD_SET = new Set<FieldId>(LIVE_FIELDS);
const OPS = new Set<ConditionOp>([
  "eq", "neq", "contains", "startsWith", "endsWith", "matches", "in",
  "gt", "gte", "lt", "lte", "between",
]);

function synthFacts(merchant: string): TxnFacts {
  return {
    merchant, rawName: merchant, amountCents: 0, direction: "outflow",
    plaidCategoryPrimary: null, plaidCategoryDetailed: null, bankAccountSubtype: null,
    isoCurrencyCode: null, dayOfMonth: 1, weekday: 0,
  };
}

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    rules: {
      type: "array",
      description: "Proposed categorization rules. Omit anything you are unsure of.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string", description: "Short human label, e.g. 'Comcast → Utilities'." },
          reasoning: { type: "string", description: "One sentence: why this rule." },
          confidence: { type: "number" },
          match: { type: "string", enum: ["all", "any"] },
          conditions: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                field: { type: "string" },
                op: { type: "string" },
                value: { type: "string" },
                negate: { type: "boolean" },
              },
              required: ["field", "op", "value", "negate"],
            },
          },
          category_key: {
            type: "string",
            description: "A canonical category key copied VERBATIM from the provided list.",
          },
        },
        required: ["name", "reasoning", "confidence", "match", "conditions", "category_key"],
      },
    },
  },
  required: ["rules"],
} as const;

const SYSTEM = (
  "You author DETERMINISTIC categorization rules for a bookkeeping system. You never " +
  "categorize a transaction directly — you propose rules a human approves. Each rule has " +
  "conditions over transaction fields and a target CANONICAL category key (copied verbatim " +
  "from the provided list). Prefer the simplest reliable rule — usually a single " +
  "`merchant contains <stable token>` condition. Only use the fields listed. Set confidence " +
  "honestly (~0.9 when the merchant makes the category obvious, lower when guessing). Omit a " +
  "merchant entirely rather than propose a shaky rule."
);

function fieldsBlock(): string {
  return (
    "FIELDS you may use in conditions:\n" +
    FIELD_REGISTRY.filter((f) => !f.reserved)
      .map((f) => `  - ${f.id} (${f.kind})`)
      .join("\n") +
    "\nString ops: eq, neq, contains, startsWith, endsWith, matches, in. " +
    "Number ops: eq, neq, gt, gte, lt, lte, between."
  );
}
function categoriesBlock(): string {
  return (
    "CANONICAL CATEGORIES (copy category_key verbatim):\n" +
    CANONICAL.map((d) => `  - ${d.label}  [category_key: ${d.key}]`).join("\n")
  );
}

interface RawRule {
  name?: unknown;
  reasoning?: unknown;
  confidence?: unknown;
  match?: unknown;
  conditions?: unknown;
  category_key?: unknown;
}

/** Validate one model rule into a (predicate, action) or null. */
function validateRawRule(
  r: RawRule
): { name: string; reasoning: string; confidence: number; predicate: ConditionGroup; action: ActionSpec } | null {
  const name = typeof r.name === "string" ? r.name.slice(0, 120) : "";
  const key = typeof r.category_key === "string" ? r.category_key : "";
  if (!name || !CANON_KEYS.has(key as CanonicalKey)) return null;
  const match = r.match === "any" ? "any" : "all";
  const rawConds = Array.isArray(r.conditions) ? r.conditions : [];
  const rows: ConditionRow[] = [];
  for (const c of rawConds as Record<string, unknown>[]) {
    const field = c.field as FieldId;
    const op = c.op as ConditionOp;
    const value = typeof c.value === "string" ? c.value : String(c.value ?? "");
    if (!FIELD_SET.has(field) || !OPS.has(op) || value === "") continue;
    rows.push({ field, op, value, negated: c.negate === true });
  }
  if (!rows.length) return null;
  return {
    name,
    reasoning: typeof r.reasoning === "string" ? r.reasoning.slice(0, 300) : "",
    confidence: typeof r.confidence === "number" ? Math.min(1, Math.max(0, r.confidence)) : 0,
    predicate: buildPredicate(match, rows),
    action: { kind: "categorize", target: { by: "canonical", key: key as CanonicalKey } },
  };
}

export interface AIProposeResult {
  proposed: number;
  error?: string;
}

/**
 * Scan recurring pending merchants with no covering rule and propose
 * merchant→category rules. Writes only proposed rules (origin 'nl', entity scope,
 * canonical target). Idempotent against existing active/proposed coverage.
 */
export async function proposeRulesFromAI(entityId: string): Promise<AIProposeResult> {
  const a = getClient();
  if (!a) return { proposed: 0, error: "ANTHROPIC_API_KEY is not set" };

  const pending = await listPendingTransactions(entityId);
  // Aggregate by normalized merchant; only recurring, uncovered merchants.
  const activeRules = await loadRules(entityId);
  const counts = new Map<string, { label: string; n: number }>();
  for (const t of pending) {
    const label = t.merchantName ?? extractParty({ memo: t.name }) ?? t.name ?? "";
    const key = normalizeMerchant(label);
    if (key.length < 3) continue;
    if (selectRule(activeRules, synthFacts(key))) continue; // already covered
    const cur = counts.get(key) ?? { label, n: 0 };
    cur.n++;
    counts.set(key, cur);
  }
  const merchants = [...counts.entries()]
    .sort((x, y) => y[1].n - x[1].n)
    .slice(0, 50)
    .map(([key, v]) => `  - ${v.label} (key: ${key}, ${v.n} pending)`);
  if (!merchants.length) return { proposed: 0 };

  let parsed: { rules?: RawRule[] };
  try {
    const msg = await a.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: [
        { type: "text", text: SYSTEM },
        { type: "text", text: fieldsBlock() + "\n\n" + categoriesBlock(), cache_control: { type: "ephemeral", ttl: "1h" } },
      ],
      messages: [
        {
          role: "user",
          content:
            "RECURRING MERCHANTS needing a rule:\n\n" +
            merchants.join("\n") +
            "\n\nPropose categorization rules. Prefer one merchant-contains condition each.",
        },
      ],
      output_config: { format: { type: "json_schema", schema: SCHEMA } },
    } as Anthropic.MessageCreateParamsNonStreaming);
    const block = msg.content.find((b) => b.type === "text");
    parsed = block && block.type === "text" ? JSON.parse(block.text) : {};
  } catch (e) {
    return { proposed: 0, error: e instanceof Error ? e.message : String(e) };
  }

  // Dedup against ALL existing coverage — active AND already-proposed — and
  // within this run, so re-clicking "Author with AI" can't flood the proposed
  // queue with duplicates (loadRules returns active only).
  const proposedExisting = await listProposedForEntity(entityId);
  const seen = new Set(
    [...activeRules, ...proposedExisting].map((r) => JSON.stringify(r.predicate))
  );
  let proposed = 0;
  for (const raw of parsed.rules ?? []) {
    const v = validateRawRule(raw);
    if (!v) continue;
    const mCond = JSON.stringify(v.predicate);
    if (seen.has(mCond)) continue; // already covered (active/proposed) or dup this run
    seen.add(mCond);
    await proposeLearnedRule({
      scope: "entity",
      entityId,
      name: v.name,
      description: `AI: ${v.reasoning} (~${Math.round(v.confidence * 100)}%)`,
      predicate: v.predicate,
      action: v.action,
    });
    proposed++;
  }
  return { proposed };
}

export interface NLDraft {
  rows: ConditionRow[];
  categoryKey: string | null;
  name: string;
  reasoning: string;
}

/**
 * Turn a natural-language phrase ("comcast and centurylink are utilities") into a
 * draft predicate/action for the structured builder. Returns the draft — writes
 * nothing; the user reviews + saves it through the normal builder + preview.
 */
export async function draftRuleFromNL(
  entityId: string,
  phrase: string
): Promise<{ draft?: NLDraft; error?: string }> {
  const a = getClient();
  if (!a) return { error: "ANTHROPIC_API_KEY is not set" };
  if (!phrase.trim()) return { error: "describe the rule first" };

  try {
    const msg = await a.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: [
        { type: "text", text: SYSTEM },
        { type: "text", text: fieldsBlock() + "\n\n" + categoriesBlock(), cache_control: { type: "ephemeral", ttl: "1h" } },
      ],
      messages: [
        { role: "user", content: `Turn this into ONE rule: "${phrase.slice(0, 400)}". Return exactly one rule.` },
      ],
      output_config: { format: { type: "json_schema", schema: SCHEMA } },
    } as Anthropic.MessageCreateParamsNonStreaming);
    const block = msg.content.find((b) => b.type === "text");
    const parsed = (block && block.type === "text" ? JSON.parse(block.text) : {}) as { rules?: RawRule[] };
    const first = (parsed.rules ?? [])[0];
    const v = first ? validateRawRule(first) : null;
    if (!v) return { error: "could not draft a rule from that — try rephrasing" };
    // Flatten predicate back to rows for the builder.
    const { predicateToRows } = await import("@/lib/rules/build");
    const { rows } = predicateToRows(v.predicate);
    const key =
      v.action.kind === "categorize" && v.action.target.by === "canonical"
        ? v.action.target.key
        : null;
    return { draft: { rows, categoryKey: key, name: v.name, reasoning: v.reasoning } };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}
