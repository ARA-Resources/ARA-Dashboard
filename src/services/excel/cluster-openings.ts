import { normalizeSkillName } from "@/services/excel/normalize-skill";
import {
  skillSimilarity,
  toWeightedSkills,
  type WeightedSkill,
} from "@/services/excel/skill-similarity";
import type { ExtractedSkill } from "@/types/opening-skills";
import type {
  ClusterOpening,
  PrimarySkillClusterGroup,
  SkillCluster,
  SkillClusterAlternative,
  SkillClusterMember,
} from "@/types/skill-clusters";

const DEFAULT_MERGE_THRESHOLD = 0.62;
const COMMON_SKILL_COVERAGE = 0.45;

interface IndexedOpening {
  opening: ClusterOpening;
  weighted: WeightedSkill[];
  index: number;
}

interface RawCluster {
  members: IndexedOpening[];
  centroid: WeightedSkill[];
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
}

/**
 * Generate a cluster name from dominant technologies in the member set.
 * Never uses a hardcoded catalog of cluster titles.
 */
export function generateClusterName(
  primarySkill: string,
  openings: ClusterOpening[]
): string {
  const mustCounts = new Map<string, { count: number; original: string }>();
  const goodCounts = new Map<string, { count: number; original: string }>();

  for (const opening of openings) {
    const seenMust = new Set<string>();
    for (const skill of opening.mustHaveSkills) {
      if (seenMust.has(skill.normalized)) continue;
      seenMust.add(skill.normalized);
      const existing = mustCounts.get(skill.normalized);
      if (existing) existing.count += 1;
      else
        mustCounts.set(skill.normalized, {
          count: 1,
          original: skill.original,
        });
    }

    const seenGood = new Set<string>();
    for (const skill of opening.goodToHaveSkills) {
      if (seenGood.has(skill.normalized)) continue;
      seenGood.add(skill.normalized);
      const existing = goodCounts.get(skill.normalized);
      if (existing) existing.count += 1;
      else
        goodCounts.set(skill.normalized, {
          count: 1,
          original: skill.original,
        });
    }
  }

  const primaryNorm = normalizeSkillName(primarySkill);
  const rankedMust = [...mustCounts.entries()]
    .filter(([normalized]) => normalized !== primaryNorm)
    .sort(
      (a, b) =>
        b[1].count - a[1].count ||
        b[1].original.length - a[1].original.length
    );

  let dominant = rankedMust.slice(0, 3).map(([, meta]) => meta.original);

  if (dominant.length === 0) {
    const rankedGood = [...goodCounts.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 2)
      .map(([, meta]) => meta.original);
    dominant = rankedGood;
  }

  if (dominant.length === 0) return `${primarySkill} · General`;
  if (dominant.length === 1) return `${primarySkill} · ${dominant[0]}`;
  return `${dominant.slice(0, 2).join(" + ")}${
    dominant[2] ? ` · ${dominant[2]}` : ""
  }`;
}

function commonSkills(
  openings: ClusterOpening[],
  kind: "must" | "good"
): ExtractedSkill[] {
  if (openings.length === 0) return [];
  const counts = new Map<string, { count: number; original: string }>();

  for (const opening of openings) {
    const list =
      kind === "must" ? opening.mustHaveSkills : opening.goodToHaveSkills;
    const seen = new Set<string>();
    for (const skill of list) {
      if (seen.has(skill.normalized)) continue;
      seen.add(skill.normalized);
      const existing = counts.get(skill.normalized);
      if (existing) existing.count += 1;
      else
        counts.set(skill.normalized, { count: 1, original: skill.original });
    }
  }

  const threshold = Math.max(
    1,
    Math.ceil(openings.length * COMMON_SKILL_COVERAGE)
  );

  return [...counts.entries()]
    .filter(([, meta]) => meta.count >= threshold)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 12)
    .map(([, meta]) => ({
      original: meta.original,
      normalized: normalizeSkillName(meta.original),
    }));
}

