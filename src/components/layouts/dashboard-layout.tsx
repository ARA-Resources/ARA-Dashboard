"use client";

import { AppSidebar } from "@/components/sidebar/app-sidebar";
import { AppNavbar } from "@/components/navbar/app-navbar";
import { useSidebar } from "@/hooks/use-sidebar";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

interface DashboardLayoutProps {
  children: React.ReactNode;
  className?: string;
}

export function DashboardLayout({
  children,
  className,
}: DashboardLayoutProps) {
  const { mobileOpen, setMobileOpen } = useSidebar();

  return (
    <div className="flex h-svh w-full flex-col overflow-hidden bg-background">
      <AppNavbar />

      <div className="flex min-h-0 flex-1">
        <div className="hidden md:flex">
          <AppSidebar />
        </div>

        <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
          <SheetContent
            side="left"
            className="w-[260px] border-r border-border bg-sidebar p-0"
          >
            <SheetHeader className="sr-only">
              <SheetTitle>Navigation</SheetTitle>
            </SheetHeader>
            <AppSidebar className="w-full border-r-0" forceExpanded />
          </SheetContent>
        </Sheet>

        <main
          className={cn(
            "min-w-0 flex-1 overflow-y-auto p-4 md:p-6",
            className
          )}
        >
          {children}
        </main>
      </div>
    </div>
  );
}
