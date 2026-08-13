"use server";

import { getAuthClient, getCurrentUser } from "@/lib/supabase/auth-server";

export type ChangePwState = { error: string | null; ok?: boolean };

/**
 * Self-service password change for the signed-in user. Requires the CURRENT
 * password (re-verified via signInWithPassword) so an unattended/unlocked
 * session can't silently reset it. Uses the session-scoped auth client, so it
 * only ever changes the caller's own password — never anyone else's.
 */
export async function changePassword(
  _prev: ChangePwState,
  formData: FormData
): Promise<ChangePwState> {
  const user = await getCurrentUser();
  if (!user?.email) return { error: "You need to be signed in." };

  const current = String(formData.get("currentPassword") ?? "");
  const next = String(formData.get("newPassword") ?? "");
  const confirm = String(formData.get("confirmPassword") ?? "");

  if (!current || !next || !confirm) return { error: "Fill in all three fields." };
  if (next.length < 8) return { error: "New password must be at least 8 characters." };
  if (next !== confirm) return { error: "The new passwords don't match." };
  if (next === current) return { error: "Pick a password different from your current one." };

  const supabase = await getAuthClient();
  // Re-authenticate with the current password before allowing the change.
  const { error: reauthErr } = await supabase.auth.signInWithPassword({
    email: user.email,
    password: current,
  });
  if (reauthErr) return { error: "Your current password is incorrect." };

  const { error: updErr } = await supabase.auth.updateUser({ password: next });
  if (updErr) return { error: updErr.message || "Could not update your password." };

  return { error: null, ok: true };
}
