"use server";

import { revalidatePath } from "next/cache";
import { assertEntityAccess, canAccessEntity } from "@/lib/ledger/access";
import { getCurrentUser } from "@/lib/supabase/auth-server";
import {
  updateValuation,
  addComponent,
  updateComponent,
  deleteComponent,
  setEstimate,
  setComponentFacts,
  setValuationMethod,
  getValuationComponents,
  type EstimateSource,
} from "@/lib/ledger/valuation";
import { estimateValueWithAi } from "@/lib/ledger/ai-valuation";
import type { ValuationMethod } from "@/lib/ledger/reports";

function str(v: FormDataEntryValue | null): string | null {
  const s = String(v ?? "").trim();
  return s.length ? s : null;
}
function dollarsToCents(v: FormDataEntryValue | null): number | null {
  const raw = String(v ?? "").replace(/[$,]/g, "").trim();
  if (!raw) return null;
  const n = parseFloat(raw);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}
function revalidate(entityId: string) {
  revalidatePath(`/ledger/${entityId}/valuation`);
  revalidatePath(`/ledger/${entityId}`);
}

export async function saveMethod(formData: FormData) {
  const entityId = String(formData.get("entityId"));
  await assertEntityAccess(entityId);
  const method = (String(formData.get("method")) || "income") as ValuationMethod;
  const pct = str(formData.get("ownershipPct"));
  const parentEntityId =
    method === "equity_stake" ? str(formData.get("parentEntityId")) : null;
  // The parent link makes this entity's value READ the parent's — so the caller
  // must be authorized for the parent too, or a member could point an entity
  // they control at one they can't see and read its valuation off the overview.
  if (parentEntityId) {
    const user = await getCurrentUser();
    if (!(await canAccessEntity(user?.email, parentEntityId))) {
      throw new Error("parent entity not found");
    }
  }
  await updateValuation(entityId, {
    method,
    parentEntityId,
    ownershipPct: method === "equity_stake" && pct ? parseFloat(pct) : null,
  });
  revalidate(entityId);
}

export async function saveComponent(formData: FormData) {
  const entityId = String(formData.get("entityId"));
  await assertEntityAccess(entityId);
  const componentId = str(formData.get("componentId"));
  const fields = {
    label: str(formData.get("label")) ?? "Property",
    address: str(formData.get("address")),
    zillowUrl: str(formData.get("zillowUrl")),
    redfinUrl: str(formData.get("redfinUrl")),
  };
  if (componentId) {
    await updateComponent(entityId, componentId, {
      ...fields,
      chosenSource: (str(formData.get("chosenSource")) as EstimateSource | null) ?? null,
    });
  } else {
    const newId = await addComponent(entityId, fields);
    // Optional starting value — lets a non-listing asset (a vehicle, land, etc.) be added with its worth in one step, no Zillow/Redfin needed.
    const cents = dollarsToCents(formData.get("value"));
    if (cents != null) {
      await setEstimate(entityId, newId, "manual", cents, {
        asOf: new Date().toISOString().slice(0, 10),
      });
    }
  }
  // A piece of value only exists on a market-valued entity. Adding/editing one
  // implies the method, so the owner doesn't have to also remember the separate
  // method save (forgetting it left the piece orphaned + the method reverting).
  await setValuationMethod(entityId, "market");
  revalidate(entityId);
}

export async function removeComponent(formData: FormData) {
  const entityId = String(formData.get("entityId"));
  await assertEntityAccess(entityId);
  await deleteComponent(entityId, String(formData.get("componentId")));
  revalidate(entityId);
}

/** Manual comp value for a component. */
export async function saveManualEstimate(formData: FormData) {
  const entityId = String(formData.get("entityId"));
  await assertEntityAccess(entityId);
  const componentId = String(formData.get("componentId"));
  const cents = dollarsToCents(formData.get("value"));
  if (cents != null) {
    await setEstimate(entityId, componentId, "manual", cents, {
      asOf: str(formData.get("asOf")) ?? new Date().toISOString().slice(0, 10),
      reasoning: str(formData.get("note")),
    });
  }
  revalidate(entityId);
}

/** Run the AI estimate for a component from a few owner-entered facts. */
export async function runAiEstimate(formData: FormData) {
  const entityId = String(formData.get("entityId"));
  await assertEntityAccess(entityId);
  const componentId = String(formData.get("componentId"));
  const address = str(formData.get("address"));
  if (!address) {
    revalidate(entityId);
    return;
  }
  const facts = {
    propertyType: str(formData.get("propertyType")),
    units: str(formData.get("units")),
    beds: str(formData.get("beds")),
    baths: str(formData.get("baths")),
    sqft: str(formData.get("sqft")),
    monthlyRent: str(formData.get("monthlyRent")),
    condition: str(formData.get("condition")),
    factsNote: str(formData.get("aiNotes")),
  };
  // Remember what the owner typed so the form prefills next time. (Address lives
  // on the component already; saveComponent owns it.) Entity-scoped: a foreign
  // componentId fails here before any AI spend.
  await setComponentFacts(entityId, componentId, facts);

  // Anchor the estimate on any Zillow/Redfin figures already pulled for this
  // structure — Claude adjusts from them rather than guessing in a vacuum.
  const comps = await getValuationComponents(entityId);
  const comp = comps.find((c) => c.id === componentId);
  const anchors = (comp?.estimates ?? [])
    .filter((e) => e.source === "zillow" || e.source === "redfin")
    .map((e) => ({ source: e.source, valueCents: e.valueCents }));

  const ai = await estimateValueWithAi({
    address,
    propertyType: facts.propertyType,
    units: facts.units,
    beds: facts.beds,
    baths: facts.baths,
    sqft: facts.sqft,
    monthlyRent: facts.monthlyRent,
    condition: facts.condition,
    notes: facts.factsNote,
    anchors,
  });
  await setEstimate(entityId, componentId, "ai", ai.valueCents, {
    asOf: new Date().toISOString().slice(0, 10),
    reasoning: ai.reasoning,
  });
  revalidate(entityId);
}
