import { createClient } from "@supabase/supabase-js";

/**
 * Service-role Supabase client for server-side use only.
 * Bypasses RLS — never expose to the browser.
 */
export function getServerSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      auth: { persistSession: false, autoRefreshToken: false },
    }
  );
}
