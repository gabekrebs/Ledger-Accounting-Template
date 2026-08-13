import Anthropic from "@anthropic-ai/sdk";
import { inArray, desc } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import {
  listConnections,
  listAssignTargets,
  listBankLedgerAccounts,
  getBookedBankLinesForAccounts,
  daysBetween,
  BOOKED_NEAR_DAYS,
  type AssignTarget,
} from "@/lib/plaid/data";
import { usdPlain } from "@/lib/ledger/format";

/**
 * Opus 4.8 bank-account → (entity + ledger account) MATCHER.
 *
 * When a bank login is linked through Plaid, each account it returns starts
 * UNASSIGNED — a human normally has to figure out which business and which
 * ledger account every checking/credit-card line belongs to. This proposes
 * those mappings so the user just confirms one click each.
 *
 * The model reasons over every signal we have: the account name, the masked
 * last-four, type/subtype, the institution, a precomputed "this mask appears in
 * these ledger account names" hint (the strongest signal), and a sample of the
 * account's recent transactions (merchant names often reveal which property /
 * business — e.g. a mortgage servicer or a property's utilities).
 *
 * SAFETY: this only PRE-FILLS a suggestion the user confirms — nothing is
 * written here, and even a wrong suggestion is harmless because a person
 * approves each one. Still, every returned (entity_id, account_id) pair is
 * validated against the real catalog so a hallucinated id is dropped rather than
 * shown. On any failure it returns an empty list with an error string so the
 * screen silently degrades to manual assignment.
 *
 * Opus 4.8 notes (per claude-api skill): adaptive thinking is the right default
 * for this kind of multi-signal matching; sampling params are removed (omitted);
 * structured output via output_config.format guarantees schema-valid JSON. The
 * ledger catalog is a stable system prefix with cache_control so repeat runs are
 * cheap; the volatile per-account data lives in the user message after it.
 */

const { bkPlaidTransactions } = schema;

const MODEL = "claude-opus-4-8";

export interface MappingSuggestion {
  plaidAccountRowId: string; // bk_plaid_accounts.id
  plaidLabel: string; // e.g. "Chase ··0876 (checking)"
  entityId: string;
  entityName: string | null;
  accountId: string; // bk_accounts.id (the ledger bank/CC account)
  accountLabel: string;
  confidence: number; // 0..1
  reasoning: string; // one short human-readable sentence
}

export interface SuggestResult {
  suggestions: MappingSuggestion[];
  error: string | null;
}

// Structured-output constraints: object, all props required,
// additionalProperties:false, nullable via type arrays, no min/max/length.
const SUGGEST_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    suggestions: {
      type: "array",
      description:
        "One entry per Plaid account you can confidently place. Omit an " +
        "account entirely (or set entity_id and account_id to null) when no " +
        "ledger account is a clear fit — a missing suggestion is better than " +
        "a wrong one.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          plaid_account_id: {
            type: "string",
            description:
              "The plaid_account_id token of the account being matched, " +
              "copied verbatim from the list.",
          },
          entity_id: {
            type: ["string", "null"],
            description:
              "The entity_id of the business this account belongs to, copied " +
              "verbatim from the catalog. null if unsure.",
          },
          account_id: {
            type: ["string", "null"],
            description:
              "The account_id of the specific ledger bank/credit-card account " +
              "to map to, copied verbatim from the catalog. Must belong to the " +
              "chosen entity. null if unsure.",
          },
          confidence: {
            type: "number",
            description: "0.0–1.0 confidence in this mapping.",
          },
          reasoning: {
            type: "string",
            description:
              "One short sentence on why, citing the deciding signal " +
              "(e.g. 'last-four 0876 matches the Chase Checking 0876 ledger " +
              "account' or 'transactions to Roundpoint mortgage point to 1025').",
          },
        },
        required: [
          "plaid_account_id",
          "entity_id",
          "account_id",
          "confidence",
          "reasoning",
        ],
      },
    },
  },
  required: ["suggestions"],
} as const;

