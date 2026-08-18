"use client";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type {
  AllocationPriority,
  AllocationStatus,
} from "@/data/mock/lateral-allocations.mock";

const STATUS_STYLES: Record<AllocationStatus, string> = {
  Allocated: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  Partial: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
  Unallocated: "bg-rose-500/10 text-rose-700 dark:text-rose-300",
};

interface AllocationStatusBadgeProps {
  status: AllocationStatus;
  className?: string;
}

export function AllocationStatusBadge({
  status,
  className,
}: AllocationStatusBadgeProps) {
  return (
    <Badge
      variant="secondary"
      className={cn("rounded-md font-medium", STATUS_STYLES[status], className)}
    >
      {status}
    </Badge>
  );
}

interface AllocationPriorityBadgeProps {
  priority: AllocationPriority;
  className?: string;
}

export function AllocationPriorityBadge({
  priority,
  className,
}: AllocationPriorityBadgeProps) {
  return (
    <Badge variant="outline" className={cn("rounded-md", className)}>
      {priority}
    </Badge>
  );
}