function uniqueRecruiters(openings: ClusterOpening[]) {
  const set = new Set<string>();
  for (const opening of openings) {
    for (const recruiter of opening.recruiters) {
      const cleaned = recruiter.replace(/\s+/g, " ").trim();
      if (cleaned) set.add(cleaned);
    }
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

function rebuildCentroid(members: IndexedOpening[]): WeightedSkill[] {
  const weights = new Map<string, number>();
  for (const member of members) {
    for (const skill of member.weighted) {
      weights.set(
        skill.normalized,
        (weights.get(skill.normalized) ?? 0) + skill.weight
      );
    }
  }
  const size = Math.max(members.length, 1);
  return [...weights.entries()]
    .map(([normalized, total]) => ({
      normalized,
      weight: total / size,
    }))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 24);
}

function averageSimilarityToCentroid(
  centroid: WeightedSkill[],
  members: IndexedOpening[],
  cache: Map<string, number>
): number {
  if (members.length === 0) return 0;
  // Sample large clusters — confidence doesn't need every member
  const sample =
    members.length <= 40
      ? members
      : members.filter((_, index) => index % Math.ceil(members.length / 40) === 0);
  let total = 0;
  for (const member of sample) {
    total += cachedOpeningSimilarity(member.weighted, centroid, cache);
  }
  return total / sample.length;
}

function cachedOpeningSimilarity(
  left: WeightedSkill[],
  right: WeightedSkill[],
  cache: Map<string, number>
): number {
  // Fast path using skillSimilarity cache inside pair loops
  if (left.length === 0 && right.length === 0) return 1;
  if (left.length === 0 || right.length === 0) return 0.05;

  const scoreSide = (a: WeightedSkill[], b: WeightedSkill[]) => {
    let weighted = 0;
    let total = 0;
    for (const skill of a) {
      total += skill.weight;
      let best = 0;
      for (const other of b) {
        const key =
          skill.normalized < other.normalized
            ? `${skill.normalized}||${other.normalized}`
            : `${other.normalized}||${skill.normalized}`;
        let sim = cache.get(key);
        if (sim == null) {
          sim = skillSimilarity(skill.normalized, other.normalized);
          cache.set(key, sim);
        }
        const score = sim * Math.min(skill.weight, other.weight);
        if (score > best) best = score;
      }
      weighted += best;
    }
    return total === 0 ? 0 : weighted / total;
  };

  return (scoreSide(left, right) + scoreSide(right, left)) / 2;
}

/**
 * Fast greedy clustering: assign each opening to the best centroid or start a new cluster.
 * Uses semantic soft-similarity (aliases, tokens, tech families).
 */
function greedyCluster(
  openings: ClusterOpening[],
  threshold: number
): RawCluster[] {
  const indexed: IndexedOpening[] = openings.map((opening, index) => ({
    opening,
    index,
    weighted: toWeightedSkills(
      opening.mustHaveSkills,
      opening.goodToHaveSkills
    ),
  }));

  indexed.sort(
    (a, b) =>
      b.weighted.length - a.weighted.length ||
      a.opening.openingId.localeCompare(b.opening.openingId)
  );

  const clusters: RawCluster[] = [];
  const skillCache = new Map<string, number>();

  for (const item of indexed) {
    let bestIndex = -1;
    let bestScore = 0;

    for (let i = 0; i < clusters.length; i += 1) {
      const score = cachedOpeningSimilarity(
        item.weighted,
        clusters[i].centroid,
        skillCache
      );
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }

    if (bestIndex >= 0 && bestScore >= threshold) {
      clusters[bestIndex].members.push(item);
      // Rebuild centroid less often for large clusters
      const size = clusters[bestIndex].members.length;
      const rebuildEvery = size > 80 ? 24 : size > 30 ? 12 : 8;
      if (size % rebuildEvery === 0) {
        clusters[bestIndex].centroid = rebuildCentroid(
          clusters[bestIndex].members
        );
      }
    } else {
      clusters.push({
        members: [item],
        centroid: item.weighted,
      });
    }
  }

  for (const cluster of clusters) {
    cluster.centroid = rebuildCentroid(cluster.members);
  }

  // Split oversized "same primary must" blobs by secondary skill signatures
  return clusters.flatMap((cluster) =>
    splitBySecondarySignature(cluster, openings[0]?.primarySkillNormalized ?? "")
  );
}

function secondarySignature(
  opening: ClusterOpening,
  primaryNorm: string
): string {
  const extras = opening.mustHaveSkills
    .map((skill) => skill.normalized)
    .filter((normalized) => normalized && normalized !== primaryNorm)
    .sort();
  if (extras.length > 0) return extras.slice(0, 4).join("|");

  const good = opening.goodToHaveSkills
    .map((skill) => skill.normalized)
    .filter(Boolean)
    .sort();
  if (good.length > 0) return `good:${good.slice(0, 3).join("|")}`;
  return "__general__";
}

function splitBySecondarySignature(
  cluster: RawCluster,
  primaryNorm: string
): RawCluster[] {
  if (cluster.members.length < 12) return [cluster];

  const buckets = new Map<string, IndexedOpening[]>();
  for (const member of cluster.members) {
    const key = secondarySignature(member.opening, primaryNorm);
    const list = buckets.get(key) ?? [];
    list.push(member);
    buckets.set(key, list);
  }

  if (buckets.size <= 1) return [cluster];

  // Keep meaningful buckets; fold tiny leftovers into General when possible
  const result: RawCluster[] = [];
  let residual: IndexedOpening[] = [];

  for (const [key, members] of buckets) {
    if (key === "__general__" || members.length < 3) {
      residual = residual.concat(members);
      continue;
    }
    result.push({
      members,
      centroid: rebuildCentroid(members),
    });
  }

  if (residual.length > 0) {
    result.push({
      members: residual,
      centroid: rebuildCentroid(residual),
    });
  }

  return result.length > 0 ? result : [cluster];
}

function finalizeClusters(
  primarySkill: string,
  rawClusters: RawCluster[]
): SkillCluster[] {
  const primaryNorm = normalizeSkillName(primarySkill);
  const skillCache = new Map<string, number>();

  const prepared = rawClusters
    .map((cluster) => {
      const memberOpenings = cluster.members.map((item) => item.opening);
      const confidence =
        cluster.members.length <= 1
          ? Math.max(
              0.35,
              averageSimilarityToCentroid(
                cluster.centroid,
                cluster.members,
                skillCache
              )
            )
          : averageSimilarityToCentroid(
              cluster.centroid,
              cluster.members,
              skillCache
            );

      return {
        ...cluster,
        name: generateClusterName(primarySkill, memberOpenings),
        memberOpenings,
        confidence,
        mustHaveSkills: commonSkills(memberOpenings, "must"),
        goodToHaveSkills: commonSkills(memberOpenings, "good"),
        recruiters: uniqueRecruiters(memberOpenings),
      };
    })
    .sort(
      (a, b) =>
        b.memberOpenings.length - a.memberOpenings.length ||
        b.confidence - a.confidence
    );

  const clusters: Array<
    SkillCluster & { memberIndex: IndexedOpening[]; centroid: WeightedSkill[] }
  > = prepared.map((cluster, index) => ({
    id: `sc-${slugify(primaryNorm)}-${index + 1}-${slugify(cluster.name)}`,
    name: cluster.name,
    primarySkill,
    primarySkillNormalized: primaryNorm,
    mustHaveSkills: cluster.mustHaveSkills,
    goodToHaveSkills: cluster.goodToHaveSkills,
    totalOpenings: cluster.memberOpenings.length,
    openingIds: cluster.memberOpenings.map((item) => item.openingId),
    recruiters: cluster.recruiters,
    confidenceScore: Number(cluster.confidence.toFixed(3)),
    members: [],
    memberIndex: cluster.members,
    centroid: cluster.centroid,
  }));

  // Light finalize: score only against the home centroid (skip O(members×clusters)
  // alternatives pass — keeps Allocations payload small and clustering fast).
  return clusters.map((cluster) => {
    const members: SkillClusterMember[] = cluster.memberIndex.map((item) => ({
      openingId: item.opening.openingId,
      similarityToCluster: Number(
        cachedOpeningSimilarity(
          item.weighted,
          cluster.centroid,
          skillCache
        ).toFixed(3)
      ),
      recommendedClusterId: cluster.id,
      alternatives: [] as SkillClusterAlternative[],
      recruiters: item.opening.recruiters,
      priority: item.opening.priority,
      jobStatus: item.opening.jobStatus,
    }));

    return {
      id: cluster.id,
      name: cluster.name,
      primarySkill: cluster.primarySkill,
      primarySkillNormalized: cluster.primarySkillNormalized,
      mustHaveSkills: cluster.mustHaveSkills,
      goodToHaveSkills: cluster.goodToHaveSkills,
      totalOpenings: cluster.totalOpenings,
      openingIds: cluster.openingIds,
      recruiters: cluster.recruiters,
      confidenceScore: cluster.confidenceScore,
      members: members.sort(
        (a, b) => b.similarityToCluster - a.similarityToCluster
      ),
    };
  });
}

/**
 * Cluster openings that share the same Primary Skill.
 */
export function clusterOpeningsForPrimarySkill(
  primarySkill: string,
  openings: ClusterOpening[],
  options?: { mergeThreshold?: number }
): SkillCluster[] {
  if (openings.length === 0) return [];
  const threshold = options?.mergeThreshold ?? DEFAULT_MERGE_THRESHOLD;
  return finalizeClusters(primarySkill, greedyCluster(openings, threshold));
}

export function buildPrimarySkillClusterGroups(
  openings: ClusterOpening[],
  options?: { mergeThreshold?: number }
): PrimarySkillClusterGroup[] {
  const byPrimary = new Map<string, ClusterOpening[]>();

  for (const opening of openings) {
    const key =
      opening.primarySkillNormalized ||
      normalizeSkillName(opening.primarySkill) ||
      "unknown";
    const list = byPrimary.get(key) ?? [];
    list.push(opening);
    byPrimary.set(key, list);
  }

  const groups: PrimarySkillClusterGroup[] = [];

  for (const [, groupOpenings] of byPrimary) {
    const primarySkill =
      groupOpenings
        .map((item) => item.primarySkill)
        .sort((a, b) => b.length - a.length)[0] ?? "Unknown";

    const categorizationCounts = new Map<string, number>();
    for (const opening of groupOpenings) {
      if (!opening.skillCategorization) continue;
      categorizationCounts.set(
        opening.skillCategorization,
        (categorizationCounts.get(opening.skillCategorization) ?? 0) + 1
      );
    }
    const skillCategorization =
      [...categorizationCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ??
      null;

    const clusters = clusterOpeningsForPrimarySkill(
      primarySkill,
      groupOpenings,
      options
    );

    groups.push({
      primarySkill,
      primarySkillNormalized: normalizeSkillName(primarySkill),
      skillCategorization,
      totalOpenings: groupOpenings.length,
      clusterCount: clusters.length,
      clusters,
    });
  }

  return groups.sort(
    (a, b) =>
      b.totalOpenings - a.totalOpenings ||
      a.primarySkill.localeCompare(b.primarySkill)
  );
}
