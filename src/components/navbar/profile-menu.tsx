"use client";

import { motion } from "framer-motion";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PROFILE_MENU } from "@/constants/navbar";
import { useNavigation } from "@/hooks/use-navigation";
import { useSidebar } from "@/hooks/use-sidebar";
import { useCurrentUser } from "@/hooks/use-current-user";
import { isSectionVisibleForRole } from "@/hooks/use-visible-nav-sections";
import { UserAvatar } from "@/components/navbar/user-avatar";
import type { WorkspaceId } from "@/constants/navigation";

export function ProfileMenu() {
  const { workspace, goToWorkspace } = useNavigation();
  const { setCollapsed } = useSidebar();
  const { user, role } = useCurrentUser();

  // Same role gating as the sidebar — UI convenience only (proxy.ts + DAL enforce).
  const navigateItems = PROFILE_MENU.filter(
    (item) =>
      item.action !== "logout" &&
      isSectionVisibleForRole(item.workspace, role)
  );
  const logoutItem = PROFILE_MENU.find((item) => item.action === "logout");
  const LogoutIcon = logoutItem?.icon;

  const email = user?.email ?? "";
  const displayName = user?.displayName ?? null;
  const name = displayName || email || "ARA User";

  function handleSelect(nextWorkspace: WorkspaceId) {
    setCollapsed(false);
    goToWorkspace(nextWorkspace);
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            aria-label="Profile menu"
            className="size-10 rounded-full p-0"
          />
        }
      >
        <motion.div
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.96 }}
          className="flex items-center justify-center"
        >
          <UserAvatar
            email={email}
            displayName={displayName}
            avatarColor={user?.avatarColor ?? null}
            className="size-9 ring-2 ring-primary/20"
          />
        </motion.div>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="font-normal">
            <div className="flex items-center gap-2.5">
              <UserAvatar
                email={email}
                displayName={displayName}
                avatarColor={user?.avatarColor ?? null}
                size="sm"
                className="size-8"
              />
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="truncate text-sm font-medium text-foreground">
                  {name}
                </span>
                <span className="truncate text-xs text-muted-foreground">
                  {email || "Not signed in"}
                  {user ? ` · ${role}` : ""}
                </span>
              </div>
            </div>
          </DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          {navigateItems.map((item) => {
            const Icon = item.icon;
            const active = workspace === item.workspace;
            return (
              <DropdownMenuItem
                key={item.id}
                onClick={() => handleSelect(item.workspace)}
                className="cursor-pointer gap-2"
                data-active={active || undefined}
              >
                <Icon className="size-4 text-primary" />
                <span className="flex-1">{item.label}</span>
                {active ? (
                  <span className="size-1.5 rounded-full bg-primary" />
                ) : null}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuGroup>
        {logoutItem && LogoutIcon ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onClick={() => handleSelect("logout")}
              className="cursor-pointer gap-2"
            >
              <LogoutIcon className="size-4" />
              <span>{logoutItem.label}</span>
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
