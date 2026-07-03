import Link from "next/link";
import { getCurrentUser } from "@/lib/supabase/auth-server";
import { isAdmin, isEntityCreator } from "@/lib/ledger/access";
import { signOut } from "./login/actions";
import { SettingsDropdown } from "./settings-dropdown";

/** Top bar: user info, settings menu, sign out. Renders nothing when logged out. */
export async function AuthHeader() {
  const user = await getCurrentUser();
  if (!user) return null;
  const admin = await isAdmin(user.email);
  return (
    <div className="flex items-center justify-between border-b border-hair px-6 py-2">
      <Link href="/" className="text-xs font-medium text-muted-foreground hover:text-foreground transition-colors">
        Ledger Accounting Template
      </Link>
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        {admin && <SettingsDropdown canAddEntity={isEntityCreator(user.email)} />}
        <span>{user.email}</span>
        <form action={signOut}>
          <button className="underline-offset-2 hover:text-foreground hover:underline transition-colors">
            Sign out
          </button>
        </form>
      </div>
    </div>
  );
}
