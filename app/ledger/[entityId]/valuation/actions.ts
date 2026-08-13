"use server";

import { revalidatePath } from "next/cache";
import { assertEntityWrite, assertOwner, canAccessEntity } from "@/lib/ledger/access";
import { logAudit } from "@/lib/ledger/audit";
import { limitAction } from "@/lib/security/rate-limit";
import { actionIdentity } from "@/lib/security/rate-limit-identity";
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
import { str, dollarsToCents } from "@/lib/ledger/forms";

function revalidate(entityId: string) {
  revalidatePath(`/ledger/${entityId}/valuation`);
  revalidatePath(`/ledger/${entityId}`);
}

export async function saveMethod(formData: FormData) {
  const entityId = String(formData.get("entityId"));
  await assertEntityWrite(entityId);
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
  await logAudit({
    entityId,
    actionType: "set_valuation_method",
    objectTable: "bk_ledger_entities",
    objectId: entityId,
    description: `Set valuation method to "${method}"`,
    after: { method },
    affectedLedger: false,
  });
  revalidate(entityId);
}

export async function saveComponent(formData: FormData) {
  const entityId = String(formData.get("entityId"));
  await assertEntityWrite(entityId);
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
    // Optional starting value — lets a non-listing asset (vehicles, land, an
    // RV) be added with its worth in one step, no Zillow/Redfin needed.
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
  await logAudit({
    entityId,
    actionType: componentId ? "update_valuation_component" : "add_valuation_component",
    objectTable: "bk_valuation_components",
    objectId: componentId,
    description: `${componentId ? "Updated" : "Added"} a valuation component "${fields.label}"`,
    after: fields,
    affectedLedger: false,
  });
  revalidate(entityId);
}

export async function removeComponent(formData: FormData) {
  const entityId = String(formData.get("entityId"));
  await assertEntityWrite(entityId);
  const removedComponentId = String(formData.get("componentId"));
  await deleteComponent(entityId, removedComponentId);
  await logAudit({
    entityId,
    actionType: "remove_valuation_component",
    objectTable: "bk_valuation_components",
    objectId: removedComponentId,
    description: "Removed a valuation component",
    affectedLedger: false,
  });
  revalidate(entityId);
}

/** Manual comp value for a component. */
export async function saveManualEstimate(formData: FormData) {
  const entityId = String(formData.get("entityId"));
  await assertEntityWrite(entityId);
  const componentId = String(formData.get("componentId"));
  const cents = dollarsToCents(formData.get("value"));
  if (cents != null) {
    await setEstimate(entityId, componentId, "manual", cents, {
      asOf: str(formData.get("asOf")) ?? new Date().toISOString().slice(0, 10),
      reasoning: str(formData.get("note")),
    });
    await logAudit({
      entityId,
      actionType: "save_manual_estimate",
      objectTable: "bk_valuation_estimates",
      objectId: componentId,
      description: `Set a manual valuation estimate ($${(cents / 100).toLocaleString()})`,
      after: { valueCents: cents },
      affectedLedger: false,
    });
  }
  revalidate(entityId);
}

/** Run the AI estimate for a component from a few owner-entered facts.
 * OWNER-ONLY (AI spend); entity-scoping still asserted for the 404 semantics. */
export async function runAiEstimate(formData: FormData) {
  const entityId = String(formData.get("entityId"));
  await assertOwner();
  await assertEntityWrite(entityId);
  const rl = await limitAction("ai", await actionIdentity());
  if (rl) throw new Error(rl.error);
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
  await logAudit({
    entityId,
    actionType: "run_ai_estimate",
    objectTable: "bk_valuation_estimates",
    objectId: componentId,
    description: `Ran an AI valuation estimate ($${(ai.valueCents / 100).toLocaleString()})`,
    after: { valueCents: ai.valueCents },
    affectedLedger: false,
  });
  revalidate(entityId);
}
