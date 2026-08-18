"use client";

import Image from "next/image";
import { motion } from "framer-motion";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { NAVBAR, PROFILE_MENU } from "@/constants/navbar";
import { useNavigation } from "@/hooks/use-navigation";
import { useSidebar } from "@/hooks/use-sidebar";
import type { WorkspaceId } from "@/constants/navigation";

export function ProfileMenu() {
  const { workspace, goToWorkspace } = useNavigation();
  const { setCollapsed } = useSidebar();

  const navigateItems = PROFILE_MENU.filter((item) => item.action !== "logout");
  const logoutItem = PROFILE_MENU.find((item) => item.action === "logout");
  const LogoutIcon = logoutItem?.icon;

  function handleSelect(nextWorkspace: WorkspaceId) {
    // Keep sidebar expanded so the activated section is visible
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
          <Avatar size="default" className="size-9 ring-2 ring-primary/20">
            <AvatarImage src={NAVBAR.logoPath} alt="ARA" />
            <AvatarFallback className="overflow-hidden bg-primary/10 p-0">
              <Image
                src={NAVBAR.logoPath}
                alt="ARA"
                width={36}
                height={36}
                className="size-full object-cover"
              />
            </AvatarFallback>
          </Avatar>
        </motion.div>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="font-normal">
            <div className="flex items-center gap-2.5">
              <Avatar size="sm" className="size-8 ring-1 ring-border">
                <AvatarImage src={NAVBAR.logoPath} alt="ARA" />
                <AvatarFallback className="overflow-hidden bg-primary/10 p-0">
                  <Image
                    src={NAVBAR.logoPath}
                    alt="ARA"
                    width={32}
                    height={32}
                    className="size-full object-cover"
                  />
                </AvatarFallback>
              </Avatar>
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="text-sm font-medium text-foreground">
                  ARA User
                </span>
                <span className="text-xs text-muted-foreground">
                  admin@ara.resources
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
