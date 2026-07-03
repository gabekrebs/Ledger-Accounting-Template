"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { usePlaidLink, type PlaidLinkOnSuccess } from "react-plaid-link";
import { toast } from "sonner";

// Shared with ConnectBankButton — the single "active Link flow" resume record for
// an OAuth round-trip. Written at open time; `mode`+`itemId` disambiguate which
// button (and which connection) resumes when the bank redirects back.
const OAUTH_KEY = "plaid_link_resume";

/**
 * OAuth return state for THIS connection's update flow, read once at mount
 * (lazy initializer, not an effect). Null unless the bank just redirected
 * back for this exact Item.
 */
function readOAuthResume(
  itemId: string
): { token: string; redirectUri: string } | null {
  if (
    typeof window === "undefined" ||
    !window.location.search.includes("oauth_state_id=")
  ) {
    return null;
  }
  try {
    const saved = JSON.parse(sessionStorage.getItem(OAUTH_KEY) ?? "null");
    if (saved?.mode === "update" && saved.itemId === itemId && saved.token) {
      return { token: saved.token, redirectUri: window.location.href };
    }
  } catch {
    /* ignore malformed resume state */
  }
  return null;
}

/**
 * Update-mode re-link for an EXISTING bank connection — reopens Plaid Link on the
 * SAME Item (no new Item, no duplicate transactions). Two jobs:
 *   • repair a broken login (ITEM_LOGIN_REQUIRED / expired OAuth consent), and
 *   • ADD newly-opened accounts to this Item (account_selection_enabled) — the
 *     one-login-one-Item way to grow the account set without a duplicate link.
 * On success it calls /api/plaid/refresh-accounts to pull the current accounts,
 * upsert any new ones (unassigned), and sync. Handles the OAuth redirect flow
 * Chase requires. It can NOT deepen history — that's the ReplaceButton flow.
 *
 * The token is fetched on demand (per click), not on mount — a page of N
 * connections shouldn't mint N link tokens nobody uses.
 */
export function UpdateLinkButton({
  itemId,
  institutionName,
}: {
  itemId: string;
  institutionName: string;
}) {
  const router = useRouter();
  // Resume state initializes directly from the OAuth return (if any) — the
  // auto-open effect below finishes the handshake once Link is ready.
  const [linkToken, setLinkToken] = useState<string | null>(
    () => readOAuthResume(itemId)?.token ?? null
  );
  const [receivedRedirectUri, setReceivedRedirectUri] = useState<
    string | undefined
  >(() => readOAuthResume(itemId)?.redirectUri);
  const [busy, setBusy] = useState(() => readOAuthResume(itemId) !== null);

  const cleanupOAuth = useCallback(() => {
    try {
      sessionStorage.removeItem(OAUTH_KEY);
    } catch {
      /* noop */
    }
    setReceivedRedirectUri(undefined);
    setLinkToken(null);
    if (
      typeof window !== "undefined" &&
      window.location.search.includes("oauth_state_id=")
    ) {
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, []);

  async function start() {
    setBusy(true);
    try {
      const res = await fetch("/api/plaid/link-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemId }),
      });
      const data = await res.json();
      if (!data.link_token)
        throw new Error(data.error ?? "Could not start Plaid Link");
      // Stash BEFORE the (possible) OAuth redirect so this connection resumes.
      try {
        sessionStorage.setItem(
          OAUTH_KEY,
          JSON.stringify({ token: data.link_token, mode: "update", itemId })
        );
      } catch {
        /* sessionStorage unavailable — OAuth banks just won't resume */
      }
      setLinkToken(data.link_token); // opens via the effect below once ready
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  // On success, refresh the Item's accounts: upsert any newly-selected ones
  // (unassigned) and sync. Reuses the existing Item + token — never a duplicate.
  const onSuccess = useCallback<PlaidLinkOnSuccess>(async () => {
    try {
      const res = await fetch("/api/plaid/refresh-accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Refresh failed");
      toast.success(
        data.added > 0
          ? `${institutionName}: ${data.added} new account(s) added — assign each below`
          : `${institutionName} login updated`
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      cleanupOAuth();
      router.refresh();
    }
  }, [itemId, institutionName, router, cleanupOAuth]);

  const { open, ready } = usePlaidLink({
    token: linkToken,
    receivedRedirectUri,
    onSuccess,
    onExit: () => {
      setBusy(false);
      cleanupOAuth();
    },
  });

  useEffect(() => {
    if (linkToken && ready) open();
  }, [linkToken, ready, open]);

  return (
    <button
      type="button"
      onClick={start}
      disabled={busy}
      className="text-xs text-faint hover:text-foreground"
      title="Re-open Plaid Link on this connection to repair a broken login or add newly-opened accounts to the same connection (no duplicate connection)"
    >
      {busy ? "Opening…" : "Update / add accounts"}
    </button>
  );
}
