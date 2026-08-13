import Anthropic from "@anthropic-ai/sdk";
import { eq, inArray, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";

/**
 * Merchant intelligence (ADR-021) — one web-enriched profile per normalized
 * merchant key, shared across every entity. First time the portfolio sees an
 * unknown merchant, the daily cron does ONE web lookup ("what is NW NATURAL?")
 * and caches business type + likely category concept; every later transaction
 * anywhere reuses it. Assistive context for the AI categorizer, never
 * authoritative — the decision order stays rules → history → similar txns →
 * intel → model reasoning.
 *
 * Privacy: only the merchant NAME leaves the system — never amounts, dates,
 * account numbers, or entity names.
 */

const { bkMerchantIntel, bkPlaidTransactions } = schema;

const MODEL = "claude-opus-4-8";
/** lookups per cron run — enough to drain a normal week in one pass */
const ENRICH_PER_RUN = 8;

let client: Anthropic | null = null;
function getClient(): Anthropic | null {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!client) client = new Anthropic();
  return client;
}

export interface MerchantIntel {
  merchantKey: string;
  displayName: string | null;
  businessType: string | null;
  likelyCategory: string | null;
  notes: string | null;
  ownerCategory: string | null;
  confidence: number | null;
}

/** Intel rows for a set of merchant keys — the prompt-builder's lookup. */
export async function readIntel(
  merchantKeys: string[]
): Promise<Map<string, MerchantIntel>> {
  const uniq = [...new Set(merchantKeys.filter((k) => k && k.length >= 3))];
  if (!uniq.length) return new Map();
  const rows = await db
    .select()
    .from(bkMerchantIntel)
    .where(inArray(bkMerchantIntel.merchantKey, uniq));
  return new Map(
    rows.map((r) => [
      r.merchantKey,
      {
        merchantKey: r.merchantKey,
        displayName: r.displayName,
        businessType: r.businessType,
        likelyCategory: r.likelyCategory,
        notes: r.notes,
        ownerCategory: r.ownerCategory,
        confidence: r.confidence,
      },
    ])
  );
}

/**
 * Note what the owner actually books this merchant to — the profile converges
 * on his reality, not the internet's. Called from the outcome recorder.
 */
export async function annotateOwnerCategory(
  merchantKey: string,
  categoryLabel: string
): Promise<void> {
  if (!merchantKey || merchantKey.length < 3) return;
  await db
    .update(bkMerchantIntel)
    .set({ ownerCategory: categoryLabel, updatedAt: new Date() })
    .where(eq(bkMerchantIntel.merchantKey, merchantKey));
}

interface RawProfile {
  identifiable?: unknown;
  display_name?: unknown;
  business_type?: unknown;
  likely_category?: unknown;
  notes?: unknown;
  confidence?: unknown;
}

const str = (v: unknown, max = 200): string | null =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;

