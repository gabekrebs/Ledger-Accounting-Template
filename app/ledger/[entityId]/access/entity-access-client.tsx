"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  createUserAction,
  grantEntityAction,
  revokeEntityAction,
} from "../../users/actions";

type Grant = { email: string; displayName: string | null; active: boolean };

export function EntityAccessClient({
  entityId,
  grants,
  admins,
  grantable,
}: {
  entityId: string;
  grants: Grant[];
  admins: string[];
  grantable: { email: string; displayName: string | null }[];
}) {
  const [credential, setCredential] = useState<{
    email: string;
    password: string;
  } | null>(null);
  const [adding, setAdding] = useState(false);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [pending, startTransition] = useTransition();

  function grantExisting(grantEmail: string) {
    startTransition(async () => {
      const res = await grantEntityAction(grantEmail, entityId);
      if (!res.ok) toast.error(res.error ?? "Could not grant access.");
      else toast.success(`${grantEmail} granted`);
    });
  }

  function revoke(revokeEmail: string) {
    startTransition(async () => {
      const res = await revokeEntityAction(revokeEmail, entityId);
      if (!res.ok) toast.error(res.error ?? "Could not revoke access.");
      else toast.success(`${revokeEmail} removed from this entity`);
    });
  }

  function createScopedUser() {
    if (!email.trim()) {
      toast.error("Email is required.");
      return;
    }
    startTransition(async () => {
      const res = await createUserAction({
        email: email.trim(),
        displayName: name,
        role: "member",
        entityIds: [entityId],
        fromEntityId: entityId,
      });
      if (!res.ok) {
        toast.error(res.error ?? "Could not add the user.");
        return;
      }
      if (res.tempPassword) {
        setCredential({
          email: email.trim().toLowerCase(),
          password: res.tempPassword,
        });
      } else if (res.reusedExistingLogin) {
        toast.success("Added — they already had a login, so their existing password works.");
      }
      toast.success(`${email.trim().toLowerCase()} can now see this entity`);
      setEmail("");
      setName("");
      setAdding(false);
    });
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <p className="max-w-2xl text-sm text-muted-foreground">
          Who can see this entity. Admins always can; everyone else needs a
          grant here. Manage people across all entities at{" "}
          <Link href="/ledger/users" className="underline underline-offset-4 hover:text-foreground">
            Users
          </Link>
          .
        </p>
        {!adding && (
          <Button className="shrink-0" onClick={() => setAdding(true)}>
            Add person
          </Button>
        )}
      </div>

      {credential && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm">
          <div className="font-medium text-amber-900">
            Temporary password for {credential.email}
          </div>
          <div className="mt-1 flex items-center gap-3">
            <code className="rounded bg-white px-2 py-1 font-mono text-amber-900 ring-1 ring-amber-200">
              {credential.password}
            </code>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                navigator.clipboard.writeText(credential.password);
                toast.success("Copied");
              }}
            >
              Copy
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setCredential(null)}>
              Dismiss
            </Button>
          </div>
          <p className="mt-1.5 text-xs text-amber-800">
            Shown once — share it securely.
          </p>
        </div>
      )}

      {adding && (
        <div className="space-y-4 rounded-lg border border-hair p-4">
          {grantable.length > 0 && (
            <div className="space-y-2">
              <Label>Existing users</Label>
              <div className="flex flex-wrap gap-2">
                {grantable.map((g) => (
                  <Button
                    key={g.email}
                    size="sm"
                    variant="outline"
                    disabled={pending}
                    onClick={() => grantExisting(g.email)}
                  >
                    + {g.displayName || g.email}
                  </Button>
                ))}
              </div>
              <p className="text-xs text-faint">
                One click grants this entity to a user who already has a login.
              </p>
            </div>
          )}
          <div className="space-y-2">
            <Label>Or add someone new — scoped to this entity only</Label>
            <div className="grid gap-3 sm:grid-cols-2">
              <Input
                type="email"
                placeholder="name@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              <Input
                placeholder="Name (optional)"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setAdding(false)} disabled={pending}>
              Cancel
            </Button>
            <Button onClick={createScopedUser} disabled={pending}>
              {pending ? "Adding…" : "Add"}
            </Button>
          </div>
        </div>
      )}

      <div className="space-y-2">
        <h2 className="text-sm font-medium text-muted-foreground">Has access</h2>
        <div className="rounded-lg border border-hair divide-y divide-hair">
          {admins.map((a) => (
            <div
              key={a}
              className="flex items-center justify-between px-4 py-2.5 text-sm"
            >
              <span>{a}</span>
              <Badge variant="secondary">Full access</Badge>
            </div>
          ))}
          {grants.map((g) => (
            <div
              key={g.email}
              className={`flex items-center justify-between px-4 py-2.5 text-sm ${
                g.active ? "" : "opacity-60"
              }`}
            >
              <span>
                {g.displayName ? `${g.displayName} — ${g.email}` : g.email}
                {!g.active && (
                  <Badge variant="destructive" className="ml-2">
                    Deactivated
                  </Badge>
                )}
              </span>
              <Button
                size="sm"
                variant="ghost"
                disabled={pending}
                onClick={() => revoke(g.email)}
              >
                Revoke
              </Button>
            </div>
          ))}
          {grants.length === 0 && (
            <div className="px-4 py-3 text-sm text-faint">
              No one besides the admins above.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
