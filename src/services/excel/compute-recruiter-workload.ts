import type { PrimarySkillClusterGroup } from "@/types/skill-clusters";
import type { RecruiterWorkloadSummary } from "@/types/recruiter-workload";
import { resolveEffectiveRecruiter } from "@/services/excel/resolve-recruiter-assignment";

export function computeRecruiterWorkload(
  groups: PrimarySkillClusterGroup[],
  clusterAssignments: Record<string, string>,
  openingOverrides: Record<string, string>
): RecruiterWorkloadSummary {
  const byRecruiter = new Map<
    string,
    {
      clusters: Set<string>;
      openings: Set<string>;
      primarySkills: Set<string>;
    }
  >();

  function ensure(name: string) {
    let entry = byRecruiter.get(name);
    if (!entry) {
      entry = {
        clusters: new Set(),
        openings: new Set(),
        primarySkills: new Set(),
      };
      byRecruiter.set(name, entry);
    }
    return entry;
  }

  let totalClusters = 0;
  let totalOpenings = 0;
  let assignedClusters = 0;
  let assignedOpenings = 0;

  for (const group of groups) {
    for (const cluster of group.clusters) {
      totalClusters += 1;
      const clusterRecruiter = clusterAssignments[cluster.id]?.trim();
      if (clusterRecruiter) {
        assignedClusters += 1;
        ensure(clusterRecruiter).clusters.add(cluster.id);
      }

      for (const member of cluster.members) {
        totalOpenings += 1;
        const effective = resolveEffectiveRecruiter(
          member.openingId,
          cluster.id,
          clusterAssignments,
          openingOverrides
        );
        if (!effective) continue;
        assignedOpenings += 1;
        const entry = ensure(effective);
        entry.openings.add(member.openingId);
        entry.primarySkills.add(group.primarySkill);
      }
    }
  }

  const recruiters = Array.from(byRecruiter.entries())
    .map(([recruiter, entry]) => ({
      recruiter,
      clusterCount: entry.clusters.size,
      openingCount: entry.openings.size,
      primarySkills: Array.from(entry.primarySkills).sort((a, b) =>
        a.localeCompare(b)
      ),
    }))
    .sort((a, b) => b.openingCount - a.openingCount || a.recruiter.localeCompare(b.recruiter));

  const averageOpeningsPerRecruiter =
    recruiters.length === 0
      ? 0
      : recruiters.reduce((sum, row) => sum + row.openingCount, 0) /
        recruiters.length;

  return {
    recruiters,
    assignedClusters,
    unassignedClusters: totalClusters - assignedClusters,
    assignedOpenings,
    unassignedOpenings: totalOpenings - assignedOpenings,
    totalClusters,
    totalOpenings,
    averageOpeningsPerRecruiter,
  };
}

/** Collect recruiter names from Excel source data + HR assignments. */
export function collectRecruiterOptions(
  groups: PrimarySkillClusterGroup[],
  clusterAssignments: Record<string, string>,
  openingOverrides: Record<string, string>
): string[] {
  const names = new Set<string>();

  for (const group of groups) {
    for (const cluster of group.clusters) {
      for (const name of cluster.recruiters) {
        const cleaned = name.replace(/\s+/g, " ").trim();
        if (cleaned) names.add(cleaned);
      }
      for (const member of cluster.members) {
        for (const name of member.recruiters) {
          const cleaned = name.replace(/\s+/g, " ").trim();
          if (cleaned) names.add(cleaned);
        }
      }
    }
  }

  for (const name of Object.values(clusterAssignments)) {
    const cleaned = name.replace(/\s+/g, " ").trim();
    if (cleaned) names.add(cleaned);
  }
  for (const name of Object.values(openingOverrides)) {
    const cleaned = name.replace(/\s+/g, " ").trim();
    if (cleaned) names.add(cleaned);
  }

  return Array.from(names).sort((a, b) => a.localeCompare(b));
}
