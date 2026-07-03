import { notFound } from "next/navigation";
import { getRule, recentEventsForRule } from "@/lib/rules/store";
import { listPostableAccounts } from "@/lib/plaid/data";
import { CANONICAL } from "@/lib/ledger/canonical-accounts";
import { Section } from "../../section";
import { RuleForm } from "../rule-form";
import { RuleApplyActions } from "../rule-apply-actions";
import {
  saveEntityRule,
  previewEntityRule,
  applyRulePending,
  applyRuleRetro,
} from "../actions";

export const dynamic = "force-dynamic";

const canonicalOptions = CANONICAL.map((d) => ({ key: d.key, label: d.label }));

export default async function EditRulePage({
  params,
}: {
  params: Promise<{ entityId: string; ruleId: string }>;
}) {
  const { entityId, ruleId } = await params;
  const rule = await getRule(ruleId);
  // This route edits ENTITY rules only; global rules are admin-edited elsewhere.
  if (!rule || rule.scope !== "entity" || rule.entityId !== entityId) notFound();

  const [postable, events] = await Promise.all([
    listPostableAccounts(entityId),
    recentEventsForRule(ruleId),
  ]);
  const accountOptions = postable.map((a) => ({
    id: a.id,
    label: a.fullyQualifiedName ?? a.name ?? "",
  }));

  return (
    <div className="space-y-10">
      <Section title={`Edit rule — ${rule.name}`} description="Change conditions or the action, preview, and save. Changes are audited.">
        <RuleForm
          scope="entity"
          canonicalOptions={canonicalOptions}
          accountOptions={accountOptions}
          rule={{
            id: rule.id,
            scope: "entity",
            name: rule.name,
            description: rule.description,
            enabled: rule.enabled,
            autoApply: rule.autoApply,
            rank: rule.rank,
            predicate: rule.predicate,
            action: rule.action,
          }}
          save={saveEntityRule.bind(null, entityId)}
          preview={previewEntityRule.bind(null, entityId)}
          redirectTo={`/ledger/${entityId}/rules`}
        />
      </Section>

      <Section title="Apply now" description="Run this saved rule against existing transactions.">
        <RuleApplyActions
          applyPending={applyRulePending.bind(null, entityId, ruleId)}
          applyRetro={applyRuleRetro.bind(null, entityId, ruleId)}
        />
      </Section>

      <Section title="Recent decisions" description="The categorization events this rule produced.">
        {events.length === 0 ? (
          <p className="text-sm text-muted-foreground">No decisions logged yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-hair text-[11px] font-medium uppercase tracking-[0.06em] text-faint">
                <th className="py-2 text-left font-medium">When</th>
                <th className="py-2 text-left font-medium">Outcome</th>
                <th className="py-2 text-left font-medium">Reason</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id} className="border-b border-hair/60">
                  <td className="py-2 font-mono text-xs text-faint">
                    {e.createdAt ? new Date(e.createdAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—"}
                  </td>
                  <td className="py-2">{e.outcome}</td>
                  <td className="py-2 text-xs text-muted-foreground">{e.reason ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
    </div>
  );
}