const SYSTEM_INSTRUCTIONS =
  "You match a real-world bank account (returned by Plaid for a linked bank " +
  "login) to the correct business (entity) AND the correct ledger account " +
  "within that business's books. You take NO action — you only produce " +
  "structured suggestions a person will confirm. Use every signal: the masked " +
  "last-four, the account name, type/subtype, the institution, and the sample " +
  "transactions (merchant names often reveal which property or business). The " +
  "single strongest signal is the last-four: if a ledger account's name " +
  "contains the same last-four, that is almost certainly the right account, and " +
  "it also tells you the entity (each ledger account belongs to exactly one " +
  "entity).\n\n" +
  "EVEN STRONGER, when present, is the BOOKED-HISTORY MATCH: for each account we " +
  "precompute which ledger accounts already have its recent transactions on their " +
  "books (same amount, same date, from the prior QBO/Wave import). A real bank " +
  "account's own transactions can only line up with the single ledger account " +
  "that IS that account — so a strong overlap (several matching txns) is decisive: " +
  "it both identifies the exact account AND the entity, beats a same-entity " +
  "sibling that lacks the overlap, and warrants HIGH confidence on its own.\n\n" +
  // --- Picking the TARGET account ---
  "TARGET ACCOUNT TYPE: a checking/savings/money-market (depository) Plaid " +
  "account must map to a BANK/CASH asset ledger account; a credit-card Plaid " +
  "account must map to a CREDIT-CARD liability ledger account. The catalog " +
  "lists EVERY asset and liability account (not just bank accounts) — it " +
  "includes property-named fixed-asset accounts (e.g. 'Buildings - Maple " +
  "Court', 'Building Improvements …'), loans, and the like. NEVER choose one " +
  "of those as account_id — they appear only to help you identify the right " +
  "ENTITY (see below). The account_id you return must be the entity's actual " +
  "bank/cash or credit-card account.\n\n" +
  // --- Bridging property name -> entity via sibling accounts ---
  "ENTITY BRIDGING: a Plaid account is often named for a property or address " +
  "(e.g. 'MAPLE COURT') while the matching bank ledger account is named " +
  "only for the bank (e.g. 'Checking - First Republic Bank'), so the names do " +
  "not string-match. In that case, find the ENTITY whose OTHER accounts " +
  "reference that same property/address (a 'Buildings - 1025 …' or loan named " +
  "for it), then map the Plaid account to THAT entity's bank/cash (or " +
  "credit-card) account. Two entities can each have a same-named bank account " +
  "(e.g. two 'First Republic Checking') — the property reference in the sibling " +
  "accounts, plus the sample transactions (a property's mortgage servicer, " +
  "utilities, HOA, or tenant deposits), tells you which entity owns this one.\n\n" +
  // --- Institution names lag M&A ---
  "INSTITUTION NAMES LAG ACQUISITIONS: the Plaid institution and the ledger " +
  "account's bank name can differ because of a bank merger and still be the " +
  "SAME account. JPMorgan Chase acquired First Republic in 2023, so a Plaid " +
  "institution of 'Chase' legitimately matches a ledger account named 'First " +
  "Republic'; likewise US Bank↔Union Bank, Bank of America↔Merrill, etc. Do NOT " +
  "lower confidence merely because the institution name differs when a known " +
  "acquisition explains it and the last-four / account name / transactions " +
  "agree — treat those other signals as decisive.\n\n" +
  // --- Institution RULES OUT other-bank accounts (multi-account disambiguation) ---
  "THE INSTITUTION ALSO RULES ACCOUNTS OUT — use it to disambiguate when an " +
  "entity has more than one bank account. Every account a Plaid login returns " +
  "comes from that ONE real institution, so a Chase-linked account can only be " +
  "the ledger bank account representing Chase — or a bank Chase absorbed (First " +
  "Republic, Washington Mutual). It CANNOT be a ledger account named for an " +
  "unrelated bank (e.g. 'US Bank - Checking', 'Wells Fargo …'): those only arrive " +
  "through THEIR OWN Plaid login, which has not been connected. So when the " +
  "entity is clear but has several bank accounts, ELIMINATE the ones whose bank " +
  "name belongs to a different institution than this Plaid login (allowing for " +
  "acquisitions). If exactly one bank account remains, you may be HIGHLY " +
  "confident even with no last-four in its name. Only stay low when two or more " +
  "accounts of the SAME institution remain and nothing (last-four, name, " +
  "transactions) separates them.\n\n" +
  // --- Hard rules + conservatism ---
  "ACCOUNT NAME = ENTITY NAME is a top signal: if the Plaid account's name " +
  "equals or closely matches a business's name (e.g. Plaid 'MAPLE COURT' ↔ " +
  "entity 'MAPLE COURT LLC', or 'RIVERSIDE DUPLEX' ↔ 'Riverside " +
  "Duplex'), that pins the ENTITY with high confidence on its own — then pick that " +
  "entity's bank/cash (or credit-card) account, even if no transactions are " +
  "synced yet and the bank account is named only for the bank.\n\n" +
  "Pick entity_id and account_id ONLY from the provided catalog and copy them " +
  "VERBATIM — never invent an id, and never pick an account_id that belongs to " +
  "a different entity than the entity_id you chose.\n\n" +
  "BE EXHAUSTIVE: work through EVERY Plaid account in the list and return a " +
  "suggestion for each one you can place. Do NOT skip an obvious match (an exact " +
  "last-four in a ledger account name, or an account name that matches an entity " +
  "name) because you spent effort on the harder accounts — the easy ones are the " +
  "most valuable to return. Conservatism governs CORRECTNESS only: set entity_id " +
  "and account_id to null when you genuinely cannot tell which business an " +
  "account belongs to, but never use it as a reason to leave an obvious match " +
  "out, and once the entity and bank account are clear do not hedge the " +
  "confidence over a cosmetic name/institution difference the rules above explain.";

