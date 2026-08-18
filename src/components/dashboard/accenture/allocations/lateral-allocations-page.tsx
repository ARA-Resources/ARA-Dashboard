"use client";

import * as React from "react";
import { RefreshCw } from "lucide-react";
import { PageHeader } from "@/components/layouts/page-header";
import { PageTransition } from "@/animations/page-transition";
import { FadeIn } from "@/animations/fade-in";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { AllocationsToolbar } from "@/components/dashboard/accenture/allocations/allocations-toolbar";
import { PrimarySkillCard } from "@/components/dashboard/accenture/allocations/primary-skill-card";
import { RecruiterWorkloadPanel } from "@/components/dashboard/accenture/allocations/recruiter-workload-summary";
import { useSkillClusters } from "@/hooks/use-skill-clusters";
import { useAllocationClusterStore } from "@/stores/allocation-cluster-store";
import { useAllocationRecruiterStore } from "@/stores/allocation-recruiter-store";
import { applyClusterAssignments } from "@/services/excel/apply-cluster-assignments";
import { applyRecruiterAssignments } from "@/services/excel/apply-recruiter-assignments";
import {
  collectRecruiterOptions,
  computeRecruiterWorkload,
} from "@/services/excel/compute-recruiter-workload";
import type { PrimarySkillClusterGroup } from "@/types/skill-clusters";
import { cn } from "@/lib/utils";

function filterGroups(
  groups: PrimarySkillClusterGroup[],
  {
    search,
    primarySkills,
    recruiters,
    statuses,
    priorities,
  }: {
    search: string;
    primarySkills: string[];
    recruiters: string[];
    statuses: string[];
    priorities: string[];
  }
) {
  const q = search.trim().toLowerCase();
  const primarySkillSet =
    primarySkills.length > 0 ? new Set(primarySkills) : null;
  const recruiterSet = recruiters.length > 0 ? new Set(recruiters) : null;
  const statusSet = statuses.length > 0 ? new Set(statuses) : null;
  const prioritySet = priorities.length > 0 ? new Set(priorities) : null;

  return groups
    .map((group) => {
      if (primarySkillSet && !primarySkillSet.has(group.primarySkill)) {
        return null;
      }

      const clusters = group.clusters.filter((cluster) => {
        if (recruiterSet) {
          const clusterHit = cluster.recruiters.some((name) =>
            recruiterSet.has(name)
          );
          const memberHit = cluster.members.some((member) =>
            member.recruiters.some((name) => recruiterSet.has(name))
          );
          if (!clusterHit && !memberHit) return false;
        }

        if (statusSet) {
          const hasAssigned = cluster.members.some(
            (member) => member.recruiters.length > 0
          );
          const hasUnassigned = cluster.members.some(
            (member) => member.recruiters.length === 0
          );
          const statusMatch =
            (statusSet.has("Allocated") && hasAssigned && !hasUnassigned) ||
            (statusSet.has("Unallocated") && !hasAssigned) ||
            (statusSet.has("Partial") && hasAssigned && hasUnassigned);
          if (!statusMatch) return false;
        }

        if (prioritySet) {
          const hasPriority = cluster.members.some(
            (member) => member.priority && prioritySet.has(member.priority)
          );
          if (!hasPriority) return false;
        }

        if (q) {
          const haystack = [
            group.primarySkill,
            group.skillCategorization ?? "",
            cluster.name,
            ...cluster.recruiters,
            ...cluster.mustHaveSkills.map((skill) => skill.original),
            ...cluster.goodToHaveSkills.map((skill) => skill.original),
            ...cluster.openingIds,
          ]
            .join(" ")
            .toLowerCase();
          if (!haystack.includes(q)) return false;
        }

        return true;
      });

      if (clusters.length === 0) return null;

      return {
        ...group,
        clusters,
        clusterCount: clusters.length,
        totalOpenings: clusters.reduce(
          (sum, cluster) => sum + cluster.totalOpenings,
          0
        ),
      };
    })
    .filter(
      (group): group is PrimarySkillClusterGroup =>
        Boolean(group?.clusters && group.primarySkill)
    );
}

