"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { usePlaidLink, type PlaidLinkOnSuccess } from "react-plaid-link";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

// Where we stash the link token across an OAuth round-trip. OAuth banks (Chase)
// navigate the browser out to the bank and back to the redirect_uri (this page)
// with `?oauth_state_id=…`; on that reload we must resume Link with the SAME
// token + receivedRedirectUri. sessionStorage survives the redirect; the `mode`
// tag keeps the fresh-link resume distinct from an update-mode resume.
const OAUTH_KEY = "plaid_link_resume";

/**
 * OAuth return state, read once at mount (lazy initializer, not an effect):
 * the bank redirected back here with `?oauth_state_id=…` and we must resume
 * the SAME Link session from sessionStorage.
 */
function readOAuthResume(): { token: string; redirectUri: string } | null {
  if (
    typeof window === "undefined" ||
    !window.location.search.includes("oauth_state_id=")
  ) {
    return null;
  }
  try {
    const saved = JSON.parse(sessionStorage.getItem(OAUTH_KEY) ?? "null");
    if (saved?.mode === "connect" && saved.token) {
      return { token: saved.token, redirectUri: window.location.href };
    }
  } catch {
    /* ignore malformed resume state */
  }
  return null;
}

/**
 * Global "Connect a bank" — links one bank auth WITHOUT binding it to an entity.
 * The returned accounts come back unassigned; you route each one to a business
 * below. Handles the OAuth redirect flow required by Chase and most large banks.
 */
export function ConnectBankButton() {
  const router = useRouter();
  const [linkToken, setLinkToken] = useState<string | null>(
    () => readOAuthResume()?.token ?? null
  );
  const [receivedRedirectUri, setReceivedRedirectUri] = useState<
    string | undefined
  >(() => readOAuthResume()?.redirectUri);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // OAuth return (resume state already initialized above): don't mint a
    // fresh token — the redirected session must resume with the SAME one.
    if (window.location.search.includes("oauth_state_id=")) return;

    // Normal load: mint a fresh link token and stash it for a possible OAuth hop.
    let cancelled = false;
    fetch("/api/plaid/link-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
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
  }, []);

  const cleanupOAuth = useCallback(() => {
    try {
      sessionStorage.removeItem(OAUTH_KEY);
    } catch {
      /* noop */
    }
    setReceivedRedirectUri(undefined);
    if (
      typeof window !== "undefined" &&
      window.location.search.includes("oauth_state_id=")
    ) {
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, []);

  const onSuccess = useCallback<PlaidLinkOnSuccess>(
    async (public_token) => {
      setBusy(true);
      try {
        const res = await fetch("/api/plaid/exchange", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ public_token }),
        });
        const data = await res.json();
        // Duplicate-Item hard block: one login = one Item. Steer to Update Mode.
        if (res.status === 409 && data.error === "duplicate_item") {
          toast.warning(data.message ?? "This bank is already connected.", {
            duration: 12000,
          });
          cleanupOAuth();
          router.refresh();
          return;
        }
        if (!res.ok) throw new Error(data.error ?? "Exchange failed");
        const dups: { name: string | null; mask: string | null }[] =
          data.duplicateAccounts ?? [];
        if (dups.length) {
          toast.warning(
            `${dups.length} account(s) here are already connected (${dups
              .map((d) => d.mask ?? d.name ?? "?")
              .join(", ")}). Leave them unassigned or remove this connection to avoid double-counting.`,
            { duration: 10000 }
          );
        } else {
          toast.success(
            `Connected ${data.institutionName ?? "bank"} · ${data.accounts} account(s) — now assign each to a business`
          );
        }
        cleanupOAuth();
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e));
        cleanupOAuth();
      } finally {
        setBusy(false);
      }
    },
    [router, cleanupOAuth]
  );

  const { open, ready } = usePlaidLink({
    token: linkToken,
    receivedRedirectUri,
    onSuccess,
    onExit: () => {
      setBusy(false);
      cleanupOAuth();
    },
  });

  // On an OAuth return, auto-reopen Link to finish the handshake once it's ready.
  useEffect(() => {
    if (receivedRedirectUri && linkToken && ready) open();
  }, [receivedRedirectUri, linkToken, ready, open]);

  // Persist the active flow ONLY when the user actually opens Link, so an OAuth
  // redirect can resume the SAME session — and so an update-mode flow (which
  // shares this key) is never clobbered by a connect that was never started.
  const handleConnect = useCallback(() => {
    if (linkToken) {
      try {
        sessionStorage.setItem(
          OAUTH_KEY,
          JSON.stringify({ token: linkToken, mode: "connect" })
        );
      } catch {
        /* sessionStorage unavailable — OAuth banks just won't resume */
      }
    }
    open();
  }, [linkToken, open]);

  return (
    <Button onClick={handleConnect} disabled={!ready || !linkToken || busy}>
      {busy ? "Connecting…" : "Connect a bank"}
    </Button>
  );
}
