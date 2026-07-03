import type { NextConfig } from "next";
import { SECURITY_HEADERS } from "./lib/security/headers";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // Document uploads (settlement statements, multi-page 1098s) post through a
  // server action; the default 1 MB cap is too small for scanned PDFs.
  experimental: { serverActions: { bodySizeLimit: "25mb" } },
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
