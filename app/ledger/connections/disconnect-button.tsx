"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { removeConnection } from "./actions";

/**
 * Disconnect a linked bank (e.g. the wrong login was connected). Two-click
 * confirm — destructive, and the first tap shouldn't drop a real connection.
 */
export function DisconnectButton({
  itemId,
  institutionName,
}: {
  itemId: string;
  institutionName: string;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  async function disconnect() {
    setBusy(true);
    try {
      const res = await removeConnection(itemId);
      if (!res.ok) throw new Error(res.error ?? "Disconnect failed");
      toast.success(`Disconnected ${institutionName}`);
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  }

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="text-xs text-faint hover:text-oxblood"
      >
        Disconnect
      </button>
    );
  }

  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="text-muted-foreground">Disconnect this bank?</span>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={disconnect}
        disabled={busy}
        className="border-oxblood/40 text-oxblood hover:bg-oxblood/5"
      >
        {busy ? "Disconnecting…" : "Yes, disconnect"}
      </Button>
      <button
        type="button"
        onClick={() => setConfirming(false)}
        disabled={busy}
        className="text-faint hover:text-foreground"
      >
        Cancel
      </button>
    </div>
  );
}
