"use client";

import * as React from "react";
import { ChevronDown, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { SkillCluster } from "@/types/skill-clusters";
import {
  hasOpeningRecruiterOverride,
  resolveEffectiveRecruiter,
} from "@/services/excel/resolve-recruiter-assignment";
import { cn } from "@/lib/utils";

const INHERIT = "__inherit__";
const UNASSIGNED = "__unassigned__";
const PAGE_SIZE = 15;

interface SkillClusterRowProps {
  cluster: SkillCluster;
  siblingClusters: SkillCluster[];
  assignments: Record<string, string>;
  onReassign: (openingId: string, clusterId: string) => void;
  recruiterOptions: string[];
  clusterAssignments: Record<string, string>;
  openingOverrides: Record<string, string>;
  onAssignClusterRecruiter: (clusterId: string, recruiter: string | null) => void;
  onAssignOpeningRecruiter: (openingId: string, recruiter: string | null) => void;
  onClearOpeningOverride: (openingId: string) => void;
  className?: string;
}

export const SkillClusterRow = React.memo(function SkillClusterRow({
  cluster,
  siblingClusters,
  assignments,
  onReassign,
  recruiterOptions,
  clusterAssignments,
  openingOverrides,
  onAssignClusterRecruiter,
  onAssignOpeningRecruiter,
  onClearOpeningOverride,
  className,
}: SkillClusterRowProps) {
  const [showOpenings, setShowOpenings] = React.useState(false);
  const [visibleCount, setVisibleCount] = React.useState(PAGE_SIZE);

  const confidencePct = Math.round(cluster.confidenceScore * 100);
  const previewIds = cluster.openingIds.slice(0, 6);

  const reassignedCount = React.useMemo(
    () =>
      cluster.members.reduce((count, member) => {
        const assigned = assignments[member.openingId];
        return assigned && assigned !== member.recommendedClusterId
          ? count + 1
          : count;
      }, 0),
    [assignments, cluster.members]
  );

  const clusterRecruiter = clusterAssignments[cluster.id] ?? null;

  const overrideCount = React.useMemo(
    () =>
      cluster.members.reduce(
        (count, member) =>
          hasOpeningRecruiterOverride(member.openingId, openingOverrides)
            ? count + 1
            : count,
        0
      ),
    [cluster.members, openingOverrides]
  );

  const visibleMembers = showOpenings
    ? cluster.members.slice(0, visibleCount)
    : [];

  return (
    <div
      className={cn(
        "space-y-3 rounded-xl border border-border/70 bg-background/80 px-3 py-3",
        className
      )}
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <p className="text-sm font-semibold text-foreground">{cluster.name}</p>
          <p className="text-xs text-muted-foreground">
            {cluster.totalOpenings} openings · confidence {confidencePct}%
            {reassignedCount > 0
              ? ` · ${reassignedCount} manual reassignment${reassignedCount === 1 ? "" : "s"}`
              : ""}
            {overrideCount > 0
              ? ` · ${overrideCount} recruiter override${overrideCount === 1 ? "" : "s"}`
              : ""}
          </p>
        </div>
        <Badge variant="secondary" className="rounded-md">
          {confidencePct}% match
        </Badge>
      </div>

      <div className="grid gap-2 text-xs sm:grid-cols-2">
        <div>
          <p className="mb-1 font-medium text-primary">Must Have (common)</p>
          <div className="flex flex-wrap gap-1">
            {cluster.mustHaveSkills.length > 0 ? (
              cluster.mustHaveSkills.slice(0, 8).map((skill) => (
                <span
                  key={`must-${skill.normalized}`}
                  className="rounded-md bg-muted px-1.5 py-0.5 text-foreground/80"
                  title={skill.normalized}
                >
                  {skill.original}
                </span>
              ))
            ) : (
              <span className="italic text-muted-foreground">None shared</span>
            )}
          </div>
        </div>
        <div>
          <p className="mb-1 font-medium text-primary">Good to Have (common)</p>
          <div className="flex flex-wrap gap-1">
            {cluster.goodToHaveSkills.length > 0 ? (
              cluster.goodToHaveSkills.slice(0, 8).map((skill) => (
                <span
                  key={`good-${skill.normalized}`}
                  className="rounded-md bg-muted px-1.5 py-0.5 text-foreground/80"
                  title={skill.normalized}
                >
                  {skill.original}
                </span>
              ))
            ) : (
              <span className="italic text-muted-foreground">None shared</span>
            )}
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-2 rounded-lg border border-border/50 bg-muted/20 px-2.5 py-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 text-xs">
          <p className="flex items-center gap-1.5 font-medium text-foreground">
            <Users className="size-3.5 shrink-0 text-primary" />
            Cluster recruiter
          </p>
          <p className="mt-0.5 text-muted-foreground">
            Applies to all openings unless an opening override is set.
          </p>
        </div>
        <Select
          value={clusterRecruiter ?? UNASSIGNED}
          onValueChange={(value) => {
            onAssignClusterRecruiter(
              cluster.id,
              !value || value === UNASSIGNED ? null : value
            );
          }}
        >
          <SelectTrigger
            className="h-8 w-full rounded-lg sm:w-56"
            aria-label={`Assign recruiter for ${cluster.name}`}
          >
            <SelectValue placeholder="Assign recruiter" />
          </SelectTrigger>
          <SelectContent className="rounded-xl">
            <SelectItem value={UNASSIGNED}>Unassigned</SelectItem>
            {recruiterOptions.map((name) => (
              <SelectItem key={name} value={name}>
                {name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <p className="text-xs font-medium text-muted-foreground">
          Opening IDs
        </p>
        <div className="flex flex-wrap gap-1">
          {previewIds.map((id) => (
            <Badge key={id} variant="outline" className="rounded-md font-normal">
              {id}
            </Badge>
          ))}
          {cluster.openingIds.length > previewIds.length ? (
            <Badge variant="outline" className="rounded-md font-normal">
              +{cluster.openingIds.length - previewIds.length} more
            </Badge>
          ) : null}
        </div>
      </div>

      <button
        type="button"
        className="flex w-full items-center justify-between rounded-lg border border-border/60 px-2.5 py-2 text-left text-xs font-medium text-foreground hover:bg-muted/40"
        onClick={() => {
          setShowOpenings((prev) => {
            if (prev) setVisibleCount(PAGE_SIZE);
            return !prev;
          });
        }}
      >
        <span>
          {showOpenings ? "Hide" : "Manage"} openings ({cluster.totalOpenings})
        </span>
        <ChevronDown
          className={cn(
            "size-3.5 text-muted-foreground transition-transform",
            showOpenings && "rotate-180"
          )}
        />
      </button>

      {showOpenings ? (
        <div className="max-h-72 space-y-1.5 overflow-y-auto overscroll-contain pr-0.5">
          {visibleMembers.map((member) => {
            const currentClusterId = assignments[member.openingId] ?? cluster.id;
            const isOverride = hasOpeningRecruiterOverride(
              member.openingId,
              openingOverrides
            );
            const effectiveRecruiter = resolveEffectiveRecruiter(
              member.openingId,
              cluster.id,
              clusterAssignments,
              openingOverrides
            );
            const overrideValue = openingOverrides[member.openingId];
            const recruiterSelectValue = isOverride
              ? overrideValue?.trim()
                ? overrideValue
                : UNASSIGNED
              : clusterRecruiter
                ? INHERIT
                : UNASSIGNED;

            return (
              <div
                key={member.openingId}
                className="flex flex-col gap-1.5 rounded-lg border border-border/50 px-2.5 py-2"
              >
                <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0 text-xs">
                    <p className="truncate font-medium">{member.openingId}</p>
                    <p className="text-muted-foreground">
                      Fit {Math.round(member.similarityToCluster * 100)}%
                    </p>
                  </div>
                  {siblingClusters.length > 1 ? (
                    <Select
                      value={currentClusterId}
                      onValueChange={(value) => {
                        if (value) onReassign(member.openingId, value);
                      }}
                    >
                      <SelectTrigger className="h-8 w-full rounded-lg sm:w-52">
                        <SelectValue placeholder="Assign cluster" />
                      </SelectTrigger>
                      <SelectContent className="rounded-xl">
                        {siblingClusters.map((option) => (
                          <SelectItem key={option.id} value={option.id}>
                            {option.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : null}
                </div>

                <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between">
                  <p className="text-[11px] text-muted-foreground">
                    Recruiter
                    {isOverride ? (
                      <span className="ml-1 text-primary">· override</span>
                    ) : effectiveRecruiter ? (
                      <span className="ml-1">· inherited</span>
                    ) : (
                      <span className="ml-1 italic">· unassigned</span>
                    )}
                  </p>
                  <div className="flex w-full items-center gap-1.5 sm:w-auto">
                    <Select
                      value={recruiterSelectValue}
                      onValueChange={(value) => {
                        if (!value || value === INHERIT) {
                          onClearOpeningOverride(member.openingId);
                          return;
                        }
                        if (value === UNASSIGNED) {
                          if (clusterRecruiter) {
                            onAssignOpeningRecruiter(member.openingId, "");
                          } else {
                            onClearOpeningOverride(member.openingId);
                          }
                          return;
                        }
                        if (value === clusterRecruiter) {
                          onClearOpeningOverride(member.openingId);
                        } else {
                          onAssignOpeningRecruiter(member.openingId, value);
                        }
                      }}
                    >
                      <SelectTrigger className="h-8 w-full rounded-lg sm:w-52">
                        <SelectValue placeholder="Recruiter" />
                      </SelectTrigger>
                      <SelectContent className="rounded-xl">
                        {clusterRecruiter ? (
                          <SelectItem value={INHERIT}>
                            Inherit ({clusterRecruiter})
                          </SelectItem>
                        ) : null}
                        <SelectItem value={UNASSIGNED}>Unassigned</SelectItem>
                        {recruiterOptions.map((name) => (
                          <SelectItem key={name} value={name}>
                            {name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {isOverride ? (
                      <button
                        type="button"
                        className="shrink-0 text-[11px] font-medium text-primary hover:underline"
                        onClick={() => onClearOpeningOverride(member.openingId)}
                      >
                        Reset
                      </button>
                    ) : null}
                  </div>
                </div>
              </div>
            );
          })}

          {visibleCount < cluster.members.length ? (
            <button
              type="button"
              className="w-full rounded-lg border border-dashed border-border px-2 py-2 text-xs font-medium text-primary hover:bg-muted/30"
              onClick={() =>
                setVisibleCount((count) =>
                  Math.min(count + PAGE_SIZE, cluster.members.length)
                )
              }
            >
              Show more ({cluster.members.length - visibleCount} remaining)
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});
