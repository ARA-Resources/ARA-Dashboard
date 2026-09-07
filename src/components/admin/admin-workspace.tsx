"use client";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useCurrentUser } from "@/hooks/use-current-user";
import { ManageUsers } from "@/components/admin/manage-users";

/**
 * Admin workspace body.
 *
 * The "Manage Users" section is rendered ONLY for super_admin. An admin (not
 * super_admin) sees the general admin card but not user management — and every
 * /api/admin/* endpoint is independently gated at super_admin server-side
 * (proxy.ts + authorizeRequest), so hiding the UI is convenience, not security.
 */
export function AdminWorkspace() {
  const { user, isSuperAdmin, isLoading } = useCurrentUser();

  return (
    <div className="flex flex-col gap-4">
      {isSuperAdmin ? (
        <ManageUsers />
      ) : (
        <Card className="shadow-sm">
          <CardHeader>
            <CardTitle>Admin</CardTitle>
            <CardDescription>
              Administration tools for admins and super admins.
            </CardDescription>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            {isLoading
              ? "Loading…"
              : user
                ? "User management is available to super admins only."
                : "Sign in to continue."}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
