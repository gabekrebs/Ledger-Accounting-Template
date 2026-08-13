"use server";

import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { randomUUID } from "node:crypto";
import { getAuthClient, safeNextPath } from "@/lib/supabase/auth-server";
import { isEmailAllowed } from "@/lib/ledger/access";
import { limitAction, loginIdentity } from "@/lib/security/rate-limit";

export type SignInState = { error: string | null };

export async function signIn(
  _prev: SignInState,
  formData: FormData
): Promise<SignInState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const next = safeNextPath(String(formData.get("next") ?? "/"));

  if (!email || !password) return { error: "Email and password are required." };

  // Brute-force cap, keyed on the TRUSTED client IP (not the email — so varying
  // the email can't bypass it). Generic response reveals nothing about the email.
  const rl = await limitAction("login", loginIdentity(await headers()));
  if (rl) return { error: rl.error };

  // Uniform failure for BOTH not-allowed and bad-credential cases, so a response
  // never reveals whether an email is registered / allowed / active.
  const GENERIC = "Invalid email or password.";
  const allowed = await isEmailAllowed(email);

  // Always perform the auth round-trip so response TIMING can't reveal whether an
  // email is provisioned (a not-allowed email would otherwise return before the
  // network hop). For a disallowed email we sign in with a throwaway password so
  // a valid credential can never establish a session — auth always fails there.
  const supabase = await getAuthClient();
  const { error } = await supabase.auth.signInWithPassword({
    email,
    password: allowed ? password : randomUUID(),
  });
  if (!allowed || error) return { error: GENERIC };

  redirect(next);
}

export async function signOut() {
  const supabase = await getAuthClient();
  await supabase.auth.signOut();
  redirect("/login");
}
