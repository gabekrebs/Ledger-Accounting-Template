"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  createUserAction,
  removeUserAction,
  resetPasswordAction,
  setActiveAction,
  setEntitiesAction,
  setRoleAction,
} from "./actions";
import type { AppRole } from "@/lib/ledger/users";

type Entity = { id: string; name: string };
type User = {
  id: string;
  email: string;
  displayName: string | null;
  role: AppRole;
  active: boolean;
  createdAt: string | null;
  entities: { id: string; name: string | null }[];
};

/** One-time credential banner — shown after a create/reset, never persisted. */
function TempPasswordNotice({
  notice,
  onDismiss,
}: {
  notice: { email: string; password: string };
  onDismiss: () => void;
}) {
  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm">
      <div className="font-medium text-amber-900">
        Temporary password for {notice.email}
      </div>
      <div className="mt-1 flex items-center gap-3">
        <code className="rounded bg-white px-2 py-1 font-mono text-amber-900 ring-1 ring-amber-200">
          {notice.password}
        </code>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            navigator.clipboard.writeText(notice.password);
            toast.success("Copied");
          }}
        >
          Copy
        </Button>
        <Button size="sm" variant="ghost" onClick={onDismiss}>
          Dismiss
        </Button>
      </div>
      <p className="mt-1.5 text-xs text-amber-800">
        Shown once — share it securely. They can change it after signing in.
      </p>
    </div>
  );
}

function EntityChecklist({
  entities,
  selected,
  onToggle,
}: {
  entities: Entity[];
  selected: Set<string>;
  onToggle: (id: string) => void;
}) {
  return (
    <div className="grid gap-1.5 sm:grid-cols-2">
      {entities.map((e) => (
        <label
          key={e.id}
          className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-paper"
        >
          <input
            type="checkbox"
            checked={selected.has(e.id)}
            onChange={() => onToggle(e.id)}
            className="h-4 w-4 accent-foreground"
          />
          <span className="truncate">{e.name}</span>
        </label>
      ))}
    </div>
  );
}

function AddUserForm({
  entities,
  onCredential,
}: {
  entities: Entity[];
  onCredential: (n: { email: string; password: string }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<AppRole>("member");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, startTransition] = useTransition();

  function reset() {
    setEmail("");
    setName("");
    setRole("member");
    setSelected(new Set());
  }

  function submit() {
    if (!email.trim()) {
      toast.error("Email is required.");
      return;
    }
    if (role === "member" && selected.size === 0) {
      toast.error("Assign at least one entity (or grant full access).");
      return;
    }
    startTransition(async () => {
      const res = await createUserAction({
        email: email.trim(),
        displayName: name,
        role,
        entityIds: role === "admin" ? [] : [...selected],
      });
      if (!res.ok) {
        toast.error(res.error ?? "Could not add the user.");
        return;
      }
      if (res.tempPassword) {
        onCredential({ email: email.trim().toLowerCase(), password: res.tempPassword });
      } else if (res.reusedExistingLogin) {
        toast.success("Added — they already had a login, so their existing password works.");
      }
      toast.success(`${email.trim().toLowerCase()} added`);
      reset();
      setOpen(false);
    });
  }

  if (!open) {
    return (
      <div className="flex justify-end">
        <Button onClick={() => setOpen(true)}>Add user</Button>
      </div>
    );
  }

  return (
    <div className="space-y-4 rounded-lg border border-hair p-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="new-user-email">Email</Label>
          <Input
            id="new-user-email"
            type="email"
            placeholder="name@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="new-user-name">Name (optional)</Label>
          <Input
            id="new-user-name"
            placeholder="Joey Patino"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
      </div>

      <div className="space-y-2">
        <Label>Access</Label>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setRole("member")}
            className={`rounded-md border px-3 py-1.5 text-sm transition-colors ${
              role === "member"
                ? "border-foreground bg-foreground text-background"
                : "border-hair hover:bg-paper"
            }`}
          >
            Specific entities
          </button>
          <button
            type="button"
            onClick={() => setRole("admin")}
            className={`rounded-md border px-3 py-1.5 text-sm transition-colors ${
              role === "admin"
                ? "border-foreground bg-foreground text-background"
                : "border-hair hover:bg-paper"
            }`}
          >
            Full access — all entities
          </button>
        </div>
        {role === "member" && (
          <EntityChecklist
            entities={entities}
            selected={selected}
            onToggle={(id) =>
              setSelected((prev) => {
                const next = new Set(prev);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                return next;
              })
            }
          />
        )}
        {role === "admin" && (
          <p className="text-xs text-muted-foreground">
            Sees every entity and can manage users and bank connections.
          </p>
        )}
      </div>

      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
          Cancel
        </Button>
        <Button onClick={submit} disabled={pending}>
          {pending ? "Adding…" : "Add user"}
        </Button>
      </div>
    </div>
  );
}