let client: Anthropic | null = null;
function getClient(): Anthropic | null {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!client) client = new Anthropic();
  return client;
}

/** Recent transactions per Plaid account, capped per account (signal for the model). */
async function recentTxnsByAccount(
  plaidAccountIds: string[],
  perAccount = 12
): Promise<Map<string, { date: string; name: string; cents: number }[]>> {
  const map = new Map<string, { date: string; name: string; cents: number }[]>();
  if (!plaidAccountIds.length) return map;
  const rows = await db
    .select({
      plaidAccountId: bkPlaidTransactions.plaidAccountId,
      txnDate: bkPlaidTransactions.txnDate,
      name: bkPlaidTransactions.name,
      merchantName: bkPlaidTransactions.merchantName,
      amountCents: bkPlaidTransactions.amountCents,
    })
    .from(bkPlaidTransactions)
    .where(inArray(bkPlaidTransactions.plaidAccountId, plaidAccountIds))
    .orderBy(desc(bkPlaidTransactions.txnDate));
  for (const r of rows) {
    const arr = map.get(r.plaidAccountId) ?? [];
    if (arr.length >= perAccount) continue;
    arr.push({
      date: String(r.txnDate).slice(0, 10),
      name: r.merchantName ?? r.name ?? "(unknown)",
      cents: r.amountCents,
    });
    map.set(r.plaidAccountId, arr);
  }
  return map;
}

/** The ledger catalog the model picks from — stable bytes for the prompt cache. */
function catalogBlock(targets: AssignTarget[]): string {
  const withAccts = [...targets.filter((t) => t.accounts.length)].sort((a, b) =>
    a.entityId.localeCompare(b.entityId, "en")
  );
  const lines: string[] = [];
  for (const t of withAccts) {
    lines.push(`Entity: ${t.entityName ?? "(unnamed)"}  [entity_id: ${t.entityId}]`);
    for (const a of [...t.accounts].sort((x, y) =>
      x.id.localeCompare(y.id, "en")
    )) {
      lines.push(`  - ${a.label}  [account_id: ${a.id}]`);
    }
  }
  return (
    "BUSINESSES AND THEIR BANK / CREDIT-CARD LEDGER ACCOUNTS\n" +
    "(pick entity_id + account_id ONLY from this list, copied verbatim):\n\n" +
    lines.join("\n")
  );
}


