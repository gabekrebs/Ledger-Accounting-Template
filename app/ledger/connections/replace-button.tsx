"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { replaceConnection } from "./actions";

/**
 * "Get full history" — retire this connection and re-link the same bank to pull
 * the full 24 months Plaid allows. Needed because Plaid locks history depth
 * (days_requested) the moment a connection is first linked; a connection made
 * at the 90-day default can never be deepened in place. Two-click confirm: the
 * second click retires the connection, then the user re-links via the normal
 * "Connect a bank" button and assignments restore automatically.
 */
export function ReplaceButton({
  itemId,
  institutionName,
}: {
  itemId: string;
  institutionName: string;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  async function replace() {
    setBusy(true);
    try {
      const res = await replaceConnection(itemId);
      if (!res.ok) throw new Error(res.error ?? "Replace failed");
      toast.success(
        `${institutionName} retired — now click "Connect a bank" and log into ${institutionName} again. Account assignments restore automatically and the new link pulls 24 months of history.`,
        { duration: 15000 }
      );
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
        className="text-xs text-faint hover:text-foreground"
        title="Retire this connection and re-link the same bank to pull the full 24 months of history (Plaid locks history depth at link time)"
      >
        Get full history
      </button>
    );
  }

  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="text-muted-foreground">
        Retire &amp; re-link {institutionName}? You&apos;ll log in again; nothing
        already booked is touched.
      </span>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={replace}
        disabled={busy}
      >
        {busy ? "Retiring…" : "Yes, continue"}
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
