import { and, eq, asc, inArray } from "drizzle-orm";
import { db } from "@/lib/db/client";
import {
  bkLedgerEntities,
  bkValuationComponents,
  bkValuationEstimates,
} from "@/lib/db/schema";
import type { ValuationMethod } from "./reports";
import type {
  ComponentFacts,
  EstimateSource,
  ValuationComponent,
  ValuationEstimate,
} from "./valuation-shared";

// Re-export the pure types/helpers so server callers can import everything from
// one place; client components must import them from `valuation-shared` directly.
export type { ComponentFacts, EstimateSource, ValuationComponent, ValuationEstimate };
export {
  chosenEstimate,
  componentChosenCents,
  sumComponents,
} from "./valuation-shared";

/** All valuation components (with their estimates) for an entity, ordered. */
export async function getValuationComponents(
  entityId: string
): Promise<ValuationComponent[]> {
  const comps = await db
    .select()
    .from(bkValuationComponents)
    .where(eq(bkValuationComponents.entityId, entityId))
    .orderBy(asc(bkValuationComponents.sortOrder));
  if (!comps.length) return [];
  const ests = await db
    .select()
    .from(bkValuationEstimates)
    .where(inArray(bkValuationEstimates.componentId, comps.map((c) => c.id)));
  const byComp = new Map<string, ValuationEstimate[]>();
  for (const e of ests) {
    const arr = byComp.get(e.componentId) ?? [];
    arr.push({
      id: e.id,
      source: e.source as EstimateSource,
      valueCents: e.valueCents,
      asOf: e.asOf,
      url: e.url,
      reasoning: e.reasoning,
    });
    byComp.set(e.componentId, arr);
  }
  return comps.map((c) => ({
    id: c.id,
    label: c.label,
    address: c.address,
    zillowUrl: c.zillowUrl,
    redfinUrl: c.redfinUrl,
    chosenSource: (c.chosenSource as EstimateSource | null) ?? null,
    propertyType: c.propertyType,
    units: c.units,
    beds: c.beds,
    baths: c.baths,
    sqft: c.sqft,
    monthlyRent: c.monthlyRent,
    condition: c.condition,
    factsNote: c.factsNote,
    estimates: byComp.get(c.id) ?? [],
  }));
}

// ── mutations ────────────────────────────────────────────────────────────────
//
// Every ID-based mutation is scoped by BOTH the resource id AND the entity the
// caller was authorized for (actions assert entity access, then pass entityId
// here). A componentId/estimateId belonging to another entity behaves exactly
// like one that doesn't exist — same generic error — so a probing caller can't
// distinguish "foreign" from "missing".

