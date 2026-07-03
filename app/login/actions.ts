"use server";

import { redirect } from "next/navigation";
import { getAuthClient, safeNextPath } from "@/lib/supabase/auth-server";
import { isEmailAllowed } from "@/lib/ledger/access";

export type SignInState = { error: string | null };

export async function signIn(
  _prev: SignInState,
  formData: FormData
): Promise<SignInState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const next = safeNextPath(String(formData.get("next") ?? "/"));

  if (!email || !password) return { error: "Email and password are required." };
  if (!(await isEmailAllowed(email))) {
    return { error: "This email isn't authorized for this app." };
  }

  const supabase = await getAuthClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return { error: "Invalid email or password." };

  redirect(next);
}

export async function signOut() {
  const supabase = await getAuthClient();
  await supabase.auth.signOut();
  redirect("/login");
}
