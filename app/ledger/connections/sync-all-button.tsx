"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

/** Pull the latest transactions from every linked bank into the staging inbox. */
export function SyncAllButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function sync() {
    setBusy(true);
    try {
      const res = await fetch("/api/plaid/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}), // no entityId → sync all
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Sync failed");
      const t = data.totals ?? { added: 0, modified: 0, removed: 0 };
      toast.success(
        `Synced · ${t.added} new, ${t.modified} updated, ${t.removed} removed`
      );
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button variant="outline" onClick={sync} disabled={busy}>
      {busy ? "Syncing…" : "Sync all"}
    </Button>
  );
}
