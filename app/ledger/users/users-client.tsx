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
  setEntityLevelsAction,
  setRoleAction,
} from "./actions";
import type { AppRole, EntityAccessLevel } from "@/lib/ledger/users";

type Entity = { id: string; name: string };
type User = {
  id: string;
  email: string;
  displayName: string | null;
  role: AppRole;
  active: boolean;
  createdAt: string | null;
  entities: { id: string; name: string | null; accessLevel: EntityAccessLevel }[];
};

// Collaborator classifications. Accountant/Business Partner capability is
const COLLAB_ROLES: { value: AppRole; label: string }[] = [
  { value: "business_partner", label: "Business Partner" },
  { value: "accountant", label: "Accountant" },
];

function isOwnerRole(role: AppRole): boolean {
  return role === "owner" || role === "admin";
}

/** One-time credential banner — shown after a create/reset, never persisted. */
function TempPasswordNotice({
  notice,
  onDismiss,
}: {
  notice: { email: string; password: string };
  onDismiss: () => void;
}) {
  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm dark:border-amber-400/30 dark:bg-amber-400/10">
      <div className="font-medium text-amber-900 dark:text-amber-200">
        Temporary password for {notice.email}
      </div>
      <div className="mt-1 flex items-center gap-3">
        <code className="rounded bg-white px-2 py-1 font-mono text-amber-900 ring-1 ring-amber-200 dark:bg-black/40 dark:text-amber-200 dark:ring-amber-400/30">
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
      <p className="mt-1.5 text-xs text-amber-800 dark:text-amber-200/80">
        Shown once — share it securely. They can change it after signing in.
      </p>
    </div>
  );
}

/** Role classification picker (Accountant / Business Partner). */
function RolePicker({
  role,
  onChange,
}: {
  role: AppRole;
  onChange: (r: AppRole) => void;
}) {
  return (
    <div className="flex gap-2">
      {COLLAB_ROLES.map((r) => (
        <button
          key={r.value}
          type="button"
          onClick={() => onChange(r.value)}
          className={`rounded-md border px-3 py-1.5 text-sm transition-colors ${
            role === r.value
              ? "border-foreground bg-foreground text-background"
              : "border-hair hover:bg-paper"
          }`}
        >
          {r.label}
        </button>
      ))}
    </div>
  );
}

/** Per-entity None / Read-only / Read & write picker. `levels` omits no-access. */
function EntityLevelPicker({
  entities,
  levels,
  onSet,
}: {
  entities: Entity[];
  levels: Map<string, EntityAccessLevel>;
  onSet: (id: string, level: EntityAccessLevel | "none") => void;
}) {
  return (
    <div className="space-y-1">
      {entities.map((e) => {
        const value = levels.get(e.id) ?? "none";
        return (
          <div
            key={e.id}
            className="flex items-center justify-between gap-3 rounded px-1.5 py-1 text-sm hover:bg-paper"
          >
            <span className="truncate">{e.name}</span>
            <select
              value={value}
              onChange={(ev) => onSet(e.id, ev.target.value as EntityAccessLevel | "none")}
              className="shrink-0 rounded-md border border-hair bg-background px-2 py-1 text-xs"
            >
              <option value="none">No access</option>
              <option value="read">Read-only</option>
              <option value="write">Read &amp; write</option>
            </select>
          </div>
        );
      })}
    </div>
  );
}

function grantsFrom(levels: Map<string, EntityAccessLevel>) {
  return [...levels.entries()].map(([entityId, accessLevel]) => ({
    entityId,
    accessLevel,
  }));
}

