"use client";

import * as React from "react";
import { ChevronDown } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { SkillClusterRow } from "@/components/dashboard/accenture/allocations/skill-cluster-row";
import type { PrimarySkillClusterGroup } from "@/types/skill-clusters";
import { cn } from "@/lib/utils";

interface PrimarySkillCardProps {
  group: PrimarySkillClusterGroup;
  assignments: Record<string, string>;
  onReassign: (openingId: string, clusterId: string) => void;
  recruiterOptions: string[];
  clusterAssignments: Record<string, string>;
  openingOverrides: Record<string, string>;
  onAssignClusterRecruiter: (clusterId: string, recruiter: string | null) => void;
  onAssignOpeningRecruiter: (openingId: string, recruiter: string | null) => void;
  onClearOpeningOverride: (openingId: string) => void;
  defaultOpen?: boolean;
  className?: string;
}

export const PrimarySkillCard = React.memo(function PrimarySkillCard({
  group,
  assignments,
  onReassign,
  recruiterOptions,
  clusterAssignments,
  openingOverrides,
  onAssignClusterRecruiter,
  onAssignOpeningRecruiter,
  onClearOpeningOverride,
  defaultOpen = false,
  className,
}: PrimarySkillCardProps) {
  const [open, setOpen] = React.useState(defaultOpen);

  if (!group?.clusters) return null;

  const avgConfidence =
    group.clusters.length === 0
      ? 0
      : group.clusters.reduce(
          (sum, cluster) => sum + cluster.confidenceScore,
          0
        ) / group.clusters.length;

  return (
    <div
      className={cn(
        "overflow-hidden rounded-2xl border border-border bg-card shadow-sm",
        className
      )}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
        className="flex w-full items-start gap-3 px-4 py-3.5 text-left hover:bg-muted/40"
      >
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-base font-semibold text-primary">
              {group.primarySkill}
            </h3>
            {group.skillCategorization ? (
              <Badge variant="secondary" className="rounded-md">
                {group.skillCategorization}
              </Badge>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">
            {group.clusterCount} skill cluster
            {group.clusterCount === 1 ? "" : "s"} · {group.totalOpenings}{" "}
            openings · avg confidence {Math.round(avgConfidence * 100)}%
          </p>
        </div>
        <ChevronDown
          className={cn(
            "mt-1 size-4 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-180"
          )}
        />
      </button>

      {open ? (
        <div className="space-y-2 border-t border-border px-4 py-3">
          {group.clusters.map((cluster) => (
            <SkillClusterRow
              key={cluster.id}
              cluster={cluster}
              siblingClusters={group.clusters}
              assignments={assignments}
              onReassign={onReassign}
              recruiterOptions={recruiterOptions}
              clusterAssignments={clusterAssignments}
              openingOverrides={openingOverrides}
              onAssignClusterRecruiter={onAssignClusterRecruiter}
              onAssignOpeningRecruiter={onAssignOpeningRecruiter}
              onClearOpeningOverride={onClearOpeningOverride}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
});
