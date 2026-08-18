/**
 * Skill-cluster contracts for Primary Skill grouping.
 */

import type { ExtractedSkill } from "@/types/opening-skills";

export interface ClusterOpening {
  openingId: string;
  primarySkill: string;
  primarySkillNormalized: string;
  skillCategorization: string | null;
  priority: string | null;
  jobStatus: string | null;
  recruiters: string[];
  mustHaveSkills: ExtractedSkill[];
  goodToHaveSkills: ExtractedSkill[];
}

export interface SkillClusterAlternative {
  clusterId: string;
  clusterName: string;
  similarity: number;
}

export interface SkillClusterMember {
  openingId: string;
  similarityToCluster: number;
  /** Best automatic recommendation (may equal this cluster) */
  recommendedClusterId: string;
  /** Other strong fits for manual reassignment */
  alternatives: SkillClusterAlternative[];
  recruiters: string[];
  priority: string | null;
  jobStatus: string | null;
}

export interface SkillCluster {
  id: string;
  name: string;
  primarySkill: string;
  primarySkillNormalized: string;
  mustHaveSkills: ExtractedSkill[];
  goodToHaveSkills: ExtractedSkill[];
  totalOpenings: number;
  openingIds: string[];
  recruiters: string[];
  /** 0–1 average cohesion of members to the cluster centroid */
  confidenceScore: number;
  members: SkillClusterMember[];
}

export interface PrimarySkillClusterGroup {
  primarySkill: string;
  primarySkillNormalized: string;
  skillCategorization: string | null;
  totalOpenings: number;
  clusterCount: number;
  clusters: SkillCluster[];
}

export interface SkillClustersResult {
  businessUnitId: string;
  sheetName: string;
  sourceFile: string;
  sourcePath: string;
  extractedAt: string;
  totalOpenings: number;
  primarySkillCount: number;
  clusterCount: number;
  groups: PrimarySkillClusterGroup[];
}