function UserRow({
  user,
  entities,
  onCredential,
}: {
  user: User;
  entities: Entity[];
  onCredential: (n: { email: string; password: string }) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [role, setRole] = useState<AppRole>(user.role);
  const [selected, setSelected] = useState<Set<string>>(
    new Set(user.entities.map((e) => e.id))
  );
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [pending, startTransition] = useTransition();

  function run(fn: () => Promise<{ ok: boolean; error?: string }>, done?: string) {
    startTransition(async () => {
      const res = await fn();
      if (!res.ok) toast.error(res.error ?? "Something went wrong.");
      else if (done) toast.success(done);
    });
  }

  function saveAccess() {
    if (role === "member" && selected.size === 0) {
      toast.error("Assign at least one entity (or grant full access).");
      return;
    }
    startTransition(async () => {
      if (role !== user.role) {
        const r = await setRoleAction(user.id, role);
        if (!r.ok) {
          toast.error(r.error ?? "Could not change the role.");
          return;
        }
      }
      const r2 = await setEntitiesAction(
        user.id,
        role === "admin" ? [] : [...selected]
      );
      if (!r2.ok) {
        toast.error(r2.error ?? "Could not save entity access.");
        return;
      }
      toast.success("Access updated");
      setEditing(false);
    });
  }

  return (
    <div className={`rounded-lg border border-hair p-4 ${user.active ? "" : "opacity-60"}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium">{user.displayName || user.email}</span>
            {user.role === "admin" ? (
              <Badge variant="secondary">Full access</Badge>
            ) : (
              <Badge variant="outline">
                {user.entities.length}{" "}
                {user.entities.length === 1 ? "entity" : "entities"}
              </Badge>
            )}
            {!user.active && <Badge variant="destructive">Deactivated</Badge>}
          </div>
          {user.displayName && (
            <div className="text-sm text-muted-foreground">{user.email}</div>
          )}
          {user.role === "member" && user.entities.length > 0 && !editing && (
            <div className="mt-1 text-xs text-faint">
              {user.entities.map((e) => e.name).join(" · ")}
            </div>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap gap-1.5">
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => {
              setEditing((v) => !v);
              setRole(user.role);
              setSelected(new Set(user.entities.map((e) => e.id)));
            }}
          >
            {editing ? "Cancel" : "Edit access"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() =>
              run(async () => {
                const res = await resetPasswordAction(user.id);
                if (res.ok && res.tempPassword) {
                  onCredential({ email: user.email, password: res.tempPassword });
                }
                return res;
              })
            }
          >
            Reset password
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() =>
              run(
                () => setActiveAction(user.id, !user.active, user.email),
                user.active ? "Deactivated — signed out of access" : "Reactivated"
              )
            }
          >
            {user.active ? "Deactivate" : "Reactivate"}
          </Button>
          {confirmRemove ? (
            <Button
              size="sm"
              variant="destructive"
              disabled={pending}
              onClick={() =>
                run(() => removeUserAction(user.id, user.email), "Removed")
              }
            >
              Confirm remove
            </Button>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() => setConfirmRemove(true)}
            >
              Remove
            </Button>
          )}
        </div>
      </div>

      {editing && (
        <div className="mt-4 space-y-3 border-t border-hair pt-4">
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setRole("member")}
              className={`rounded-md border px-3 py-1.5 text-sm transition-colors ${
                role === "member"
                  ? "border-foreground bg-foreground text-background"
                  : "border-hair hover:bg-paper"
              }`}
            >
              Specific entities
            </button>
            <button
              type="button"
              onClick={() => setRole("admin")}
              className={`rounded-md border px-3 py-1.5 text-sm transition-colors ${
                role === "admin"
                  ? "border-foreground bg-foreground text-background"
                  : "border-hair hover:bg-paper"
              }`}
            >
              Full access — all entities
            </button>
          </div>
          {role === "member" && (
            <EntityChecklist
              entities={entities}
              selected={selected}
              onToggle={(id) =>
                setSelected((prev) => {
                  const next = new Set(prev);
                  if (next.has(id)) next.delete(id);
                  else next.add(id);
                  return next;
                })
              }
            />
          )}
          <div className="flex justify-end">
            <Button size="sm" onClick={saveAccess} disabled={pending}>
              {pending ? "Saving…" : "Save access"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export function UsersClient({
  users,
  entities,
}: {
  users: User[];
  entities: Entity[];
}) {
  const [credential, setCredential] = useState<{
    email: string;
    password: string;
  } | null>(null);

  return (
    <div className="space-y-4">
      {credential && (
        <TempPasswordNotice
          notice={credential}
          onDismiss={() => setCredential(null)}
        />
      )}
      <AddUserForm entities={entities} onCredential={setCredential} />
      {users.length === 0 ? (
        <div className="rounded-lg border border-dashed border-hair px-6 py-10 text-center text-sm text-muted-foreground">
          No managed users yet. Click{" "}
          <span className="font-medium text-foreground">Add user</span> to give
          someone access to all entities or just the ones you pick.
        </div>
      ) : (
        <div className="space-y-3">
          {users.map((u) => (
            <UserRow
              key={u.id}
              user={u}
              entities={entities}
              onCredential={setCredential}
            />
          ))}
        </div>
      )}
    </div>
  );
}
