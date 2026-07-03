"use server";

import { redirect } from "next/navigation";
import { db, schema } from "@/lib/db/client";
import { assertEntityCreator } from "@/lib/ledger/access";

const { bkLedgerEntities } = schema;

export async function createEntity(formData: FormData) {
  // AUTHORITATIVE guard: only the owner may create entities, verified against
  // the server-side session email — never client input. Admin/all-entity
  // access does not qualify. (The page guard is just UX; this is the check.)
  await assertEntityCreator();

  const name = String(formData.get("name") ?? "").trim();
  if (!name) throw new Error("Entity name is required");

  const legalName = String(formData.get("legalName") ?? "").trim() || name;
  const taxType = String(formData.get("taxType") ?? "partnership").trim();
  const valuationMethod = String(formData.get("valuationMethod") ?? "income").trim();

  // Partners: submitted as partner_name_0, partner_pct_0, partner_name_1, ...
  const owners: { name: string; pct: number }[] = [];
  for (let i = 0; ; i++) {
    const pName = String(formData.get(`partner_name_${i}`) ?? "").trim();
    const pPct = parseFloat(String(formData.get(`partner_pct_${i}`) ?? ""));
    if (!pName) break;
    if (pName && Number.isFinite(pPct) && pPct > 0) owners.push({ name: pName, pct: pPct });
  }

  // Use a synthetic wave-style realm id — no QBO connection.
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const realmId = `user:${slug}-${Date.now()}`;

  const [entity] = await db
    .insert(bkLedgerEntities)
    .values({
      realmId,
      name,
      legalName,
      taxType,
      valuationMethod: valuationMethod as "income" | "market" | "none",
      owners: owners.length ? owners : null,
    })
    .returning({ id: bkLedgerEntities.id });

  redirect(`/ledger/${entity.id}`);
}
