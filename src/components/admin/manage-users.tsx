"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { apiFetch } from "@/lib/api/client";
import { ASSIGNABLE_ROLES } from "@/lib/auth/assignable-roles";
import { CURRENT_USER_QUERY_KEY } from "@/hooks/use-current-user";

type AdminUser = {
  id: string;
  email: string;
  role: string;
  active: boolean;
  displayName: string | null;
  lastLoginAt: string | null;
  createdAt: string;
  isSelf: boolean;
};

type AdminInvite = {
  email: string;
  role: string;
  status: "pending" | "used" | "expired";
  expiresAt: string;
  usedAt: string | null;
  createdAt: string;
  acceptUrl: string;
};

const USERS_KEY = ["admin", "users"] as const;
const INVITES_KEY = ["admin", "invites"] as const;

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
}

async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const data = (await res.json()) as { error?: string };
    return data.error || fallback;
  } catch {
    return fallback;
  }
}

/* ------------------------------- Users list ------------------------------- */

function UsersTable() {
  const queryClient = useQueryClient();
  const [rowError, setRowError] = React.useState<Record<string, string>>({});

  const usersQuery = useQuery({
    queryKey: USERS_KEY,
    queryFn: async (): Promise<AdminUser[]> => {
      const res = await apiFetch("/api/admin/users", { cache: "no-store" });
      if (!res.ok) throw new Error(await readError(res, "Failed to load users."));
      const data = (await res.json()) as { users: AdminUser[] };
      return data.users;
    },
    staleTime: 15_000,
  });

  const roleMutation = useMutation({
    mutationFn: async (vars: { id: string; role: string }) => {
      const res = await apiFetch(`/api/admin/users/${vars.id}/role`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: vars.role }),
      });
      if (!res.ok) throw new Error(await readError(res, "Could not change role."));
    },
    onSuccess: (_data, vars) => {
      setRowError((e) => ({ ...e, [vars.id]: "" }));
      void queryClient.invalidateQueries({ queryKey: USERS_KEY });
      void queryClient.invalidateQueries({ queryKey: CURRENT_USER_QUERY_KEY });
    },
    onError: (err: Error, vars) => {
      setRowError((e) => ({ ...e, [vars.id]: err.message }));
    },
  });

  const activeMutation = useMutation({
    mutationFn: async (vars: { id: string; active: boolean }) => {
      const res = await apiFetch(`/api/admin/users/${vars.id}/active`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: vars.active }),
      });
      if (!res.ok)
        throw new Error(await readError(res, "Could not update account status."));
    },
    onSuccess: (_data, vars) => {
      setRowError((e) => ({ ...e, [vars.id]: "" }));
      void queryClient.invalidateQueries({ queryKey: USERS_KEY });
    },
    onError: (err: Error, vars) => {
      setRowError((e) => ({ ...e, [vars.id]: err.message }));
    },
  });

  if (usersQuery.isLoading) {
    return <p className="text-sm text-muted-foreground">Loading users…</p>;
  }
  if (usersQuery.isError) {
    return (
      <p className="text-sm text-destructive">
        {(usersQuery.error as Error).message}
      </p>
    );
  }

  const users = usersQuery.data ?? [];
  const busyId =
    roleMutation.isPending
      ? roleMutation.variables?.id
      : activeMutation.isPending
        ? activeMutation.variables?.id
        : undefined;

  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>User</TableHead>
            <TableHead>Role</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Last login</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {users.map((u) => {
            const rowBusy = busyId === u.id;
            return (
              <TableRow key={u.id}>
                <TableCell>
                  <div className="flex flex-col">
                    <span className="font-medium text-foreground">
                      {u.displayName || u.email}
                    </span>
                    {u.displayName ? (
                      <span className="text-xs text-muted-foreground">
                        {u.email}
                      </span>
                    ) : null}
                    {u.isSelf ? (
                      <span className="text-xs text-primary">you</span>
                    ) : null}
                    {rowError[u.id] ? (
                      <span className="mt-1 text-xs text-destructive">
                        {rowError[u.id]}
                      </span>
                    ) : null}
                  </div>
                </TableCell>
                <TableCell>
                  {u.role === "viewer" || u.isSelf ? (
                    <Badge variant="secondary">{u.role}</Badge>
                  ) : (
                    <Select
                      value={u.role}
                      onValueChange={(role) => {
                        if (role) roleMutation.mutate({ id: u.id, role });
                      }}
                    >
                      <SelectTrigger className="h-8 w-[140px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {ASSIGNABLE_ROLES.map((r) => (
                          <SelectItem key={r} value={r}>
                            {r}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </TableCell>
                <TableCell>
                  <Badge variant={u.active ? "default" : "destructive"}>
                    {u.active ? "active" : "deactivated"}
                  </Badge>
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {fmtDate(u.lastLoginAt)}
                </TableCell>
                <TableCell className="text-right">
                  <Button
                    variant={u.active ? "outline" : "default"}
                    size="sm"
                    disabled={rowBusy || u.isSelf}
                    title={
                      u.isSelf
                        ? "You cannot deactivate your own account."
                        : undefined
                    }
                    onClick={() =>
                      activeMutation.mutate({ id: u.id, active: !u.active })
                    }
                  >
                    {u.active ? "Deactivate" : "Reactivate"}
                  </Button>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      <p className="mt-3 text-xs text-muted-foreground">
        Role changes and deactivation take effect within ~10s (no logout needed).
        <code className="ml-1">viewer</code> is assigned only by public signup.
      </p>
    </div>
  );
}

/* ------------------------------ Create invite ------------------------------ */

function CreateInvite() {
  const queryClient = useQueryClient();
  const [email, setEmail] = React.useState("");
  const [role, setRole] = React.useState<string>("editor");
  const [link, setLink] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);

  const mutation = useMutation({
    mutationFn: async () => {
      const res = await apiFetch("/api/admin/invites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), role }),
      });
      if (!res.ok) throw new Error(await readError(res, "Could not create invite."));
      return (await res.json()) as { invite: { acceptUrl: string } };
    },
    onSuccess: (data) => {
      setLink(data.invite.acceptUrl);
      setEmail("");
      setCopied(false);
      void queryClient.invalidateQueries({ queryKey: INVITES_KEY });
    },
  });

  async function copyLink() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        mutation.mutate();
      }}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <label className="flex flex-1 flex-col gap-1 text-sm">
          Email
          <Input
            type="email"
            required
            placeholder="person@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Role
          <Select
            value={role}
            onValueChange={(v) => setRole(v ?? "editor")}
          >
            <SelectTrigger className="h-9 w-[160px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ASSIGNABLE_ROLES.map((r) => (
                <SelectItem key={r} value={r}>
                  {r}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
        <Button type="submit" disabled={mutation.isPending}>
          {mutation.isPending ? "Creating…" : "Create invite"}
        </Button>
      </div>

      {mutation.isError ? (
        <p className="text-sm text-destructive">
          {(mutation.error as Error).message}
        </p>
      ) : null}

      {link ? (
        <div className="rounded-lg border border-border bg-muted/40 p-3">
          <p className="mb-1 text-xs font-medium text-muted-foreground">
            Invite link — copy and send it manually (no email is sent):
          </p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate text-xs">{link}</code>
            <Button type="button" size="sm" variant="outline" onClick={copyLink}>
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
        </div>
      ) : null}
    </form>
  );
}

