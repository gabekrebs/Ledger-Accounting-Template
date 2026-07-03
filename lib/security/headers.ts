/**
 * The single source of truth for the security headers — imported by BOTH
 * next.config.ts (static asset / page responses) and proxy.ts (middleware
 * responses: redirects, 401/403 JSON), so the two can never drift.
 *
 * CSP posture:
 *  • `'unsafe-eval'` is DEV-ONLY — React uses eval for server-error stack
 *    reconstruction in development; neither React nor Next.js needs it in
 *    production (node_modules/next/dist/docs/01-app/02-guides/
 *    content-security-policy.md). NODE_ENV is fixed at build time on Vercel,
 *    so production builds ship without it.
 *  • `'unsafe-inline'` for script-src REMAINS, deliberately: removing it means
 *    nonce + 'strict-dynamic', which (a) requires every page to render
 *    dynamically — a static page's inline bootstrap gets no nonce and the app
 *    breaks at runtime, and (b) changes how the Plaid Link script
 *    (react-plaid-link injects it from cdn.plaid.com) is authorized. Plaid
 *    Link only exists on production (sandbox locally), so that combination
 *    can't be verified in a local change. Documented follow-up: adopt the
 *    proxy-generated-nonce pattern from the Next CSP guide and verify Link
 *    end-to-end on production.
 *  • Everything else is tight: default deny to 'self', no objects, no
 *    framing, forms/base locked to self, connect limited to Supabase + Plaid.
 */
const IS_DEV = process.env.NODE_ENV === "development";

export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  `script-src 'self' 'unsafe-inline'${IS_DEV ? " 'unsafe-eval'" : ""} https://cdn.plaid.com`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "frame-src 'self' https://*.plaid.com",
  "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://*.plaid.com",
  "upgrade-insecure-requests",
].join("; ");

export const SECURITY_HEADERS: Array<[string, string]> = [
  ["Content-Security-Policy", CONTENT_SECURITY_POLICY],
  ["X-Frame-Options", "DENY"],
  ["X-Content-Type-Options", "nosniff"],
  ["Referrer-Policy", "no-referrer"],
  [
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  ],
  ["Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload"],
];
