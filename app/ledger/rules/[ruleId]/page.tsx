import Link from "next/link";
import { notFound } from "next/navigation";
import { assertAdmin } from "@/lib/ledger/access";
import { getRule, recentEventsForRule } from "@/lib/rules/store";
import { listEntities } from "@/lib/ledger/reports";
import { CANONICAL } from "@/lib/ledger/canonical-accounts";
import { RuleForm } from "../../[entityId]/rules/rule-form";
import { saveGlobalRule, previewGlobalRule } from "../actions";

export const dynamic = "force-dynamic";

const canonicalOptions = CANONICAL.map((d) => ({ key: d.key, label: d.label }));

export default async function EditGlobalRulePage({
  params,
}: {
  params: Promise<{ ruleId: string }>;
}) {
  await assertAdmin();
  const { ruleId } = await params;
  const rule = await getRule(ruleId);
  if (!rule || rule.scope !== "global") notFound();
  const [entities, events] = await Promise.all([listEntities(), recentEventsForRule(ruleId)]);

  return (
    <main className="flex-1 px-6 py-8">
      <div className="mx-auto w-full max-w-page space-y-10">
        <div>
          <Link href="/ledger/rules" className="text-sm text-faint hover:text-muted-foreground">
            ← Global rules
          </Link>
          <h1 className="mt-1 font-serif text-3xl font-medium tracking-tight">Edit — {rule.name}</h1>
        </div>

        <RuleForm
          scope="global"
          canonicalOptions={canonicalOptions}
          accountOptions={[]}
          previewEntities={entities.map((e) => ({ id: e.id, name: e.name ?? "(unnamed)" }))}
          rule={{
            id: rule.id,
            scope: "global",
            name: rule.name,
            description: rule.description,
            enabled: rule.enabled,
            autoApply: rule.autoApply,
            rank: rule.rank,
            predicate: rule.predicate,
            action: rule.action,
          }}
          save={saveGlobalRule}
          preview={previewGlobalRule}
          redirectTo="/ledger/rules"
        />

        <section className="space-y-2">
          <h2 className="font-serif text-lg font-medium">Recent decisions</h2>
          {events.length === 0 ? (
            <p className="text-sm text-muted-foreground">No decisions logged yet.</p>
          ) : (
            <ul className="text-sm text-muted-foreground">
              {events.map((e) => (
                <li key={e.id} className="border-b border-hair/60 py-1.5">
                  <span className="font-mono text-xs text-faint">
                    {e.createdAt ? new Date(e.createdAt).toLocaleDateString() : "—"}
                  </span>{" "}
                  {e.outcome} — {e.reason ?? "—"}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}