function useLevels(initial?: { id: string; accessLevel: EntityAccessLevel }[]) {
  const [levels, setLevels] = useState<Map<string, EntityAccessLevel>>(
    () => new Map((initial ?? []).map((g) => [g.id, g.accessLevel]))
  );
  const set = (id: string, level: EntityAccessLevel | "none") =>
    setLevels((prev) => {
      const next = new Map(prev);
      if (level === "none") next.delete(id);
      else next.set(id, level);
      return next;
    });
  return { levels, set, setLevels };
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
  const [role, setRole] = useState<AppRole>("business_partner");
  const { levels, set, setLevels } = useLevels();
  const [pending, startTransition] = useTransition();

  function reset() {
    setEmail("");
    setName("");
    setRole("business_partner");
    setLevels(new Map());
  }

  function submit() {
    if (!email.trim()) {
      toast.error("Email is required.");
      return;
    }
    if (levels.size === 0) {
      toast.error("Give them read or write access to at least one entity.");
      return;
    }
    startTransition(async () => {
      try {
        const res = await createUserAction({
          email: email.trim(),
          displayName: name,
          role,
          entityGrants: grantsFrom(levels),
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
      } catch (e) {
        // The write may have still succeeded; surface the error and let the admin
        // refresh — never leave the button stuck on "Adding…".
        toast.error(
          e instanceof Error ? e.message : "Something went wrong — refresh and check the list."
        );
      }
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
            placeholder="Jane Smith"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
      </div>

      <div className="space-y-2">
        <Label>Role</Label>
        <RolePicker role={role} onChange={setRole} />
      </div>

      <div className="space-y-2">
        <Label>Entity access</Label>
        <p className="text-xs text-muted-foreground">
          Choose per entity. Read-only can view everything; read &amp; write can
          make bookkeeping changes (all logged for your review).
        </p>
        <EntityLevelPicker entities={entities} levels={levels} onSet={set} />
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

function levelBadge(level: EntityAccessLevel) {
  return level === "write" ? "read/write" : "read-only";
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
  const owner = isOwnerRole(user.role);
  const [editing, setEditing] = useState(false);
  const [role, setRole] = useState<AppRole>(
    isOwnerRole(user.role) ? "business_partner" : user.role
  );
  const { levels, set, setLevels } = useLevels(user.entities);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [pending, startTransition] = useTransition();

  function run(fn: () => Promise<{ ok: boolean; error?: string }>, done?: string) {
    startTransition(async () => {
      try {
        const res = await fn();
        if (!res.ok) toast.error(res.error ?? "Something went wrong.");
        else if (done) toast.success(done);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Something went wrong.");
      }
    });
  }

  function saveAccess() {
    if (levels.size === 0) {
      toast.error("Give them access to at least one entity (or remove the user).");
      return;
    }
    startTransition(async () => {
      try {
        if (role !== user.role) {
          const r = await setRoleAction(user.id, role);
          if (!r.ok) {
            toast.error(r.error ?? "Could not change the role.");
            return;
          }
        }
        const r2 = await setEntityLevelsAction(user.id, grantsFrom(levels));
        if (!r2.ok) {
          toast.error(r2.error ?? "Could not save entity access.");
          return;
        }
        toast.success("Access updated");
        setEditing(false);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not save — refresh and check.");
      }
    });
  }

  return (
    <div className={`rounded-lg border border-hair p-4 ${user.active ? "" : "opacity-60"}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium">{user.displayName || user.email}</span>
            {owner ? (
              <Badge variant="secondary">Owner — full access</Badge>
            ) : (
              <>
                <Badge variant="outline">
                  {COLLAB_ROLES.find((r) => r.value === user.role)?.label ?? "Collaborator"}
                </Badge>
                <Badge variant="outline">
                  {user.entities.length}{" "}
                  {user.entities.length === 1 ? "entity" : "entities"}
                </Badge>
              </>
            )}
            {!user.active && <Badge variant="destructive">Deactivated</Badge>}
          </div>
          {user.displayName && (
            <div className="text-sm text-muted-foreground">{user.email}</div>
          )}
          {!owner && user.entities.length > 0 && !editing && (
            <div className="mt-1 text-xs text-faint">
              {user.entities
                .map((e) => `${e.name} (${levelBadge(e.accessLevel)})`)
                .join(" · ")}
            </div>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap gap-1.5">
          {!owner && (
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => {
                setEditing((v) => !v);
                setRole(user.role);
                setLevels(new Map(user.entities.map((e) => [e.id, e.accessLevel])));
              }}
            >
              {editing ? "Cancel" : "Edit access"}
            </Button>
          )}
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

      {editing && !owner && (
        <div className="mt-4 space-y-3 border-t border-hair pt-4">
          <div className="space-y-2">
            <Label>Role</Label>
            <RolePicker role={role} onChange={setRole} />
          </div>
          <div className="space-y-2">
            <Label>Entity access</Label>
            <EntityLevelPicker entities={entities} levels={levels} onSet={set} />
          </div>
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
          <span className="font-medium text-foreground">Add user</span> to give an
          accountant or business partner read or read/write access to the entities
          you choose.
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
