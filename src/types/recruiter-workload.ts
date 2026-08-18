export interface RecruiterWorkload {
  recruiter: string;
  /** Clusters with an HR assignment to this recruiter */
  clusterCount: number;
  /** Openings whose effective recruiter is this person */
  openingCount: number;
  /** Primary skills represented among those openings */
  primarySkills: string[];
}

export interface RecruiterWorkloadSummary {
  recruiters: RecruiterWorkload[];
  assignedClusters: number;
  unassignedClusters: number;
  assignedOpenings: number;
  unassignedOpenings: number;
  totalClusters: number;
  totalOpenings: number;
  averageOpeningsPerRecruiter: number;
}
