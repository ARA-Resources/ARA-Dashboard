"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { SidebarNavItem } from "@/types/navigation";
import { isNavHrefActive } from "@/constants/navigation";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface SidebarNavItemProps {
  item: SidebarNavItem;
  collapsed?: boolean;
  siblingHrefs?: readonly string[];
  onNavigate?: () => void;
}

export function SidebarNavItemLink({
  item,
  collapsed = false,
  siblingHrefs = [],
  onNavigate,
}: SidebarNavItemProps) {
  const pathname = usePathname();
  const active = isNavHrefActive(pathname, item.href, siblingHrefs);
  const Icon = item.icon;

  const className = cn(
    "group flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors",
    collapsed && "justify-center px-2",
    active
      ? "bg-primary/10 text-primary"
      : "text-muted-foreground hover:bg-accent hover:text-foreground",
    item.disabled && "pointer-events-none opacity-50"
  );

  const iconClassName = cn(
    "size-[18px] shrink-0",
    active
      ? "text-primary"
      : "text-muted-foreground group-hover:text-foreground dark:text-white"
  );

  const content = (
    <>
      <Icon className={iconClassName} />
      {!collapsed && <span className="truncate">{item.label}</span>}
    </>
  );

  if (collapsed) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <Link
              href={item.disabled ? "#" : item.href}
              onClick={onNavigate}
              aria-disabled={item.disabled}
              className={className}
            />
          }
        >
          {content}
        </TooltipTrigger>
        <TooltipContent side="right">{item.label}</TooltipContent>
      </Tooltip>
    );
  }

  return (
    <Link
      href={item.disabled ? "#" : item.href}
      onClick={onNavigate}
      aria-disabled={item.disabled}
      className={className}
    >
      {content}
    </Link>
  );
}