type AcctToMatch = {
  rowId: string;
  plaidAccountId: string;
  institutionName: string | null;
  name: string | null;
  officialName: string | null;
  mask: string | null;
  type: string | null;
  subtype: string | null;
};

/** The volatile per-account block (institution, mask, mask-hits, sample txns). */
function plaidAccountsBlock(
  accounts: AcctToMatch[],
  txns: Map<string, { date: string; name: string; cents: number }[]>,
  targets: AssignTarget[],
  bookedHintByRow: Map<string, string>
): string {
  const blocks = accounts.map((a) => {
    const lines: string[] = [
      `[plaid_account_id: ${a.rowId}]`,
      `  Institution: ${a.institutionName ?? "(unknown)"}`,
      `  Name: ${a.name ?? "(none)"}`,
      `  Official name: ${a.officialName ?? "(none)"}`,
      `  Last four (mask): ${a.mask ?? "(none)"}`,
      `  Type / subtype: ${a.type ?? "?"} / ${a.subtype ?? "?"}`,
    ];

    // Strongest signal, precomputed: ledger accounts whose name contains the mask.
    if (a.mask) {
      const hits: string[] = [];
      for (const t of targets) {
        for (const acc of t.accounts) {
          if (acc.label.includes(a.mask)) {
            hits.push(
              `      • ${t.entityName ?? "?"} → ${acc.label} ` +
                `[entity_id: ${t.entityId}, account_id: ${acc.id}]`
            );
          }
        }
      }
      lines.push(
        hits.length
          ? `  Ledger accounts whose name contains "${a.mask}" (strong match):\n` +
              hits.join("\n")
          : `  No ledger account name contains "${a.mask}".`
      );
    }

    // Decisive signal, precomputed: ledger accounts whose ALREADY-BOOKED history
    // (from the QBO/Wave import) contains this account's recent transactions
    // (same |amount|, same date ±3d). A real account's own transactions can only
    // line up with the ledger account that IS that account.
    lines.push(bookedHintByRow.get(a.rowId) ?? "  Booked-history match: (none)");

    const t = txns.get(a.plaidAccountId) ?? [];
    if (t.length) {
      lines.push("  Recent transactions:");
      for (const x of t) lines.push(`      • ${x.date}  ${x.name}  ${usdPlain(x.cents)}`);
    } else {
      lines.push("  Recent transactions: (none synced yet)");
    }
    return lines.join("\n");
  });
  return "PLAID ACCOUNTS TO MATCH:\n\n" + blocks.join("\n\n");
}

interface RawSuggestion {
  plaid_account_id?: unknown;
  entity_id?: unknown;
  account_id?: unknown;
  confidence?: unknown;
  reasoning?: unknown;
}

/**
 * For each Plaid account, the ledger bank accounts whose IMPORTED history already
 * contains its recent transactions (same |amount|, date within the near window).
 * Returns rowId → a preformatted hint block (only accounts with ≥2 matching txns,
 * top 3 by match count) for `plaidAccountsBlock`. Cheap: booked lines are indexed
 * by amount, so each Plaid txn is an O(1) lookup + a small date scan.
 */