/** Parse the model's JSON-only reply, tolerating code fences. */
function parseProfile(text: string): RawProfile | null {
  const cleaned = text.replace(/```(?:json)?/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1)) as RawProfile;
  } catch {
    return null;
  }
}

/**
 * One web-enabled lookup for a single merchant. Writes a row even when the
 * merchant can't be identified (source='model', low confidence) so the cron
 * doesn't retry the same cryptic descriptor forever.
 */
async function enrichOne(
  a: Anthropic,
  merchantKey: string,
  sampleRaw: string
): Promise<void> {
  const msg = await a.messages.create({
    model: MODEL,
    max_tokens: 4000,
    thinking: { type: "adaptive" },
    tools: [
      {
        type: "web_search_20260209",
        name: "web_search",
        max_uses: 3,
      } as Anthropic.Messages.ToolUnion,
    ],
    system:
      "You identify merchants from bank-statement descriptors for a US real-estate " +
      "bookkeeping system (short-term-rental LLCs in Oregon, plus normal household " +
      "vendors). Search the web when the name is not obviously identifiable. " +
      "Reply with ONLY a JSON object — no prose — shaped exactly:\n" +
      '{"identifiable": true|false, "display_name": "...", "business_type": "...", ' +
      '"likely_category": "...", "notes": "...", "confidence": 0.0-1.0}\n' +
      "likely_category is a generic bookkeeping concept (e.g. Utilities, Repairs & " +
      "Maintenance, Insurance, Property Tax, Supplies, Software, Cleaning, " +
      "Landscaping, Mortgage/Loan Payment, HOA Dues, Rental Income) — NOT an " +
      "account id. Keep notes to one sentence. If unidentifiable, say so with " +
      "identifiable=false and low confidence.",
    messages: [
      {
        role: "user",
        content: `Merchant descriptor from a bank feed: "${sampleRaw}" (normalized: "${merchantKey}"). What is this business?`,
      },
    ],
  });

  const textBlock = [...msg.content]
    .reverse()
    .find((b) => b.type === "text" && b.text.trim());
  const profile =
    textBlock && textBlock.type === "text" ? parseProfile(textBlock.text) : null;

  const usedWeb = msg.content.some((b) => b.type === "server_tool_use");
  await db
    .insert(bkMerchantIntel)
    .values({
      merchantKey,
      displayName: str(profile?.display_name, 120),
      businessType: str(profile?.business_type, 120),
      likelyCategory: str(profile?.likely_category, 120),
      notes: str(profile?.notes, 400),
      source: usedWeb ? "web" : "model",
      confidence:
        typeof profile?.confidence === "number"
          ? Math.min(1, Math.max(0, profile.confidence))
          : profile?.identifiable === false
            ? 0
            : null,
      sampleRaw: sampleRaw.slice(0, 200),
      updatedAt: new Date(),
    })
    .onConflictDoNothing({ target: bkMerchantIntel.merchantKey });
}

export interface EnrichResult {
  looked: number;
  remaining: number;
}

/**
 * Cron entry point: find merchants pending review anywhere in the portfolio
 * with no intel row yet, look up a capped batch, cache the profiles.
 */
export async function enrichUnknownMerchants(
  limit = ENRICH_PER_RUN
): Promise<EnrichResult> {
  const a = getClient();
  if (!a) return { looked: 0, remaining: 0 };

  // Distinct unknown merchants among pending rows (portfolio-wide), using the
  // same normalization the suggestion pipeline keys on. Done in SQL-lite
  // fashion: pull the raw names, normalize in JS (normalizeMerchant is a TS
  // function), dedupe, subtract known keys.
  const rows = await db
    .select({
      merchantName: bkPlaidTransactions.merchantName,
      name: bkPlaidTransactions.name,
    })
    .from(bkPlaidTransactions)
    .where(sql`${bkPlaidTransactions.status} = 'pending_review'`)
    .limit(2000);

  const { normalizeMerchant } = await import("@/lib/ledger/merchant");
  const bestRawByKey = new Map<string, string>();
  for (const r of rows) {
    const raw = r.merchantName ?? r.name ?? "";
    const key = normalizeMerchant(raw);
    if (key.length < 3) continue;
    if (!bestRawByKey.has(key)) bestRawByKey.set(key, raw);
  }
  if (!bestRawByKey.size) return { looked: 0, remaining: 0 };

  const known = await db
    .select({ merchantKey: bkMerchantIntel.merchantKey })
    .from(bkMerchantIntel)
    .where(inArray(bkMerchantIntel.merchantKey, [...bestRawByKey.keys()]));
  for (const k of known) bestRawByKey.delete(k.merchantKey);

  const unknown = [...bestRawByKey.entries()];
  let looked = 0;
  for (const [key, raw] of unknown.slice(0, limit)) {
    try {
      await enrichOne(a, key, raw);
      looked++;
    } catch (e) {
      console.error(`merchant-intel: lookup failed for "${key}":`, e);
    }
  }
  const remaining = Math.max(0, unknown.length - looked);
  if (looked)
    console.log(`merchant-intel: enriched ${looked}, remaining ${remaining}`);
  return { looked, remaining };
}
