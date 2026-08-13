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
// tag keeps a normal connect, a FORCE connect, and an update-mode resume distinct.
const OAUTH_KEY = "plaid_link_resume";

/**
 * OAuth return state, read once at mount (lazy initializer, not an effect):
 * the bank redirected back here with `?oauth_state_id=…` and we must resume
 * the SAME Link session from sessionStorage — but only the button whose `mode`
 * was saved should resume, so a normal and a force button never fight over it.
 */
function readOAuthResume(mode: string): { token: string; redirectUri: string } | null {
  if (
    typeof window === "undefined" ||
    !window.location.search.includes("oauth_state_id=")
  ) {
    return null;
  }
  try {
    const saved = JSON.parse(sessionStorage.getItem(OAUTH_KEY) ?? "null");
    if (saved?.mode === mode && saved.token) {
      return { token: saved.token, redirectUri: window.location.href };
    }
  } catch {
    /* ignore malformed resume state */
  }
  return null;
}

/**
 * Global "Connect a bank" — links one bank auth WITHOUT binding it to an entity.
 * The returned accounts come back unassigned; you route each one to a business.
 * Handles the OAuth redirect flow required by Chase and most large banks.
 *
 * `force` variant ("Add a separate login at a bank"): sends `force: true` to the
 * exchange, bypassing the one-login-one-Item block for a GENUINELY DIFFERENT
 * login at an already-connected bank (e.g. a credit card on a separate profile).
 * It never re-links an existing connection, so it can't trigger the Chase
 * invalidate-on-relink breakage. Gated behind a confirmation.
 */
export function ConnectBankButton({ force = false }: { force?: boolean }) {
  const MODE = force ? "connect-force" : "connect";
  const router = useRouter();
  const [linkToken, setLinkToken] = useState<string | null>(
    () => readOAuthResume(MODE)?.token ?? null
  );
  const [receivedRedirectUri, setReceivedRedirectUri] = useState<
    string | undefined
  >(() => readOAuthResume(MODE)?.redirectUri);
  const [busy, setBusy] = useState(false);
  // Force flow requires an explicit confirmation before Link opens.
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (window.location.search.includes("oauth_state_id=")) return;
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
    setArmed(false);
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
          body: JSON.stringify({ public_token, force }),
        });
        const data = await res.json();
        // Duplicate-Item hard block (normal flow only; force bypasses it).
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
    [router, cleanupOAuth, force]
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

  useEffect(() => {
    if (receivedRedirectUri && linkToken && ready) open();
  }, [receivedRedirectUri, linkToken, ready, open]);

  const startLink = useCallback(() => {
    if (linkToken) {
      try {
        sessionStorage.setItem(
          OAUTH_KEY,
          JSON.stringify({ token: linkToken, mode: MODE })
        );
      } catch {
        /* sessionStorage unavailable — OAuth banks just won't resume */
      }
    }
    open();
  }, [linkToken, open, MODE]);

  // Normal connect button.
  if (!force) {
    return (
      <Button onClick={startLink} disabled={!ready || !linkToken || busy}>
        {busy ? "Connecting…" : "Connect a bank"}
      </Button>
    );
  }

  // Force connect — behind a confirmation with a clear warning.
  if (!armed) {
    return (
      <Button variant="outline" onClick={() => setArmed(true)} disabled={busy}>
        Add a separate login at a bank
      </Button>
    );
  }
  return (
    <div className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-400/30 dark:bg-amber-400/10">
      <p className="font-medium text-amber-900 dark:text-amber-200">
        Only for a genuinely different login at a bank you&rsquo;ve already
        connected
      </p>
      <p className="text-xs text-amber-800 dark:text-amber-200/80">
        Use this when accounts live under a <span className="font-medium">separate</span>{" "}
        login (e.g. a credit card on its own profile). Do <span className="font-medium">not</span>{" "}
        use it to re-link a connection you already have — to add or refresh
        accounts on an existing login, use &ldquo;Update / add accounts&rdquo; on
        that connection instead. Sign in with the <span className="font-medium">other</span>{" "}
        login on the next screen.
      </p>
      <div className="flex gap-2 pt-1">
        <Button
          size="sm"
          onClick={startLink}
          disabled={!ready || !linkToken || busy}
        >
          {busy ? "Connecting…" : "Continue — add separate login"}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setArmed(false)} disabled={busy}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
