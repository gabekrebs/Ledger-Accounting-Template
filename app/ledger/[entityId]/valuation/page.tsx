import { notFound } from "next/navigation";
import { currentUserEntityAccessLevel } from "@/lib/ledger/access";
import { getEntity, listEntities } from "@/lib/ledger/reports";
import { getValuationComponents, sumComponents } from "@/lib/ledger/valuation";
import { Section } from "../section";
import { ValuationForm } from "./valuation-form";

export const dynamic = "force-dynamic";

export default async function ValuationPage({
  params,
}: {
  params: Promise<{ entityId: string }>;
}) {
  const { entityId } = await params;
  const [entity, components, entities, accessLevel] = await Promise.all([
    getEntity(entityId),
    getValuationComponents(entityId),
    listEntities(),
    currentUserEntityAccessLevel(entityId),
  ]);
  if (!entity) notFound();
  const readOnly = accessLevel !== "write";

  return (
    <div className="space-y-8">
      <Section
        title="Valuation methodology"
        description={
          readOnly
            ? "How this entity's value — and the appreciation shown on the Overview — is figured."
            : "This sets how the entity's value — and the appreciation shown on the Overview — is figured. Pick the one that fits, and it saves as you go."
        }
      >
        {readOnly ? (
          <p className="text-sm text-muted-foreground">
            Method: <span className="font-medium">{entity.valuationMethod ?? "none"}</span>
            {entity.parentEntityId &&
              entity.ownershipPct != null &&
              ` · ${entity.ownershipPct}% of parent entity`}
          </p>
        ) : (
        <ValuationForm
          entityId={entityId}
          method={entity.valuationMethod}
          parentEntityId={entity.parentEntityId}
          ownershipPct={entity.ownershipPct}
          entities={entities.map((e) => ({ id: e.id, name: e.name ?? e.legalName ?? e.id }))}
          components={components}
          marketValueCents={sumComponents(components)}
        />
        )}
      </Section>
    </div>
  );
}
