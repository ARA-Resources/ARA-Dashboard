"use client";

import Image from "next/image";
import Link from "next/link";
import { SIDEBAR } from "@/constants/sidebar";
import { ROUTES } from "@/constants/routes";
import { cn } from "@/lib/utils";

interface SidebarBrandProps {
  collapsed?: boolean;
}

export function SidebarBrand({ collapsed = false }: SidebarBrandProps) {
  return (
    <Link
      href={ROUTES.homePage}
      aria-label="ARA Dashboard Home"
      className={cn(
        "flex items-center gap-3 rounded-lg px-2 py-2 transition-opacity hover:opacity-90",
        collapsed && "justify-center px-0"
      )}
    >
      <Image
        src={SIDEBAR.logoPath}
        alt="ARA"
        width={36}
        height={36}
        className="size-9 shrink-0 rounded-md object-contain"
        priority
      />
      {!collapsed && (
        <p className="min-w-0 truncate text-sm font-semibold tracking-tight text-foreground">
          {SIDEBAR.brandName}
        </p>
      )}
    </Link>
  );
}
