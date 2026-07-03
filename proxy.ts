import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { SECURITY_HEADERS } from "@/lib/security/headers";

function withSecurityHeaders(response: NextResponse) {
  for (const [key, value] of SECURITY_HEADERS) {
    response.headers.set(key, value);
  }
  return response;
}

function isPublicMachineEndpoint(pathname: string) {
  // Server-to-server endpoints that carry their own fail-closed capability
  // check (crons: CRON_SECRET header; Plaid webhook: PLAID_WEBHOOK_SECRET
  // token — see lib/security/machine-auth.ts), so the login gate lets them
  // through.
  return (
    pathname.startsWith("/api/cron/") ||
    pathname === "/api/plaid/webhook"
  );
}

function isPublicPage(pathname: string) {
  return pathname === "/login" || pathname.startsWith("/login/");
}

function envEmails(name: string) {
  return (process.env[name] ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * DB-managed users (`bk_app_users`, written by /ledger/users) extend the env
 * allowlist so adding someone takes effect immediately — no redeploy. Read via
 * PostgREST with the service-role key (the table has RLS on + zero anon
 * grants) and cached briefly per lambda. On any fetch failure we fall back to
 * the env lists alone, so the env-listed admins can never be locked out.
 */
type AppUserRow = { email: string; role: string; active: boolean };
let appUsersCache: { rows: AppUserRow[]; at: number } | null = null;
const APP_USERS_CACHE_MS = 30_000;

async function dbAppUsers(): Promise<AppUserRow[]> {
  if (appUsersCache && Date.now() - appUsersCache.at < APP_USERS_CACHE_MS) {
    return appUsersCache.rows;
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return appUsersCache?.rows ?? [];
  try {
    const res = await fetch(
      `${url}/rest/v1/bk_app_users?select=email,role,active`,
      {
        headers: { apikey: key, Authorization: `Bearer ${key}` },
        cache: "no-store",
      }
    );
    if (!res.ok) throw new Error(`bk_app_users ${res.status}`);
    const rows = (await res.json()) as AppUserRow[];
    appUsersCache = { rows, at: Date.now() };
    return rows;
  } catch {
    return appUsersCache?.rows ?? [];
  }
}

async function isAllowedEmail(email: string | null | undefined) {
  if (!email) return false;
  const lower = email.toLowerCase();
  // Env admins are break-glass: always in, regardless of DB state.
  if (envEmails("AUTH_ADMIN_EMAILS").includes(lower)) return true;
  const row = (await dbAppUsers()).find((u) => u.email.toLowerCase() === lower);
  // A deactivated managed user is out even if still in the env list.
  if (row) return row.active;
  return envEmails("AUTH_ALLOWED_EMAILS").includes(lower);
}

function copyCookies(source: NextResponse, target: NextResponse) {
  for (const cookie of source.cookies.getAll()) {
    target.cookies.set(cookie);
  }
  return target;
}

function unauthorized(request: NextRequest, response: NextResponse) {
  if (
    request.method === "GET" &&
    !request.nextUrl.pathname.startsWith("/api/") &&
    request.headers.get("accept")?.includes("text/html")
  ) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set(
      "next",
      `${request.nextUrl.pathname}${request.nextUrl.search}`
    );
    return withSecurityHeaders(
      copyCookies(response, NextResponse.redirect(loginUrl))
    );
  }

  return withSecurityHeaders(
    copyCookies(
      response,
      NextResponse.json(
        { error: "Authentication required" },
        {
          status: 401,
          headers: {
            "Cache-Control": "no-store",
          },
        }
      )
    )
  );
}

function forbidden(request: NextRequest, response: NextResponse) {
  if (
    request.method === "GET" &&
    !request.nextUrl.pathname.startsWith("/api/") &&
    request.headers.get("accept")?.includes("text/html")
  ) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set(
      "next",
      `${request.nextUrl.pathname}${request.nextUrl.search}`
    );
    loginUrl.searchParams.set("error", "not_allowed");
    return withSecurityHeaders(
      copyCookies(response, NextResponse.redirect(loginUrl))
    );
  }

  return withSecurityHeaders(
    copyCookies(
      response,
      NextResponse.json(
        { error: "Forbidden" },
        {
          status: 403,
          headers: {
            "Cache-Control": "no-store",
          },
        }
      )
    )
  );
}

function authUnavailable() {
  return withSecurityHeaders(
    NextResponse.json(
      { error: "Application authentication is not configured" },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    )
  );
}

async function getSession(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  return { user, response };
}

export async function proxy(request: NextRequest) {
  if (isPublicMachineEndpoint(request.nextUrl.pathname)) {
    return withSecurityHeaders(NextResponse.next());
  }

  if (
    !process.env.NEXT_PUBLIC_SUPABASE_URL ||
    !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  ) {
    return authUnavailable();
  }

  // Fail closed: with no env-listed emails AND no managed users, nobody may
  // sign in — a wiped config can't silently open the app.
  if (
    envEmails("AUTH_ALLOWED_EMAILS").length === 0 &&
    envEmails("AUTH_ADMIN_EMAILS").length === 0 &&
    (await dbAppUsers()).length === 0
  ) {
    return authUnavailable();
  }

  const { user, response } = await getSession(request);

  if (isPublicPage(request.nextUrl.pathname)) {
    return withSecurityHeaders(response);
  }

  if (!user) {
    return unauthorized(request, response);
  }

  if (!(await isAllowedEmail(user.email))) {
    return forbidden(request, response);
  }

  return withSecurityHeaders(response);
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js|map)$).*)",
  ],
};
