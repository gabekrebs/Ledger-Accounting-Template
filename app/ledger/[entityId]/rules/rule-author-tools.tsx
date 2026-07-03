"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { RuleForm } from "./rule-form";
import type { RulePayload } from "@/lib/rules/admin";
import type { PreviewResult } from "@/lib/rules/preview";
import type { NLDraft } from "@/lib/rules/ai-author";

/**
 * AI-as-author tools: ask AI to propose rules from recurring merchants, or
 * describe a rule in plain English and get a draft seeded into the builder. AI
 * only ever *proposes* — a human approves/saves; the deterministic engine
 * executes.
 */
export function RuleAuthorTools({
  canonicalOptions,
  accountOptions,
  aiPropose,
  nlDraft,
  save,
  preview,
  redirectTo,
}: {
  canonicalOptions: { key: string; label: string }[];
  accountOptions: { id: string; label: string }[];
  aiPropose: () => Promise<{ ok: boolean; error?: string; proposed?: number }>;
  nlDraft: (phrase: string) => Promise<{ ok: boolean; error?: string; draft?: NLDraft }>;
  save: (payload: RulePayload) => Promise<{ ok: boolean; error?: string; ruleId?: string }>;
  preview: (payload: RulePayload, previewEntityId?: string) => Promise<{ ok: boolean; error?: string; result?: PreviewResult }>;
  redirectTo: string;
}) {
  const [phrase, setPhrase] = useState("");
  const [draft, setDraft] = useState<NLDraft | null>(null);
  const [busy, start] = useTransition();
  const router = useRouter();

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() =>
            start(async () => {
              const r = await aiPropose();
              if (r.ok) {
                toast.success(
                  r.proposed ? `AI proposed ${r.proposed} rule${r.proposed === 1 ? "" : "s"} — review above` : "No new rules to propose"
                );
                router.refresh();
              } else toast.error(r.error ?? "AI proposal failed");
            })
          }
        >
          Suggest rules with AI
        </Button>
        <span className="text-xs text-faint">scans recurring merchants with no rule yet</span>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <label className="flex-1 text-sm">
          <span className="text-muted-foreground">Describe a rule in plain English</span>
          <Input
            value={phrase}
            onChange={(e) => setPhrase(e.target.value)}
            placeholder="comcast and centurylink are utilities"
            className="mt-1"
          />
        </label>
        <Button
          variant="outline"
          size="sm"
          disabled={busy || !phrase.trim()}
          onClick={() =>
            start(async () => {
              const r = await nlDraft(phrase);
              if (r.ok && r.draft) {
                setDraft(r.draft);
                toast.success("Draft ready — review & save below");
              } else toast.error(r.error ?? "Could not draft a rule");
            })
          }
        >
          Draft with AI
        </Button>
      </div>

      {draft && (
        <div className="rounded-lg border border-evergreen/30 bg-paper/40 p-4">
          <p className="mb-3 text-xs text-faint">
            AI draft{draft.reasoning ? ` — ${draft.reasoning}` : ""}. Review, preview, and save (or edit first).
          </p>
          <RuleForm
            key={JSON.stringify(draft)}
            scope="entity"
            canonicalOptions={canonicalOptions}
            accountOptions={accountOptions}
            draft={{ rows: draft.rows, categoryKey: draft.categoryKey ?? undefined }}
            save={save}
            preview={preview}
            redirectTo={redirectTo}
          />
        </div>
      )}
    </div>
  );
}
