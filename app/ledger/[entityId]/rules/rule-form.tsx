"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  FIELD_REGISTRY,
  STRING_OPS,
  NUMBER_OPS,
  type ConditionOp,
  type FieldId,
} from "@/lib/rules/types";
import { predicateToRows, type ConditionRow } from "@/lib/rules/build";
import type { RulePayload } from "@/lib/rules/admin";
import type { PreviewResult } from "@/lib/rules/preview";

export interface SerializedRule {
  id: string;
  scope: "global" | "entity";
  name: string;
  description: string | null;
  enabled: boolean;
  autoApply: boolean;
  rank: number;
  predicate: unknown;
  action: unknown;
}

type ActionKind = "categorize" | "ignore" | "leave_uncategorized";

const OP_LABEL: Record<ConditionOp, string> = {
  eq: "is", neq: "is not", contains: "contains", startsWith: "starts with",
  endsWith: "ends with", matches: "matches regex", in: "is one of",
  gt: ">", gte: "≥", lt: "<", lte: "≤", between: "between",
};

export function RuleForm({
  scope,
  canonicalOptions,
  accountOptions,
  previewEntities,
  rule,
  draft,
  save,
  preview,
  redirectTo,
}: {
  scope: "global" | "entity";
  canonicalOptions: { key: string; label: string }[];
  accountOptions: { id: string; label: string }[];
  /** Entities the admin can preview a GLOBAL rule against (omitted for entity scope). */
  previewEntities?: { id: string; name: string }[];
  rule?: SerializedRule;
  /** Prefill for a new rule — "create from this txn" or an AI/NL draft. */
  draft?: {
    merchant?: string;
    categoryAccountId?: string;
    rows?: ConditionRow[];
    categoryKey?: string;
  };
  save: (payload: RulePayload) => Promise<{ ok: boolean; error?: string; ruleId?: string }>;
  preview: (
    payload: RulePayload,
    previewEntityId?: string
  ) => Promise<{ ok: boolean; error?: string; result?: PreviewResult }>;
  redirectTo: string;
}) {
  const initial = useMemo(() => {
    if (rule?.predicate)
      return predicateToRows(rule.predicate as Parameters<typeof predicateToRows>[0]);
    return { combinator: "all" as const, rows: [] as ConditionRow[] };
  }, [rule]);

  const [name, setName] = useState(rule?.name ?? "");
  const [description, setDescription] = useState(rule?.description ?? "");
  const [rank, setRank] = useState(rule?.rank ?? 100);
  const [enabled, setEnabled] = useState(rule?.enabled ?? true);
  const [autoApply, setAutoApply] = useState(rule?.autoApply ?? true);
  const [combinator, setCombinator] = useState<"all" | "any">(initial.combinator);
  const [rows, setRows] = useState<ConditionRow[]>(
    initial.rows.length
      ? initial.rows
      : draft?.rows?.length
        ? draft.rows
        : draft?.merchant
          ? [{ field: "merchant", op: "contains", value: draft.merchant }]
          : [{ field: "merchant", op: "contains", value: "" }]
  );

  const initAction = (rule?.action ?? null) as { kind?: ActionKind; target?: { by: string; key?: string; accountId?: string }; payee?: string } | null;
  const [kind, setKind] = useState<ActionKind>(initAction?.kind ?? "categorize");
  const [targetBy, setTargetBy] = useState<"canonical" | "account">(
    initAction?.target?.by === "account" || (!rule && draft?.categoryAccountId)
      ? "account"
      : "canonical"
  );
  const [targetKey, setTargetKey] = useState(
    initAction?.target?.key ?? draft?.categoryKey ?? canonicalOptions[0]?.key ?? ""
  );
  const [targetAccountId, setTargetAccountId] = useState(
    initAction?.target?.accountId ?? draft?.categoryAccountId ?? accountOptions[0]?.id ?? ""
  );
  const [payee, setPayee] = useState(initAction?.payee ?? "");

  const [previewEntityId, setPreviewEntityId] = useState(previewEntities?.[0]?.id ?? "");
  const [result, setResult] = useState<PreviewResult | null>(null);
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  const [saving, startSave] = useTransition();
  const router = useRouter();

  const buildPayload = (): RulePayload => {
    const action: RulePayload["action"] =
      kind === "categorize"
        ? {
            kind: "categorize",
            target:
              scope === "entity" && targetBy === "account"
                ? { by: "account", accountId: targetAccountId }
                : { by: "canonical", key: targetKey as never },
            payee: payee.trim() || null,
          }
        : kind === "ignore"
          ? { kind: "ignore" }
          : { kind: "leave_uncategorized" };
    return {
      ruleId: rule?.id,
      name: name.trim(),
      description: description.trim() || null,
      combinator,
      conditions: rows.filter((r) => r.value.trim() !== "" || r.op === "matches"),
      action,
      enabled,
      autoApply,
      rank: Number(rank) || 100,
    };
  };

  // Debounced dry-run preview — zero writes; shows what the rule would do.
  useEffect(() => {
    // A global rule needs an entity to preview against; until one is picked,
    // leave the panel as-is (don't synchronously reset state in the effect body).
    if (scope === "global" && !previewEntityId) return;
    const h = setTimeout(async () => {
      const res = await preview(buildPayload(), previewEntityId || undefined);
      if (res.ok) {
        setResult(res.result ?? null);
        setPreviewErr(null);
      } else {
        setResult(null);
        setPreviewErr(res.error ?? "preview failed");
      }
    }, 400);
    return () => clearTimeout(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(rows), combinator, kind, targetBy, targetKey, targetAccountId, payee, rank, previewEntityId]);

  function doSave() {
    if (!name.trim()) {
      toast.error("Give the rule a name");
      return;
    }
    startSave(async () => {
      const res = await save(buildPayload());
      if (res.ok) {
        toast.success(rule ? "Rule updated" : "Rule created");
        router.push(redirectTo);
        router.refresh();
      } else {
        toast.error(res.error ?? "Could not save rule");
      }
    });
  }

  const setRow = (i: number, patch: Partial<ConditionRow>) =>
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <div className="space-y-8">
      {/* identity */}
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="text-muted-foreground">Rule name</span>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Comcast → Utilities" className="mt-1" />
        </label>
        <label className="block text-sm">
          <span className="text-muted-foreground">Priority (rank)</span>
          <span className="ml-1 text-xs text-faint">(lower wins)</span>
          <Input type="number" value={rank} onChange={(e) => setRank(Number(e.target.value))} className="mt-1" />
        </label>
        <label className="block text-sm sm:col-span-2">
          <span className="text-muted-foreground">Description</span>
          <span className="ml-1 text-xs text-faint">(optional)</span>
          <Input value={description} onChange={(e) => setDescription(e.target.value)} className="mt-1" />
        </label>
      </div>

      {/* conditions */}
      <div className="space-y-3">
        <div className="flex items-center gap-2 text-sm">
          <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-faint">When</span>
          <select
            value={combinator}
            onChange={(e) => setCombinator(e.target.value as "all" | "any")}
            className="rounded border border-hair bg-card px-2 py-1 text-sm"
          >
            <option value="all">ALL of these are true</option>
            <option value="any">ANY of these is true</option>
          </select>
        </div>

        {rows.map((r, i) => {
          const def = FIELD_REGISTRY.find((f) => f.id === r.field);
          const ops = def?.kind === "number" ? NUMBER_OPS : STRING_OPS;
          return (
            <div key={i} className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-1 text-xs text-faint">
                <input type="checkbox" checked={!!r.negated} onChange={(e) => setRow(i, { negated: e.target.checked })} className="accent-evergreen" />
                NOT
              </label>
              <select
                value={r.field}
                onChange={(e) => setRow(i, { field: e.target.value as FieldId })}
                className="rounded border border-hair bg-card px-2 py-1 text-sm"
              >
                {FIELD_REGISTRY.map((f) => (
                  <option key={f.id} value={f.id} disabled={f.reserved}>
                    {f.label}{f.reserved ? " (soon)" : ""}
                  </option>
                ))}
              </select>
              <select
                value={r.op}
                onChange={(e) => setRow(i, { op: e.target.value as ConditionOp })}
                className="rounded border border-hair bg-card px-2 py-1 text-sm"
              >
                {ops.map((op) => (
                  <option key={op} value={op}>{OP_LABEL[op]}</option>
                ))}
              </select>
              <Input
                value={r.value}
                onChange={(e) => setRow(i, { value: e.target.value })}
                placeholder={r.op === "in" ? "a, b, c" : r.op === "between" ? "lo, hi" : "value"}
                className="w-48"
              />
              <button type="button" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))} className="text-xs text-faint hover:text-oxblood">
                remove
              </button>
            </div>
          );
        })}
        <button
          type="button"
          onClick={() => setRows((rs) => [...rs, { field: "merchant", op: "contains", value: "" }])}
          className="text-sm text-evergreen hover:underline"
        >
          + add condition
        </button>
      </div>

      {/* action */}
      <div className="space-y-3">
        <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-faint">Then</span>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <select value={kind} onChange={(e) => setKind(e.target.value as ActionKind)} className="rounded border border-hair bg-card px-2 py-1 text-sm">
            <option value="categorize">categorize as</option>
            <option value="ignore">ignore (drop from inbox)</option>
            <option value="leave_uncategorized">leave uncategorized</option>
          </select>
          {kind === "categorize" && scope === "entity" && (
            <select value={targetBy} onChange={(e) => setTargetBy(e.target.value as "canonical" | "account")} className="rounded border border-hair bg-card px-2 py-1 text-sm">
              <option value="canonical">canonical category</option>
              <option value="account">specific account</option>
            </select>
          )}
          {kind === "categorize" && (targetBy === "canonical" || scope === "global") ? (
            <select value={targetKey} onChange={(e) => setTargetKey(e.target.value)} className="rounded border border-hair bg-card px-2 py-1 text-sm">
              {canonicalOptions.map((c) => (
                <option key={c.key} value={c.key}>{c.label}</option>
              ))}
            </select>
          ) : kind === "categorize" ? (
            <select value={targetAccountId} onChange={(e) => setTargetAccountId(e.target.value)} className="rounded border border-hair bg-card px-2 py-1 text-sm">
              {accountOptions.map((a) => (
                <option key={a.id} value={a.id}>{a.label}</option>
              ))}
            </select>
          ) : null}
          {kind === "categorize" && (
            <Input value={payee} onChange={(e) => setPayee(e.target.value)} placeholder="payee override (optional)" className="w-56" />
          )}
        </div>
        {scope === "global" && (
          <p className="text-xs text-faint">Global rules must target a canonical category — it resolves per-entity.</p>
        )}
      </div>

      {/* flags */}
      <div className="flex flex-wrap items-center gap-6 text-sm">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="accent-evergreen" />
          <span className="text-muted-foreground">Enabled</span>
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={autoApply}
            disabled={kind === "leave_uncategorized"}
            onChange={(e) => setAutoApply(e.target.checked)}
            className="accent-evergreen"
          />
          <span className="text-muted-foreground">
            Auto-apply <span className="text-xs text-faint">(post unattended — categorize / ignore only)</span>
          </span>
        </label>
      </div>

      {/* preview */}
      <div className="rounded-lg border border-hair bg-paper/40 p-4 text-sm">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-faint">Dry-run preview</span>
          {scope === "global" && previewEntities && (
            <label className="flex items-center gap-2 text-xs text-faint">
              against
              <select value={previewEntityId} onChange={(e) => setPreviewEntityId(e.target.value)} className="rounded border border-hair bg-card px-2 py-1">
                {previewEntities.map((e) => (
                  <option key={e.id} value={e.id}>{e.name}</option>
                ))}
              </select>
            </label>
          )}
        </div>
        {previewErr ? (
          <p className="mt-2 text-oxblood">{previewErr}</p>
        ) : !result ? (
          <p className="mt-2 text-faint">Edit conditions to see matches…</p>
        ) : (
          <div className="mt-2 space-y-2">
            <p>
              <strong>{result.pendingMatchCount}</strong> pending ·{" "}
              <strong>{result.postedMatchCount}</strong> already-posted would be touched retroactively
            </p>
            {result.actionError && <p className="text-oxblood">{result.actionError}</p>}
            {result.unresolved.length > 0 && (
              <p className="text-oxblood">Unresolved canonical keys: {result.unresolved.join(", ")}</p>
            )}
            {result.conflicts.length > 0 && (
              <p className="text-faint">
                {result.conflicts.length} of these are already claimed by a higher-precedence rule (e.g. “{result.conflicts[0].winningRuleName}”).
              </p>
            )}
            {result.sample.length > 0 && (
              <ul className="text-xs text-faint">
                {result.sample.slice(0, 5).map((m) => (
                  <li key={m.txnId}>· {m.label} — {m.txnDate}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      <div className="flex items-center gap-3">
        <Button onClick={doSave} disabled={saving}>
          {rule ? "Save changes" : "Create rule"}
        </Button>
      </div>
    </div>
  );
}
