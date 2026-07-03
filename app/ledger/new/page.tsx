import { assertEntityCreator } from "@/lib/ledger/access";
import { NewEntityForm } from "./new-entity-form";

export const dynamic = "force-dynamic";

/**
 * Entity creation is OWNER-ONLY (see assertEntityCreator — an identity check,
 * not a role check). This page guard 404s everyone else; the authoritative
 * check lives in the createEntity server action, so hiding the page is never
 * the only defense.
 */
export default async function NewEntityPage() {
  await assertEntityCreator();
  return <NewEntityForm />;
}
