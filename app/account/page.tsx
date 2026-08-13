import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/supabase/auth-server";
import { ChangePasswordForm } from "./change-password-form";

export const dynamic = "force-dynamic";

export default async function AccountPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  return (
    <main className="flex-1 px-6 py-10">
      <div className="mx-auto w-full max-w-md">
        <div className="flex items-baseline justify-between">
          <h1 className="text-lg font-medium">Your account</h1>
          <Link href="/" className="text-sm text-faint hover:text-evergreen">
            ← Home
          </Link>
        </div>
        <p className="mt-1 text-sm text-faint">
          Signed in as <span className="font-medium text-foreground">{user.email}</span>.
        </p>

        <section className="mt-8 rounded-lg border border-hair bg-background p-5">
          <h2 className="text-sm font-semibold">Change password</h2>
          <p className="mb-4 mt-1 text-xs text-faint">
            If you signed in with a temporary password, set your own here.
          </p>
          <ChangePasswordForm />
        </section>
      </div>
    </main>
  );
}
