import type {
  PrimarySkillClusterGroup,
  SkillCluster,
  SkillClusterMember,
} from "@/types/skill-clusters";

/**
 * Apply manual opening→cluster reassignments on top of automatic clustering.
 */
export function applyClusterAssignments(
  groups: PrimarySkillClusterGroup[],
  assignments: Record<string, string>
): PrimarySkillClusterGroup[] {
  if (!assignments || Object.keys(assignments).length === 0) return groups;

  return groups.map((group) => {
    const clusterById = new Map(
      group.clusters.map((cluster) => [cluster.id, cluster])
    );
    const memberByOpening = new Map<string, { clusterId: string; member: SkillClusterMember }>();

    for (const cluster of group.clusters) {
      for (const member of cluster.members) {
        memberByOpening.set(member.openingId, {
          clusterId: cluster.id,
          member,
        });
      }
    }

    const buckets = new Map<string, SkillClusterMember[]>();
    for (const cluster of group.clusters) {
      buckets.set(cluster.id, []);
    }

    for (const [openingId, current] of memberByOpening) {
      const targetId = assignments[openingId] ?? current.clusterId;
      if (!buckets.has(targetId)) {
        // Unknown target — keep original
        buckets.get(current.clusterId)?.push(current.member);
        continue;
      }
      buckets.get(targetId)?.push(current.member);
    }

    const clusters: SkillCluster[] = group.clusters
      .map((cluster) => {
        const members = buckets.get(cluster.id) ?? [];
        const recruiters = Array.from(
          new Set(members.flatMap((member) => member.recruiters))
        ).sort((a, b) => a.localeCompare(b));

        return {
          ...cluster,
          members,
          totalOpenings: members.length,
          openingIds: members.map((member) => member.openingId),
          recruiters,
        };
      })
      .filter((cluster) => cluster.totalOpenings > 0)
      .sort((a, b) => b.totalOpenings - a.totalOpenings);

    // Drop empty-only groups if everything moved away (shouldn't empty whole group)
    void clusterById;

    return {
      ...group,
      clusterCount: clusters.length,
      clusters,
    };
  });
}
