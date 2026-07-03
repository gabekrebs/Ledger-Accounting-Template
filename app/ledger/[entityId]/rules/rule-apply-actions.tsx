"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

export function RuleApplyActions({
  applyPending,
  applyRetro,
}: {
  applyPending: () => Promise<{ ok: boolean; error?: string; applied?: number; errors?: number }>;
  applyRetro: () => Promise<{
    ok: boolean;
    error?: string;
    updated?: number;
    refused?: number;
    skipped?: number;
  }>;
}) {
  const [busy, start] = useTransition();
  const router = useRouter();

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button
        variant="outline"
        size="sm"
        disabled={busy}
        onClick={() =>
          start(async () => {
            const r = await applyPending();
            if (r.ok) {
              toast.success(`Applied to ${r.applied ?? 0} pending${r.errors ? `, ${r.errors} errored` : ""}`);
              router.refresh();
            } else toast.error(r.error ?? "Could not apply");
          })
        }
      >
        Apply to pending matches
      </Button>
      <Button
        variant="outline"
        size="sm"
        disabled={busy}
        onClick={() =>
          start(async () => {
            const r = await applyRetro();
            if (r.ok) {
              toast.success(
                `Recategorized ${r.updated ?? 0}` +
                  (r.refused ? `, ${r.refused} refused (reconciled)` : "") +
                  (r.skipped ? `, ${r.skipped} skipped` : "")
              );
              router.refresh();
            } else toast.error(r.error ?? "Could not apply retroactively");
          })
        }
      >
        Apply retroactively
      </Button>
    </div>
  );
}
