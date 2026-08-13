import Link from "next/link";
import { listRulesForEntity, precisionFor } from "@/lib/rules/store";
import { listPostableAccounts } from "@/lib/plaid/data";
import { CANONICAL } from "@/lib/ledger/canonical-accounts";
import {
  currentUserIsAdmin,
  currentUserIsOwner,
  currentUserEntityAccessLevel,
} from "@/lib/ledger/access";
import { Section } from "../section";
import { RuleForm } from "./rule-form";
import { ProposedRules } from "./proposed-rules";
import { RuleAuthorTools } from "./rule-author-tools";
import {
  saveEntityRule,
  previewEntityRule,
  approveRule,
  dismissRule,
  aiProposeRules,
  nlDraftRule,
} from "./actions";
import type { ActionSpec, ConditionGroup } from "@/lib/rules/types";
import { predicateToRows } from "@/lib/rules/build";

export const dynamic = "force-dynamic";

const canonicalOptions = CANONICAL.map((d) => ({ key: d.key, label: `${d.label}` }));

function actionSummary(action: ActionSpec): string {
  if (action.kind === "categorize")
    return `→ ${action.target.by === "canonical" ? action.target.key : "account"}`;
  if (action.kind === "split") return "→ split";
  if (action.kind === "ignore") return "→ ignore";
  if (action.kind === "leave_uncategorized") return "→ leave";
  return "→ transfer";
}

function conditionSummary(predicate: ConditionGroup): string {
  const { combinator, rows } = predicateToRows(predicate);
  if (!rows.length) return "everything";
  const join = combinator === "any" ? " OR " : " AND ";
  return rows
    .map((r) => `${r.negated ? "NOT " : ""}${r.field} ${r.op} ${r.value}`)
    .join(join);
}

function Badge({ children, tone = "muted" }: { children: React.ReactNode; tone?: "muted" | "green" | "amber" }) {
  const cls =
    tone === "green"
      ? "border-evergreen/40 text-evergreen"
      : tone === "amber"
        ? "border-amber-500/40 text-amber-600 dark:text-amber-400"
        : "border-hair text-faint";
  return <span className={`rounded border px-1.5 py-0.5 text-[10px] ${cls}`}>{children}</span>;
}

export default async function RulesPage({
  params,
  searchParams,
}: {
  params: Promise<{ entityId: string }>;
  searchParams: Promise<{ merchant?: string; category?: string }>;
}) {
  const { entityId } = await params;
  const { merchant, category } = await searchParams;
  const [all, postable, admin, owner, accessLevel] = await Promise.all([
    listRulesForEntity(entityId),
    listPostableAccounts(entityId),
    currentUserIsAdmin(),
    currentUserIsOwner(),
    currentUserEntityAccessLevel(entityId),
  ]);
  const readOnly = accessLevel !== "write";
  const entityRules = all.filter((r) => r.scope === "entity" && r.status === "active");
  const entityProposed = all.filter((r) => r.scope === "entity" && r.status === "proposed");
  const globalRules = all.filter((r) => r.scope === "global" && r.status === "active");
  const proposedViews = entityProposed.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    origin: r.origin,
    summary: `${conditionSummary(r.predicate as ConditionGroup)} ${actionSummary(r.action as ActionSpec)}`,
    editHref: `/ledger/${entityId}/rules/${r.id}`,
  }));
  const accountOptions = postable.map((a) => ({
    id: a.id,
    label: a.fullyQualifiedName ?? a.name ?? "",
  }));

  const RuleLine = ({ rule, editable }: { rule: (typeof all)[number]; editable: boolean }) => {
    const conf = Math.round(precisionFor(rule) * 100);
    return (
      <div className="flex items-center justify-between gap-3 border-b border-hair/60 py-2 text-sm">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium">{rule.name}</span>
            {rule.autoApply ? <Badge tone="green">auto</Badge> : <Badge>propose</Badge>}
            {!rule.enabled && <Badge tone="amber">disabled</Badge>}
            <Badge>{conf}%</Badge>
          </div>
          <div className="truncate text-xs text-faint">
            {conditionSummary(rule.predicate as ConditionGroup)} {actionSummary(rule.action as ActionSpec)}
          </div>
        </div>
        {editable && !readOnly ? (
          <Link href={`/ledger/${entityId}/rules/${rule.id}`} className="shrink-0 text-xs text-evergreen hover:underline">
            Edit →
          </Link>
        ) : (
          <span className="shrink-0 text-[10px] text-faint">Global · inherited</span>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-10">
      {!readOnly && proposedViews.length > 0 && (
        <Section
          title="Proposed rules"
          description="Authored from your history, your accepted AI suggestions, and the AI author below. Nothing posts until you approve — then the deterministic engine takes over. Dismiss is remembered: a dismissed merchant only comes back if it shows new activity after the dismissal."
        >
          <ProposedRules
            rules={proposedViews}
            approve={approveRule.bind(null, entityId)}
            dismiss={dismissRule.bind(null, entityId)}
          />
        </Section>
      )}

      <Section
        title="This entity's rules"
        description="Entity rules target this entity's accounts and override inherited global rules. Only rules set to auto-apply post unattended."
      >
        {entityRules.length === 0 ? (
          <p className="text-sm text-muted-foreground">No entity rules yet — add one below.</p>
        ) : (
          <div>{entityRules.map((r) => <RuleLine key={r.id} rule={r} editable />)}</div>
        )}
      </Section>

      {globalRules.length > 0 && (
        <Section
          title="Inherited global rules"
          description={
            admin
              ? "Portfolio-wide defaults (read-only here). Edit them on the Global rules page."
              : "Portfolio-wide defaults applied to every entity. An entity rule above can override one."
          }
          action={admin ? <Link href="/ledger/rules" className="text-muted-foreground hover:text-evergreen">Global rules →</Link> : undefined}
        >
          <div>{globalRules.map((r) => <RuleLine key={r.id} rule={r} editable={false} />)}</div>
        </Section>
      )}

      {/* AI authoring spends model budget — owner only (actions re-assert). */}
      {owner && (
        <Section
          title="Author with AI"
          description="Let AI propose rules from your recurring merchants, or describe one in plain English. AI only proposes — you approve."
        >
          <RuleAuthorTools
            canonicalOptions={canonicalOptions}
            accountOptions={accountOptions}
            aiPropose={aiProposeRules.bind(null, entityId)}
            nlDraft={nlDraftRule.bind(null, entityId)}
            save={saveEntityRule.bind(null, entityId)}
            preview={previewEntityRule.bind(null, entityId)}
            redirectTo={`/ledger/${entityId}/rules`}
          />
        </Section>
      )}

      {!readOnly && (
        <Section title="Add a rule" description="Author a deterministic rule, preview what it would do, then save.">
          <RuleForm
            scope="entity"
            canonicalOptions={canonicalOptions}
            accountOptions={accountOptions}
            draft={merchant || category ? { merchant, categoryAccountId: category } : undefined}
            save={saveEntityRule.bind(null, entityId)}
            preview={previewEntityRule.bind(null, entityId)}
            redirectTo={`/ledger/${entityId}/rules`}
          />
        </Section>
      )}
    </div>
  );
}
