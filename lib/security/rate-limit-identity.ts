import { headers } from "next/headers";
import { getCurrentUser } from "@/lib/supabase/auth-server";
import { identityFor } from "@/lib/security/rate-limit";

/**
 * The rate-limit identity for a server action: the authenticated user when
 * present (primary signal), else the trusted client IP (secondary). Kept out of
 * `rate-limit.ts` so that module stays free of auth/next dependencies.
 */
export async function actionIdentity(): Promise<string> {
  const [h, user] = await Promise.all([headers(), getCurrentUser()]);
  return identityFor(user?.email, h);
}
