import { redirect } from "next/navigation";
import { getCurrentUser, safeNextPath } from "@/lib/supabase/auth-server";
import { isEmailAllowed } from "@/lib/ledger/access";
import { LoginForm } from "./login-form";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const { next, error } = await searchParams;

  // Already signed in (and allowed)? Skip the form.
  const user = await getCurrentUser();
  if (user && (await isEmailAllowed(user.email))) {
    redirect(safeNextPath(next));
  }

  const initialError =
    error === "not_allowed"
      ? "That account isn't authorized for this app."
      : null;

  return (
    <main className="flex flex-1 items-center justify-center px-6">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center">
          <h1 className="font-serif text-2xl font-medium tracking-tight">
            Ledger Accounting Template
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Sign in to continue.
          </p>
        </div>
        <LoginForm next={next ?? "/"} initialError={initialError} />
      </div>
    </main>
  );
}
