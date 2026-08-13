import Link from "next/link";
import { assertAdmin, isEnvAdmin } from "@/lib/ledger/access";
import { listAppUsers } from "@/lib/ledger/users";
import { listEntities } from "@/lib/ledger/reports";
import { UsersClient } from "./users-client";

export const dynamic = "force-dynamic";

function envEmails(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export default async function UsersPage() {
  await assertAdmin(); // user management surfaces every entity — admin only
  const [users, entities] = await Promise.all([listAppUsers(), listEntities()]);

  // Env-configured logins shown read-only so the full picture lives on one
  // page. Managed rows for the same email take precedence in the gate.
  const managed = new Set(users.map((u) => u.email));
  const builtIns = [
    ...envEmails("AUTH_ADMIN_EMAILS").map((email) => ({
      email,
      admin: true,
    })),
    ...envEmails("AUTH_ALLOWED_EMAILS")
      .filter((email) => !isEnvAdmin(email))
      .map((email) => ({ email, admin: false })),
  ].filter((b) => !managed.has(b.email));

  return (
    <main className="flex-1 px-6 py-12">
      <div className="mx-auto w-full max-w-page space-y-8">
        <div>
          <Link
            href="/"
            className="text-sm text-faint hover:text-muted-foreground"
          >
            ← All entities
          </Link>
          <h1 className="mt-1 font-serif text-3xl font-medium tracking-tight">
            Users
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            Add someone with <span className="font-medium text-foreground">full access</span>{" "}
            (every entity, can manage users and connections) or{" "}
            <span className="font-medium text-foreground">entity access</span>{" "}
            (only the entities you assign). New logins get a temporary password
            shown once — share it securely; changes take effect within about a
            minute, no deploy needed.
          </p>
        </div>

        <UsersClient
          users={users.map((u) => ({
            ...u,
            createdAt: u.createdAt ? u.createdAt.toISOString() : null,
          }))}
          entities={entities.map((e) => ({ id: e.id, name: e.name ?? e.id }))}
        />

        {builtIns.length > 0 && (
          <div className="space-y-2">
            <h2 className="text-sm font-medium text-muted-foreground">
              Environment-configured logins
            </h2>
            <div className="rounded-lg border border-hair divide-y divide-hair">
              {builtIns.map((b) => (
                <div
                  key={b.email}
                  className="flex items-center justify-between px-4 py-2.5 text-sm"
                >
                  <span>{b.email}</span>
                  <span className="text-xs text-faint">
                    {b.admin ? "admin · AUTH_ADMIN_EMAILS" : "AUTH_ALLOWED_EMAILS"}
                  </span>
                </div>
              ))}
            </div>
            <p className="text-xs text-faint">
              These come from environment variables (the break-glass list) and
              are managed in Vercel, not here.
            </p>
          </div>
        )}
      </div>
    </main>
  );
}
