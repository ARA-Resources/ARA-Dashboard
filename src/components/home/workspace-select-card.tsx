"use client";

import { motion } from "framer-motion";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

interface WorkspaceSelectCardProps {
  title: string;
  description: string;
  buttonLabel: string;
  icon: LucideIcon;
  onSelect: () => void;
  featured?: boolean;
  className?: string;
}

export function WorkspaceSelectCard({
  title,
  description,
  buttonLabel,
  icon: Icon,
  onSelect,
  featured = false,
  className,
}: WorkspaceSelectCardProps) {
  return (
    <motion.button
      type="button"
      onClick={onSelect}
      whileHover={{ y: -6, scale: 1.01 }}
      whileTap={{ scale: 0.985 }}
      transition={{ type: "spring", stiffness: 320, damping: 22 }}
      className={cn(
        "group relative flex w-full flex-col rounded-2xl border border-border/60 p-6 text-left shadow-sm outline-none transition-[box-shadow,border-color,background-color] duration-300",
        "bg-white/70 backdrop-blur-xl dark:bg-card/80",
        "hover:border-primary/40 hover:shadow-[0_12px_40px_-12px_rgba(142,36,170,0.45)]",
        "focus-visible:ring-2 focus-visible:ring-primary/40",
        featured && "ring-1 ring-primary/25",
        className
      )}
    >
      <div className="mb-5 flex size-12 items-center justify-center rounded-xl bg-primary/10 text-primary transition-colors group-hover:bg-primary/15">
        <Icon className="size-6" />
      </div>

      <h2 className="mb-2 text-xl font-semibold tracking-tight text-primary">
        {title}
      </h2>
      <p className="mb-6 flex-1 text-sm leading-relaxed text-muted-foreground">
        {description}
      </p>

      <span className="inline-flex h-9 w-full items-center justify-center rounded-xl bg-ara-button text-sm font-medium text-white transition-colors group-hover:bg-ara-button/90">
        {buttonLabel}
      </span>
    </motion.button>
  );
}
