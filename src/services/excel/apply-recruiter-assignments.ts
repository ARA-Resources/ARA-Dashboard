import type { PrimarySkillClusterGroup } from "@/types/skill-clusters";
import { resolveEffectiveRecruiter } from "@/services/excel/resolve-recruiter-assignment";

/**
 * Overlay HR recruiter assignments onto clustered groups.
 * Cluster assignment is inherited; opening overrides win.
 */
export function applyRecruiterAssignments(
  groups: PrimarySkillClusterGroup[],
  clusterAssignments: Record<string, string>,
  openingOverrides: Record<string, string>
): PrimarySkillClusterGroup[] {
  if (
    Object.keys(clusterAssignments).length === 0 &&
    Object.keys(openingOverrides).length === 0
  ) {
    return groups;
  }

  return groups.map((group) => ({
    ...group,
    clusters: group.clusters.map((cluster) => {
      const members = cluster.members.map((member) => {
        const effective = resolveEffectiveRecruiter(
          member.openingId,
          cluster.id,
          clusterAssignments,
          openingOverrides
        );
        return {
          ...member,
          recruiters: effective ? [effective] : [],
        };
      });

      const clusterAssigned = clusterAssignments[cluster.id]?.trim();
      const recruiters = clusterAssigned
        ? [clusterAssigned]
        : Array.from(
            new Set(members.flatMap((member) => member.recruiters))
          ).sort((a, b) => a.localeCompare(b));

      return {
        ...cluster,
        members,
        recruiters,
      };
    }),
  }));
}