/* ------------------------------ Invites list ------------------------------ */

function InvitesList() {
  const invitesQuery = useQuery({
    queryKey: INVITES_KEY,
    queryFn: async (): Promise<AdminInvite[]> => {
      const res = await apiFetch("/api/admin/invites", { cache: "no-store" });
      if (!res.ok)
        throw new Error(await readError(res, "Failed to load invites."));
      const data = (await res.json()) as { invites: AdminInvite[] };
      return data.invites;
    },
    staleTime: 15_000,
  });

  if (invitesQuery.isLoading) {
    return <p className="text-sm text-muted-foreground">Loading invites…</p>;
  }
  if (invitesQuery.isError) {
    return (
      <p className="text-sm text-destructive">
        {(invitesQuery.error as Error).message}
      </p>
    );
  }

  const invites = invitesQuery.data ?? [];
  if (invites.length === 0) {
    return <p className="text-sm text-muted-foreground">No invites yet.</p>;
  }

  const badgeVariant = (s: AdminInvite["status"]) =>
    s === "pending" ? "default" : s === "used" ? "secondary" : "destructive";

  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Email</TableHead>
            <TableHead>Role</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Expires</TableHead>
            <TableHead>Created</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {invites.map((inv) => (
            <TableRow key={`${inv.email}-${inv.createdAt}`}>
              <TableCell className="font-medium">{inv.email}</TableCell>
              <TableCell>
                <Badge variant="secondary">{inv.role}</Badge>
              </TableCell>
              <TableCell>
                <Badge variant={badgeVariant(inv.status)}>{inv.status}</Badge>
              </TableCell>
              <TableCell className="text-sm text-muted-foreground">
                {fmtDate(inv.expiresAt)}
              </TableCell>
              <TableCell className="text-sm text-muted-foreground">
                {fmtDate(inv.createdAt)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/* --------------------------------- Section --------------------------------- */

/**
 * Manage Users — super_admin only.
 *
 * UI convenience gate: the parent (admin page) only renders this for
 * super_admin. Real enforcement is proxy.ts + authorizeRequest on every
 * /api/admin/* endpoint (Phase 2/3). An admin who forces the API still gets 403.
 */
export function ManageUsers() {
  return (
    <div className="flex flex-col gap-4">
      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle>Users</CardTitle>
          <CardDescription>
            Everyone with an account. Change role or deactivate — you can&rsquo;t
            deactivate yourself.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <UsersTable />
        </CardContent>
      </Card>

      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle>Invite a teammate</CardTitle>
          <CardDescription>
            Creates a single-use link (7-day expiry). viewer accounts come from
            public signup, so only editor / admin / super_admin can be invited.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CreateInvite />
        </CardContent>
      </Card>

      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle>Invites</CardTitle>
          <CardDescription>Pending, used, and expired invites.</CardDescription>
        </CardHeader>
        <CardContent>
          <InvitesList />
        </CardContent>
      </Card>
    </div>
  );
}
