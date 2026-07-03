"use client";

import { useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

export interface ProposedRuleView {
  id: string;
  name: string;
  description: string | null;
  origin: string;
  summary: string;
  editHref?: string;
}

/**
 * The proposed-rules approval queue — where AUTHORS (the learner, AI, NL) surface
 * rules for a human to approve. Approve → the rule becomes active + enabled (the
 * deterministic engine takes over); Dismiss → archived. Edit opens the full
 * builder to adjust before approving.
 */
export function ProposedRules({
  rules,
  approve,
  dismiss,
}: {
  rules: ProposedRuleView[];
  approve: (ruleId: string) => Promise<{ ok: boolean; error?: string }>;
  dismiss: (ruleId: string) => Promise<{ ok: boolean; error?: string }>;
}) {
  const [busy, start] = useTransition();
  const router = useRouter();
  if (!rules.length) {
    return <p className="text-sm text-muted-foreground">No proposed rules right now.</p>;
  }
  return (
    <div className="space-y-2">
      {rules.map((r) => (
        <div
          key={r.id}
          className="flex items-center justify-between gap-3 rounded-lg border border-hair bg-paper/40 px-3 py-2 text-sm"
        >
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-medium">{r.name}</span>
              <span className="rounded border border-hair px-1.5 py-0.5 text-[10px] text-faint">
                {r.origin === "learned" ? "from history" : r.origin === "nl" ? "from AI" : r.origin}
              </span>
            </div>
            <div className="truncate text-xs text-faint">
              {r.summary}
              {r.description ? ` · ${r.description}` : ""}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {r.editHref && (
              <Link href={r.editHref} className="text-xs text-muted-foreground hover:text-evergreen">
                Edit
              </Link>
            )}
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() =>
                start(async () => {
                  const res = await approve(r.id);
                  if (res.ok) {
                    toast.success("Approved — now an active rule");
                    router.refresh();
                  } else toast.error(res.error ?? "Could not approve");
                })
              }
            >
              Approve
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() =>
                start(async () => {
                  const res = await dismiss(r.id);
                  if (res.ok) {
                    toast.success("Dismissed");
                    router.refresh();
                  } else toast.error(res.error ?? "Could not dismiss");
                })
              }
            >
              Dismiss
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}
