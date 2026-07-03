import Anthropic from "@anthropic-ai/sdk";

/**
 * AI-assisted market value — for properties where Zillow/Redfin AVMs are
 * unreliable (e.g. a new-build townhome with a studio ADU). The owner fills a
 * few facts; Claude reasons to an estimate AND returns its rationale, which we
 * store as one more estimate source (provenance is first-class). It does NOT
 * browse the live web — it reasons from the facts given plus any AVM anchors we
 * pass in, so the more accurate the inputs, the better the estimate.
 */
const MODEL = "claude-opus-4-8";

export interface AiValuationInput {
  address: string;
  propertyType?: string | null; // "single-family", "duplex", "townhome + ADU", …
  beds?: string | null;
  baths?: string | null;
  sqft?: string | null;
  units?: string | null; // e.g. "2 (3BR up + studio ADU)"
  monthlyRent?: string | null; // gross monthly rent across units, if known
  condition?: string | null; // "renovated 2024", "original", …
  notes?: string | null; // comps the owner knows, recent sales, quirks
  anchors?: { source: string; valueCents: number }[]; // Zillow/Redfin AVMs, if any
}

export interface AiValuationResult {
  valueCents: number;
  lowCents: number;
  highCents: number;
  reasoning: string; // 2–4 sentences the owner can read
}

const SYSTEM =
  "You are a residential real-estate appraiser estimating the current MARKET " +
  "VALUE (what it would sell for today) of a specific property from the facts " +
  "provided. Weigh location, size, unit mix, condition, rents, and any AVM " +
  "anchors. If anchors are given but the facts suggest they're off (e.g. an AVM " +
  "ignores an income-producing ADU), say so and adjust. Give a point estimate " +
  "plus a low–high range and a short, concrete rationale. Estimate in US dollars.";

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["value", "low", "high", "reasoning"],
  properties: {
    value: { type: "number", description: "point estimate of market value, USD" },
    low: { type: "number", description: "low end of a reasonable range, USD" },
    high: { type: "number", description: "high end of a reasonable range, USD" },
    reasoning: { type: "string", description: "2–4 sentences: the basis for the estimate" },
  },
} as const;

let client: Anthropic | null = null;
function getClient(): Anthropic | null {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!client) client = new Anthropic();
  return client;
}

export async function estimateValueWithAi(
  input: AiValuationInput
): Promise<AiValuationResult> {
  const a = getClient();
  if (!a) throw new Error("AI estimate needs ANTHROPIC_API_KEY.");

  const facts = [
    `Address: ${input.address}`,
    input.propertyType && `Type: ${input.propertyType}`,
    input.units && `Units: ${input.units}`,
    input.beds && `Beds: ${input.beds}`,
    input.baths && `Baths: ${input.baths}`,
    input.sqft && `Living area (sqft): ${input.sqft}`,
    input.monthlyRent && `Gross monthly rent: ${input.monthlyRent}`,
    input.condition && `Condition: ${input.condition}`,
    input.notes && `Owner notes / known comps: ${input.notes}`,
    input.anchors?.length &&
      `AVM anchors: ${input.anchors
        .map((x) => `${x.source} $${Math.round(x.valueCents / 100).toLocaleString()}`)
        .join(", ")}`,
  ]
    .filter(Boolean)
    .join("\n");

  const msg = await a.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: SYSTEM,
    messages: [{ role: "user", content: `Property facts:\n${facts}\n\nEstimate the market value.` }],
    output_config: {
      effort: "medium",
      format: { type: "json_schema", schema: SCHEMA },
    },
  } as Anthropic.MessageCreateParamsNonStreaming);

  if (msg.stop_reason === "refusal") throw new Error("AI declined to estimate.");
  const block = msg.content.find((b) => b.type === "text");
  if (!block || block.type !== "text") throw new Error("AI returned no estimate.");
  const j = JSON.parse(block.text) as { value: number; low: number; high: number; reasoning: string };
  return {
    valueCents: Math.round(j.value * 100),
    lowCents: Math.round(j.low * 100),
    highCents: Math.round(j.high * 100),
    reasoning: j.reasoning,
  };
}
