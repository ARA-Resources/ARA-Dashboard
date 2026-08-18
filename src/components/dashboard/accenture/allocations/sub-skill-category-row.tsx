"use client";

import { Users } from "lucide-react";
import {
  AllocationPriorityBadge,
  AllocationStatusBadge,
} from "@/components/dashboard/accenture/allocations/allocation-badges";
import type { AllocationSubSkillCategory } from "@/data/mock/lateral-allocations.mock";
import { cn } from "@/lib/utils";

interface SubSkillCategoryRowProps {
  category: AllocationSubSkillCategory;
  className?: string;
}

export function SubSkillCategoryRow({
  category,
  className,
}: SubSkillCategoryRowProps) {
  return (
    <div
      className={cn(
        "flex flex-col gap-2 rounded-xl border border-border/70 bg-background/80 px-3 py-3 sm:flex-row sm:items-center sm:justify-between",
        className
      )}
    >
      <div className="min-w-0 space-y-1">
        <p className="text-sm font-medium text-foreground">{category.name}</p>
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <Users className="size-3.5 shrink-0" />
          {category.recruiters.length > 0 ? (
            category.recruiters.map((name) => (
              <span
                key={name}
                className="rounded-md bg-muted px-1.5 py-0.5 text-foreground/80"
              >
                {name}
              </span>
            ))
          ) : (
            <span className="italic">No recruiter assigned</span>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 sm:justify-end">
        <AllocationStatusBadge status={category.status} />
        <AllocationPriorityBadge priority={category.priority} />
        <span className="text-xs text-muted-foreground">
          {category.roleCount} roles
        </span>
      </div>
    </div>
  );
}