async function buildBookedHints(
  accounts: AcctToMatch[],
  txns: Map<string, { date: string; name: string; cents: number }[]>,
  targets: AssignTarget[]
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const bankAccts = await listBankLedgerAccounts();
  if (!bankAccts.length) return out;

  const booked = await getBookedBankLinesForAccounts(
    bankAccts.map((b) => b.accountId)
  );
  if (!booked.length) return out;

  const byCents = new Map<number, { accountId: string; txnDate: string }[]>();
  for (const l of booked) {
    const arr = byCents.get(l.cents);
    if (arr) arr.push({ accountId: l.accountId, txnDate: l.txnDate });
    else byCents.set(l.cents, [{ accountId: l.accountId, txnDate: l.txnDate }]);
  }

  const entityNameById = new Map(targets.map((t) => [t.entityId, t.entityName]));
  const acctMeta = new Map(
    bankAccts.map((b) => [b.accountId, { entityId: b.entityId, label: b.label }])
  );

  for (const acc of accounts) {
    const list = txns.get(acc.plaidAccountId) ?? [];
    if (!list.length) continue;
    // accountId → how many of this Plaid account's txns it has a booked match for.
    const counts = new Map<string, number>();
    for (const t of list) {
      const cands = byCents.get(Math.abs(t.cents)) ?? [];
      const hit = new Set<string>();
      for (const c of cands) {
        if (daysBetween(c.txnDate, t.date) <= BOOKED_NEAR_DAYS) hit.add(c.accountId);
      }
      for (const aid of hit) counts.set(aid, (counts.get(aid) ?? 0) + 1);
    }
    const ranked = [...counts.entries()]
      .filter(([, n]) => n >= 2)
      .sort((x, y) => y[1] - x[1])
      .slice(0, 3);
    if (!ranked.length) continue;

    const rows = ranked.map(([accountId, n]) => {
      const m = acctMeta.get(accountId);
      const ent = m ? entityNameById.get(m.entityId) ?? "?" : "?";
      return (
        `      • ${ent} → ${m?.label ?? "?"} ` +
        `[${n} of ${list.length} recent txns already booked here] ` +
        `[entity_id: ${m?.entityId}, account_id: ${accountId}]`
      );
    });
    out.set(
      acc.rowId,
      "  Booked-history match — ledger accounts already holding THIS account's " +
        "recent transactions (same amount + date; DECISIVE — this is that account):\n" +
        rows.join("\n")
    );
  }
  return out;
}

/**
 * Suggest entity + ledger-account mappings for every currently-UNASSIGNED Plaid
 * account. Returns [] (with a non-null error only for a real problem) when there
 * is nothing to do or the model is unavailable.
 */
