"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  usePlaidLink,
  type PlaidLinkOnSuccess,
} from "react-plaid-link";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

/**
 * "Connect a bank" — fetches a Link token, opens Plaid Link, then exchanges the
 * resulting public_token server-side. Sandbox login: user_good / pass_good.
 */
export function PlaidLinkButton({ entityId }: { entityId: string }) {
  const router = useRouter();
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/plaid/link-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entityId }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        if (d.link_token) setLinkToken(d.link_token);
        else toast.error(d.error ?? "Could not start Plaid Link");
      })
      .catch((e) => !cancelled && toast.error(String(e)));
    return () => {
      cancelled = true;
    };
  }, [entityId]);

  const onSuccess = useCallback<PlaidLinkOnSuccess>(
    async (public_token) => {
      setBusy(true);
      try {
        const res = await fetch("/api/plaid/exchange", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ public_token, entityId }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Exchange failed");
        const added = data.synced?.added ?? 0;
        toast.success(
          `Connected ${data.institutionName ?? "bank"} · ${data.accounts} account(s)` +
            (added ? ` · ${added} transactions` : "")
        );
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [entityId, router]
  );

  const { open, ready } = usePlaidLink({ token: linkToken, onSuccess });

  return (
    <Button onClick={() => open()} disabled={!ready || !linkToken || busy}>
      {busy ? "Connecting…" : "Connect a bank"}
    </Button>
  );
}
