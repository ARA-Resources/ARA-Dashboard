"use client";

import Link from "next/link";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronDown } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface SidebarLinkProps {
  href?: string;
  label: string;
  icon: LucideIcon;
  active?: boolean;
  collapsed?: boolean;
  nested?: boolean;
  deeplyNested?: boolean;
  onClick?: () => void;
  variant?: "default" | "destructive";
  badge?: string;
}

export function SidebarLink({
  href,
  label,
  icon: Icon,
  active = false,
  collapsed = false,
  nested = false,
  deeplyNested = false,
  onClick,
  variant = "default",
  badge,
}: SidebarLinkProps) {
  const className = cn(
    "group flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors",
    collapsed && "justify-center px-2",
    nested && !collapsed && "pl-4",
    deeplyNested && !collapsed && "pl-7",
    variant === "destructive" && !active
      ? "text-destructive hover:bg-destructive/10 hover:text-destructive"
      : active
        ? "bg-primary/10 text-primary"
        : "text-muted-foreground hover:bg-accent hover:text-foreground"
  );

  const content = (
    <>
      <Icon
        className={cn(
          "size-4 shrink-0",
          active
            ? "text-primary"
            : variant === "destructive"
              ? "text-destructive"
              : "text-muted-foreground group-hover:text-foreground dark:text-white"
        )}
      />
      {!collapsed && <span className="min-w-0 flex-1 truncate">{label}</span>}
      {!collapsed && badge ? (
        <span className="shrink-0 rounded-md bg-ara-highlight/15 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-ara-highlight">
          {badge}
        </span>
      ) : null}
    </>
  );

  const node = href ? (
    <Link
      href={href}
      onClick={(event) => {
        if (onClick) {
          event.preventDefault();
          onClick();
        }
      }}
      className={className}
    >
      {content}
    </Link>
  ) : (
    <button type="button" onClick={onClick} className={className}>
      {content}
    </button>
  );

  if (!collapsed) return node;

  return (
    <Tooltip>
      <TooltipTrigger render={<div className="w-full" />}>{node}</TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}

interface SidebarExpandableProps {
  label: string;
  icon: LucideIcon;
  expanded: boolean;
  active?: boolean;
  collapsed?: boolean;
  nested?: boolean;
  deeplyNested?: boolean;
  badge?: string;
  onToggle: () => void;
  children?: React.ReactNode;
}

/**
 * Expandable sidebar parent (Company, Accenture, Lateral, …).
 * Click expands/collapses — parents may also navigate via onToggle.
 */
export function SidebarExpandable({
  label,
  icon: Icon,
  expanded,
  active = false,
  collapsed = false,
  nested = false,
  deeplyNested = false,
  badge,
  onToggle,
  children,
}: SidebarExpandableProps) {
  const buttonClass = cn(
    "group flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors",
    collapsed && "justify-center px-2",
    nested && !collapsed && "pl-4",
    deeplyNested && !collapsed && "pl-7",
    active
      ? "bg-primary/10 text-primary"
      : "text-muted-foreground hover:bg-accent hover:text-foreground"
  );

  const trigger = (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      aria-label={expanded ? `Collapse ${label}` : `Expand ${label}`}
      className={buttonClass}
    >
      <Icon
        className={cn(
          "size-4 shrink-0",
          active ? "text-primary" : "text-muted-foreground dark:text-white"
        )}
      />
      {!collapsed && (
        <>
          <span className="flex-1 truncate text-left">{label}</span>
          {badge ? (
            <span className="shrink-0 rounded-md bg-ara-highlight/15 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-ara-highlight">
              {badge}
            </span>
          ) : null}
          <motion.span
            animate={{ rotate: expanded ? 180 : 0 }}
            transition={{ duration: 0.2 }}
            className="flex"
          >
            <ChevronDown className="size-4" />
          </motion.span>
        </>
      )}
    </button>
  );

  return (
    <div className="w-full">
      {collapsed ? (
        <Tooltip>
          <TooltipTrigger render={<div className="w-full" />}>
            <button
              type="button"
              className={buttonClass}
              onClick={onToggle}
              aria-expanded={expanded}
              aria-label={expanded ? `Collapse ${label}` : `Expand ${label}`}
            >
              <Icon
                className={cn(
                  "size-4 shrink-0",
                  active
                    ? "text-primary"
                    : "text-muted-foreground dark:text-white"
                )}
              />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">{label}</TooltipContent>
        </Tooltip>
      ) : (
        trigger
      )}

      <AnimatePresence initial={false}>
        {expanded && !collapsed && children ? (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            className="overflow-hidden"
          >
            <div className="mt-0.5 ml-4 space-y-0.5 border-l border-border/70 pl-1">
              {children}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