export async function suggestAccountMappings(): Promise<SuggestResult> {
  const a = getClient();
  if (!a) {
    return {
      suggestions: [],
      error: "AI suggestions unavailable (ANTHROPIC_API_KEY is not set).",
    };
  }

  const [connections, targets] = await Promise.all([
    listConnections(),
    listAssignTargets(),
  ]);

  const accounts: AcctToMatch[] = connections
    .flatMap((c) =>
      c.accounts
        .filter((acc) => !acc.entityId) // unassigned only
        .map((acc) => ({
          rowId: acc.id,
          plaidAccountId: acc.plaidAccountId,
          institutionName: c.institutionName,
          name: acc.name,
          officialName: acc.officialName,
          mask: acc.mask,
          type: acc.type,
          subtype: acc.subtype,
        }))
    )
    .slice(0, 40); // defensive cap

  if (!accounts.length) return { suggestions: [], error: null };

  const targetsWithAccts = targets.filter((t) => t.accounts.length);
  if (!targetsWithAccts.length) {
    return {
      suggestions: [],
      error:
        "No bank or credit-card ledger accounts exist yet to map these to.",
    };
  }

  const ids = accounts.map((acc) => acc.plaidAccountId);
  // Two windows on purpose: the model only needs a SAMPLE of recent activity to
  // read merchant names, but the booked-history fingerprint must reach back to
  // where the Plaid feed and the QBO/Wave import OVERLAP — the import ends at the
  // cutover date, so the newest Plaid txns post-date it and never match. Pull a
  // deep set for matching; show the model the recent slice.
  const txnsDeep = await recentTxnsByAccount(ids, 400);
  const txns = new Map(
    [...txnsDeep].map(([k, v]) => [k, v.slice(0, 12)])
  );

  // Booked-history fingerprint: for each unassigned account, find ledger bank
  // accounts whose imported (QBO/Wave) history already contains its transactions
  // (same |amount|, date ±BOOKED_NEAR_DAYS). A real account's own transactions
  // can only line up with the ONE ledger account that IS it, so a strong overlap
  // both names the account and rules out same-entity siblings.
  const bookedHintByRow = await buildBookedHints(accounts, txnsDeep, targets);

  let parsed: { suggestions?: RawSuggestion[] };
  try {
    const msg = await a.messages.create({
      model: MODEL,
      // Room for adaptive thinking PLUS a suggestion per account: at ~40 accounts
      // a tight cap starved the JSON and the model returned only a few matches.
      max_tokens: 16384,
      thinking: { type: "adaptive" },
      system: [
        { type: "text", text: SYSTEM_INSTRUCTIONS },
        {
          type: "text",
          text: catalogBlock(targets),
          cache_control: { type: "ephemeral", ttl: "1h" },
        },
      ],
      messages: [
        {
          role: "user",
          content:
            plaidAccountsBlock(accounts, txns, targets, bookedHintByRow) +
            "\n\nMatch each Plaid account to a business and ledger account.",
        },
      ],
      output_config: {
        effort: "medium",
        format: { type: "json_schema", schema: SUGGEST_SCHEMA },
      },
    } as Anthropic.MessageCreateParamsNonStreaming);

    if (msg.stop_reason === "refusal") {
      return { suggestions: [], error: "The model declined to respond." };
    }
    const textBlock = msg.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      return { suggestions: [], error: "No suggestion returned." };
    }
    parsed = JSON.parse(textBlock.text) as { suggestions?: RawSuggestion[] };

    const u = msg.usage;
    console.log(
      `plaid/suggest: accounts=${accounts.length} ` +
        `returned=${parsed.suggestions?.length ?? 0} ` +
        `cache_read=${u.cache_read_input_tokens ?? 0} in=${u.input_tokens} ` +
        `out=${u.output_tokens}`
    );
  } catch (e) {
    console.error("plaid/suggest: model call threw:", e);
    return { suggestions: [], error: "AI matching failed — assign manually." };
  }

  // Validate against the real catalog: drop hallucinated ids and cross-entity
  // pairs, dedupe by plaid account, keep the asked accounts only.
  const validPairs = new Set<string>();
  const entityNameById = new Map<string, string | null>();
  const accountLabelById = new Map<string, string>();
  for (const t of targets) {
    entityNameById.set(t.entityId, t.entityName);
    for (const acc of t.accounts) {
      validPairs.add(`${t.entityId}:${acc.id}`);
      accountLabelById.set(acc.id, acc.label);
    }
  }
  const plaidLabelById = new Map(
    accounts.map((acc) => [
      acc.rowId,
      `${acc.institutionName ?? "Bank"} ··${acc.mask ?? "????"} (${
        acc.subtype ?? acc.type ?? "account"
      })`,
    ])
  );
  const askedRowIds = new Set(accounts.map((acc) => acc.rowId));

  const seen = new Set<string>();
  const suggestions: MappingSuggestion[] = [];
  for (const r of parsed.suggestions ?? []) {
    const rowId = typeof r.plaid_account_id === "string" ? r.plaid_account_id : "";
    const entityId = typeof r.entity_id === "string" ? r.entity_id : "";
    const accountId = typeof r.account_id === "string" ? r.account_id : "";
    if (!rowId || !entityId || !accountId) continue;
    if (!askedRowIds.has(rowId) || seen.has(rowId)) continue;
    if (!validPairs.has(`${entityId}:${accountId}`)) continue;
    seen.add(rowId);
    suggestions.push({
      plaidAccountRowId: rowId,
      plaidLabel: plaidLabelById.get(rowId) ?? "Account",
      entityId,
      entityName: entityNameById.get(entityId) ?? null,
      accountId,
      accountLabel: accountLabelById.get(accountId) ?? "",
      confidence:
        typeof r.confidence === "number"
          ? Math.min(1, Math.max(0, r.confidence))
          : 0,
      reasoning:
        typeof r.reasoning === "string" ? r.reasoning.slice(0, 400) : "",
    });
  }

  // Highest-confidence first.
  suggestions.sort((x, y) => y.confidence - x.confidence);
  return { suggestions, error: null };
}
