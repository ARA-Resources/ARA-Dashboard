"use client";

import * as React from "react";
import { Menu, PanelLeftClose, PanelLeftOpen, Search } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { useSidebar } from "@/hooks/use-sidebar";
import { NavbarBrand } from "@/components/navbar/navbar-brand";
import { GlobalSearch } from "@/components/navbar/global-search";
import { ThemeToggle } from "@/components/navbar/theme-toggle";
import { NotificationsButton } from "@/components/navbar/notifications-button";
import { ProfileMenu } from "@/components/navbar/profile-menu";
import { Button } from "@/components/ui/button";
import { NAVBAR } from "@/constants/navbar";
import { cn } from "@/lib/utils";

interface AppNavbarProps {
  className?: string;
}

export function AppNavbar({ className }: AppNavbarProps) {
  const { collapsed, toggleCollapsed, setMobileOpen } = useSidebar();
  const [mobileSearchOpen, setMobileSearchOpen] = React.useState(false);

  return (
    <motion.header
      initial={{ y: -12, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
      style={{ height: NAVBAR.height }}
      className={cn(
        "sticky top-0 z-40 flex w-full shrink-0 items-center border-b border-border bg-background/85 px-3 backdrop-blur-xl md:px-4",
        className
      )}
    >
      <div className="mx-auto grid h-full w-full grid-cols-[auto_1fr_auto] items-center gap-2 md:grid-cols-[minmax(0,1fr)_minmax(0,28rem)_minmax(0,1fr)] md:gap-4">
        {/* Left — brand + sidebar controls */}
        <div className="flex min-w-0 items-center gap-1.5 md:gap-2">
          <Button
            variant="ghost"
            size="icon"
            className="md:hidden"
            aria-label="Open menu"
            onClick={() => setMobileOpen(true)}
          >
            <Menu className="size-4" />
          </Button>

          <Button
            variant="ghost"
            size="icon"
            className="hidden md:inline-flex"
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            onClick={toggleCollapsed}
          >
            {collapsed ? (
              <PanelLeftOpen className="size-4" />
            ) : (
              <PanelLeftClose className="size-4" />
            )}
          </Button>

          <NavbarBrand />
        </div>

        {/* Center — global search (desktop) */}
        <div className="hidden md:block">
          <GlobalSearch />
        </div>

        {/* Right — actions */}
        <div className="flex items-center justify-end gap-0.5 sm:gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="md:hidden"
            aria-label="Open search"
            onClick={() => setMobileSearchOpen(true)}
          >
            <Search className="size-4" />
          </Button>

          <ThemeToggle />
          <NotificationsButton />
          <ProfileMenu />
        </div>
      </div>

      {/* Mobile search overlay row */}
      <AnimatePresence>
        {mobileSearchOpen ? (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.2 }}
            className="absolute inset-x-0 top-0 z-50 flex h-16 items-center gap-2 border-b border-border bg-background px-3 md:hidden"
          >
            <GlobalSearch
              className="flex-1"
              onClose={() => setMobileSearchOpen(false)}
            />
          </motion.div>
        ) : null}
      </AnimatePresence>
    </motion.header>
  );
}
