import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

/**
 * Cookie-bound Supabase client for server components, server actions, and route
 * handlers. Uses the ANON key (RLS/auth context = the signed-in user), distinct
 * from `getServerSupabase()` which is the service-role data client. Auth here is
 * the LOGIN gate (is this a known user?). WHICH entities a signed-in user may see
 * is a separate authorization layer in `lib/ledger/access.ts` (admins see all;
 * others are scoped by `bk_entity_access`). This is still not DB-level RLS — the
 * service-role data client bypasses it; enforcement is in pages/actions/routes.
 */
export async function getAuthClient() {
  const cookieStore = await cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // called from a Server Component — middleware refreshes the session
          }
        },
      },
    }
  );
}

/** The current signed-in user (validated against the Auth server), or null. */
export async function getCurrentUser() {
  const supabase = await getAuthClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
}

/**
 * Sanitize a post-login `next` redirect target. Only same-origin absolute paths
 * are allowed: must start with a single "/" and not "//" (protocol-relative,
 * resolves to another host) or "/\" (which some browsers also treat as a host).
 * Anything else falls back to "/" — closes the open-redirect/phishing vector.
 */
export function safeNextPath(next: string | null | undefined): string {
  if (!next || !next.startsWith("/")) return "/";
  if (next.startsWith("//") || next.startsWith("/\\")) return "/";
  return next;
}

// Email allowlisting moved to `lib/ledger/access.ts` (`isEmailAllowed`) — it is
// now DB-aware (env AUTH_ALLOWED_EMAILS ∪ active bk_app_users) so users added
// in-product can sign in without a redeploy.
