import Link from "next/link";
import { assertAdmin } from "@/lib/ledger/access";
import { listGlobalRules, listProposedGlobal, precisionFor } from "@/lib/rules/store";
import { listEntities } from "@/lib/ledger/reports";
import { CANONICAL } from "@/lib/ledger/canonical-accounts";
import { RuleForm } from "../[entityId]/rules/rule-form";
import { ProposedRules } from "../[entityId]/rules/proposed-rules";
import { saveGlobalRule, previewGlobalRule, approveGlobalRule, dismissGlobalRule } from "./actions";
import { predicateToRows } from "@/lib/rules/build";
import type { ActionSpec, ConditionGroup } from "@/lib/rules/types";

export const dynamic = "force-dynamic";

const canonicalOptions = CANONICAL.map((d) => ({ key: d.key, label: d.label }));

function summary(predicate: ConditionGroup, action: ActionSpec): string {
  const { combinator, rows } = predicateToRows(predicate);
  const join = combinator === "any" ? " OR " : " AND ";
  const when = rows.length
    ? rows.map((r) => `${r.negated ? "NOT " : ""}${r.field} ${r.op} ${r.value}`).join(join)
    : "everything";
  const then =
    action.kind === "categorize" && action.target.by === "canonical"
      ? `→ ${action.target.key}`
      : `→ ${action.kind}`;
  return `${when} ${then}`;
}

export default async function GlobalRulesPage() {
  await assertAdmin(); // global rules affect every entity — admin only
  const [rules, proposed, entities] = await Promise.all([
    listGlobalRules(),
    listProposedGlobal(),
    listEntities(),
  ]);
  const previewEntities = entities.map((e) => ({ id: e.id, name: e.name ?? "(unnamed)" }));
  const proposedViews = proposed.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    origin: r.origin,
    summary: summary(r.predicate as ConditionGroup, r.action as ActionSpec),
  }));

  return (
    <main className="flex-1 px-6 py-8">
      <div className="mx-auto w-full max-w-5xl space-y-10">
        <div>
          <Link href="/ledger" className="text-sm text-faint hover:text-muted-foreground">
            ← Ledger
          </Link>
          <h1 className="mt-1 font-serif text-3xl font-medium tracking-tight">Global rules</h1>
          <p className="mt-1 max-w-prose text-sm text-muted-foreground">
            Portfolio-wide categorization rules. They target canonical category keys that resolve
            per-entity, and apply to every entity unless an entity rule overrides them.
          </p>
        </div>

        {proposedViews.length > 0 && (
          <section className="space-y-2">
            <h2 className="font-serif text-lg font-medium">Proposed global rules</h2>
            <p className="text-sm text-muted-foreground">
              AI-authored proposals. Nothing posts until you approve.
            </p>
            <ProposedRules
              rules={proposedViews}
              approve={approveGlobalRule}
              dismiss={dismissGlobalRule}
            />
          </section>
        )}

        <section className="space-y-2">
          <h2 className="font-serif text-lg font-medium">Existing global rules</h2>
          {rules.filter((r) => r.status !== "archived").length === 0 ? (
            <p className="text-sm text-muted-foreground">No global rules yet — add one below.</p>
          ) : (
            <div>
              {rules
                .filter((r) => r.status !== "archived")
                .map((r) => (
                  <div key={r.id} className="flex items-center justify-between gap-3 border-b border-hair/60 py-2 text-sm">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{r.name}</span>
                        <span className={`rounded border px-1.5 py-0.5 text-[10px] ${r.autoApply ? "border-evergreen/40 text-evergreen" : "border-hair text-faint"}`}>
                          {r.autoApply ? "auto" : "propose"}
                        </span>
                        {!r.enabled && <span className="rounded border border-amber-500/40 px-1.5 py-0.5 text-[10px] text-amber-600">disabled</span>}
                        <span className="rounded border border-hair px-1.5 py-0.5 text-[10px] text-faint">{Math.round(precisionFor(r) * 100)}%</span>
                      </div>
                      <div className="truncate text-xs text-faint">
                        {summary(r.predicate as ConditionGroup, r.action as ActionSpec)}
                      </div>
                    </div>
                    <Link href={`/ledger/rules/${r.id}`} className="shrink-0 text-xs text-evergreen hover:underline">
                      Edit →
                    </Link>
                  </div>
                ))}
            </div>
          )}
        </section>

        <section className="space-y-4">
          <h2 className="font-serif text-lg font-medium">Add a global rule</h2>
          <RuleForm
            scope="global"
            canonicalOptions={canonicalOptions}
            accountOptions={[]}
            previewEntities={previewEntities}
            save={saveGlobalRule}
            preview={previewGlobalRule}
            redirectTo="/ledger/rules"
          />
        </section>
      </div>
    </main>
  );
}
