import type { NextConfig } from "next";
import { SECURITY_HEADERS } from "./lib/security/headers";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // Document uploads (settlement statements, multi-page 1098s) post through a
  // server action; the default 1 MB cap is too small for scanned PDFs.
  // authInterrupts: enables forbidden()/unauthorized() — used by the RBAC write
  // guard (assertEntityWrite) to return 403 when a read-only user attempts a
  // write (vs 404 for no access at all). See lib/ledger/access.ts.
  experimental: {
    serverActions: { bodySizeLimit: "25mb" },
    authInterrupts: true,
  },
  async redirects() {
    return [
      // The cross-entity inbox moved: /pending → /review ("Review Queue").
      // Not permanent, so browsers don't cache it if /pending is ever reused.
      // The OLD /review (team activity) moved to /teamactivity — deliberately
      // NO redirect there, because /review now serves a different page.
      { source: "/pending", destination: "/review", permanent: false },
    ];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        // Shared with proxy.ts — see lib/security/headers.ts for the CSP
        // rationale (dev-only unsafe-eval, documented unsafe-inline).
        headers: SECURITY_HEADERS.map(([key, value]) => ({ key, value })),
      },
    ];
  },
};

export default nextConfig;
