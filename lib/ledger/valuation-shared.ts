/**
 * Pure valuation types + value resolution — NO database imports, so this is safe
 * to import from client components (the Valuation tab) as well as the server.
 * The DB read/write functions live in `valuation.ts` (server-only).
 */
export type EstimateSource = "zillow" | "redfin" | "ai" | "manual";

// Tie-break order when two sources show the same figure: a manual comp
// (someone looked) beats an AVM, AVMs beat an AI guess.
const SOURCE_PRIORITY: EstimateSource[] = ["manual", "zillow", "redfin", "ai"];

export interface ValuationEstimate {
  id: string;
  source: EstimateSource;
  valueCents: number;
  asOf: string | null;
  url: string | null;
  reasoning: string | null;
}

/**
 * Property facts that feed the AI estimate prompt. The scraper fills the public
 * ones (propertyType/beds/baths/sqft); the owner provides units/rent/condition/
 * note. All optional — a blank just means "not known yet".
 */
export interface ComponentFacts {
  propertyType: string | null;
  units: string | null;
  beds: string | null;
  baths: string | null;
  sqft: string | null;
  monthlyRent: string | null;
  condition: string | null;
  factsNote: string | null;
}

export interface ValuationComponent extends ComponentFacts {
  id: string;
  label: string;
  address: string | null;
  zillowUrl: string | null;
  redfinUrl: string | null;
  chosenSource: EstimateSource | null;
  estimates: ValuationEstimate[];
}

/** The estimate that should be the headline for a component (chosen → fallback). */
export function chosenEstimate(c: ValuationComponent): ValuationEstimate | null {
  if (!c.estimates.length) return null;
  if (c.chosenSource) {
    const hit = c.estimates.find((e) => e.source === c.chosenSource);
    if (hit) return hit;
  }
  // No explicit pick → "best available" = the HIGHEST current figure (that is
  // what "best" means to an owner). Ties break by source quality: a manual
  // comp (someone looked) → Zillow → Redfin → AI.
  return [...c.estimates].sort(
    (a, b) =>
      b.valueCents - a.valueCents ||
      SOURCE_PRIORITY.indexOf(a.source) - SOURCE_PRIORITY.indexOf(b.source)
  )[0];
}

export function componentChosenCents(c: ValuationComponent): number {
  return chosenEstimate(c)?.valueCents ?? 0;
}

/** Entity market value = Σ each component's chosen estimate. */
export function sumComponents(components: ValuationComponent[]): number {
  return components.reduce((s, c) => s + componentChosenCents(c), 0);
}
