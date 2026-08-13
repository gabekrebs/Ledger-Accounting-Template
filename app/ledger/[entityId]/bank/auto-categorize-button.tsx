"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { autoCategorize } from "./actions";
import { Button } from "@/components/ui/button";

/**
 * Runs the deterministic, NO-AI auto-poster for this entity: posts what the
 * structural recognizers (transfers, loans, card payments) and the approved
 * auto-apply rules are sure about. Everything else stays in the inbox for
 * review. Re-runnable — idempotent.
 */
export function AutoCategorizeButton({ entityId }: { entityId: string }) {
  const [busy, start] = useTransition();
  const router = useRouter();

  function run() {
    start(async () => {
      const r = await autoCategorize(entityId);
      if (r.errors) {
        toast.error(
          `Auto-posted ${r.posted}, but ${r.errors} failed — check logs`
        );
      } else if (r.posted) {
        toast.success(
          `Auto-posted ${r.posted} match${r.posted === 1 ? "" : "es"}` +
            (r.skippedDup ? ` · skipped ${r.skippedDup} possible dup` : "")
        );
      } else {
        toast.info("Nothing to auto-post — no rule or recognizer match");
      }
      router.refresh();
    });
  }

  return (
    <Button type="button" variant="outline" size="sm" onClick={run} disabled={busy}>
      {busy ? "Posting…" : "Auto-post known matches"}
    </Button>
  );
}