/** Uniform error for missing/foreign/malformed resource ids — never leaks which. */
function componentNotFound(): never {
  throw new Error("valuation component not found");
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The component row iff it belongs to `entityId`; generic throw otherwise. */
async function requireComponent(entityId: string, componentId: string): Promise<void> {
  if (!UUID_RE.test(componentId)) componentNotFound(); // malformed id ≙ not found (no pg cast error)
  const rows = await db
    .select({ id: bkValuationComponents.id })
    .from(bkValuationComponents)
    .where(
      and(
        eq(bkValuationComponents.id, componentId),
        eq(bkValuationComponents.entityId, entityId)
      )
    )
    .limit(1);
  if (!rows.length) componentNotFound();
}

export interface ValuationInput {
  method: ValuationMethod;
  parentEntityId: string | null;
  ownershipPct: number | null;
}

/** Persist an entity's valuation method + equity-stake link. */
export async function updateValuation(
  entityId: string,
  input: ValuationInput
): Promise<void> {
  await db
    .update(bkLedgerEntities)
    .set({
      valuationMethod: input.method,
      parentEntityId: input.parentEntityId,
      ownershipPct: input.ownershipPct == null ? null : String(input.ownershipPct),
    })
    .where(eq(bkLedgerEntities.id, entityId));
}

/**
 * Set ONLY the valuation method column (leaves parent/ownership untouched).
 * Used as a backstop so adding a market structure implies the entity is
 * market-valued — otherwise the method radio is a separate save the owner can
 * forget, leaving the structure orphaned and the method reverting on reload.
 */
export async function setValuationMethod(
  entityId: string,
  method: ValuationMethod
): Promise<void> {
  await db
    .update(bkLedgerEntities)
    .set({ valuationMethod: method })
    .where(eq(bkLedgerEntities.id, entityId));
}

export async function addComponent(
  entityId: string,
  input: { label: string; address: string | null; zillowUrl: string | null; redfinUrl: string | null }
): Promise<string> {
  const existing = await db
    .select({ id: bkValuationComponents.id })
    .from(bkValuationComponents)
    .where(eq(bkValuationComponents.entityId, entityId));
  const [row] = await db
    .insert(bkValuationComponents)
    .values({
      entityId,
      label: input.label,
      address: input.address,
      zillowUrl: input.zillowUrl,
      redfinUrl: input.redfinUrl,
      sortOrder: existing.length,
    })
    .returning({ id: bkValuationComponents.id });
  return row.id;
}

export async function updateComponent(
  entityId: string,
  componentId: string,
  input: {
    label: string;
    address: string | null;
    zillowUrl: string | null;
    redfinUrl: string | null;
    chosenSource: EstimateSource | null;
  }
): Promise<void> {
  if (!UUID_RE.test(componentId)) componentNotFound();
  const updated = await db
    .update(bkValuationComponents)
    .set(input)
    .where(
      and(
        eq(bkValuationComponents.id, componentId),
        eq(bkValuationComponents.entityId, entityId)
      )
    )
    .returning({ id: bkValuationComponents.id });
  if (!updated.length) componentNotFound();
}

export async function deleteComponent(
  entityId: string,
  componentId: string
): Promise<void> {
  if (!UUID_RE.test(componentId)) componentNotFound();
  const deleted = await db
    .delete(bkValuationComponents)
    .where(
      and(
        eq(bkValuationComponents.id, componentId),
        eq(bkValuationComponents.entityId, entityId)
      )
    )
    .returning({ id: bkValuationComponents.id });
  if (!deleted.length) componentNotFound();
}

/** Upsert one source's estimate for a component (re-pull replaces the row). */
export async function setEstimate(
  entityId: string,
  componentId: string,
  source: EstimateSource,
  valueCents: number,
  opts: { asOf?: string | null; url?: string | null; reasoning?: string | null } = {}
): Promise<void> {
  await requireComponent(entityId, componentId); // components never change entity, so check-then-write is safe
  await db
    .insert(bkValuationEstimates)
    .values({
      componentId,
      source,
      valueCents,
      asOf: opts.asOf ?? null,
      url: opts.url ?? null,
      reasoning: opts.reasoning ?? null,
    })
    .onConflictDoUpdate({
      target: [bkValuationEstimates.componentId, bkValuationEstimates.source],
      set: {
        valueCents,
        asOf: opts.asOf ?? null,
        url: opts.url ?? null,
        reasoning: opts.reasoning ?? null,
        updatedAt: new Date(),
      },
    });
}

/**
 * Persist a component's property facts (the ones that feed the AI prompt). Used
 * when the owner runs an AI estimate so the facts they typed are remembered and
 * the form prefills next time. Writes every field — pass the full set.
 */
export async function setComponentFacts(
  entityId: string,
  componentId: string,
  facts: ComponentFacts
): Promise<void> {
  if (!UUID_RE.test(componentId)) componentNotFound();
  const updated = await db
    .update(bkValuationComponents)
    .set(facts)
    .where(
      and(
        eq(bkValuationComponents.id, componentId),
        eq(bkValuationComponents.entityId, entityId)
      )
    )
    .returning({ id: bkValuationComponents.id });
  if (!updated.length) componentNotFound();
}