export function LateralAllocationsPage() {
  const [search, setSearch] = React.useState("");
  const [primarySkills, setPrimarySkills] = React.useState<string[]>([]);
  const [recruiters, setRecruiters] = React.useState<string[]>([]);
  const [statuses, setStatuses] = React.useState<string[]>([]);
  const [priorities, setPriorities] = React.useState<string[]>([]);

  const assignments = useAllocationClusterStore((s) => s.assignments);
  const reassignOpening = useAllocationClusterStore((s) => s.reassignOpening);

  const clusterAssignments = useAllocationRecruiterStore(
    (s) => s.clusterAssignments
  );
  const openingOverrides = useAllocationRecruiterStore(
    (s) => s.openingOverrides
  );
  const assignClusterRecruiter = useAllocationRecruiterStore(
    (s) => s.assignClusterRecruiter
  );
  const assignOpeningRecruiter = useAllocationRecruiterStore(
    (s) => s.assignOpeningRecruiter
  );
  const clearOpeningOverride = useAllocationRecruiterStore(
    (s) => s.clearOpeningOverride
  );

  const { data, isLoading, isFetching, error, refetch } = useSkillClusters({
    limitGroups: 10,
  });

  const deferredSearch = React.useDeferredValue(search);

  const clusteredGroups = React.useMemo(() => {
    if (!data?.groups) return [];
    return applyClusterAssignments(data.groups, assignments);
  }, [data?.groups, assignments]);

  const groups = React.useMemo(
    () =>
      applyRecruiterAssignments(
        clusteredGroups,
        clusterAssignments,
        openingOverrides
      ),
    [clusteredGroups, clusterAssignments, openingOverrides]
  );

  const recruiterOptions = React.useMemo(
    () =>
      collectRecruiterOptions(
        clusteredGroups,
        clusterAssignments,
        openingOverrides
      ),
    [clusteredGroups, clusterAssignments, openingOverrides]
  );

  const workloadSummary = React.useMemo(
    () =>
      computeRecruiterWorkload(
        clusteredGroups,
        clusterAssignments,
        openingOverrides
      ),
    [clusteredGroups, clusterAssignments, openingOverrides]
  );

  const filterOptions = React.useMemo(() => {
    const primarySkills = groups.map((group) => group.primarySkill).sort();
    const priorities = Array.from(
      new Set(
        groups.flatMap((group) =>
          (group.clusters ?? []).flatMap((cluster) =>
            (cluster.members ?? [])
              .map((member) => member.priority)
              .filter((value): value is string => Boolean(value))
          )
        )
      )
    ).sort();

    return {
      primarySkills,
      recruiters: recruiterOptions,
      statuses: ["Allocated", "Partial", "Unallocated"],
      priorities: priorities.length > 0 ? priorities : ["P1", "P2"],
    };
  }, [groups, recruiterOptions]);

  const visibleGroups = React.useMemo(
    () =>
      filterGroups(groups, {
        search: deferredSearch,
        primarySkills,
        recruiters,
        statuses,
        priorities,
      }),
    [groups, deferredSearch, primarySkills, recruiters, statuses, priorities]
  );

  return (
    <PageTransition>
      <PageHeader
        title="Allocations"
        description="Assign recruiters at the Skill Cluster level. Openings inherit the cluster recruiter; override any opening when needed."
        actions={
          <Button
            variant="outline"
            className="rounded-xl gap-2"
            onClick={() => {
              void refetch();
            }}
            disabled={isFetching}
          >
            <RefreshCw
              className={cn("size-4", isFetching && "animate-spin")}
            />
            Refresh clusters
          </Button>
        }
      />

      <FadeIn>
        <RecruiterWorkloadPanel summary={workloadSummary} />
      </FadeIn>

      <FadeIn delay={0.04}>
        <AllocationsToolbar
          className="mt-4"
          search={search}
          onSearchChange={setSearch}
          primarySkills={primarySkills}
          onPrimarySkillsChange={setPrimarySkills}
          recruiters={recruiters}
          onRecruitersChange={setRecruiters}
          statuses={statuses}
          onStatusesChange={setStatuses}
          priorities={priorities}
          onPrioritiesChange={setPriorities}
          primarySkillOptions={filterOptions.primarySkills}
          recruiterOptions={filterOptions.recruiters}
          statusOptions={filterOptions.statuses}
          priorityOptions={filterOptions.priorities}
        />
      </FadeIn>

      {error ? (
        <div className="mt-4 rounded-2xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error instanceof Error ? error.message : "Failed to load clusters"}
        </div>
      ) : null}

      <div className="mt-4 space-y-3">
        {isLoading ? (
          Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} className="h-24 w-full rounded-2xl" />
          ))
        ) : visibleGroups.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border bg-muted/20 px-4 py-10 text-center text-sm text-muted-foreground">
            No primary skills match the current filters.
          </div>
        ) : (
          visibleGroups.map((group) => (
            <PrimarySkillCard
              key={group.primarySkillNormalized}
              group={group}
              assignments={assignments}
              onReassign={reassignOpening}
              recruiterOptions={recruiterOptions}
              clusterAssignments={clusterAssignments}
              openingOverrides={openingOverrides}
              onAssignClusterRecruiter={assignClusterRecruiter}
              onAssignOpeningRecruiter={assignOpeningRecruiter}
              onClearOpeningOverride={clearOpeningOverride}
              defaultOpen={false}
            />
          ))
        )}
      </div>

      {data ? (
        <p className="mt-4 text-xs text-muted-foreground">
          Showing {data.primarySkillCount} primary skills · {data.clusterCount}{" "}
          clusters · {data.totalOpenings} openings (top skills, capped for speed)
        </p>
      ) : null}
    </PageTransition>
  );
}
