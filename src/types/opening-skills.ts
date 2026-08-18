/**
 * Opening-level skill extraction from Lateral Master Sheet job descriptions.
 */

export interface ExtractedSkill {
  /** Exact wording as found in the Job Description */
  original: string;
  /**
   * Canonical clustering key — lowercased, punctuation-standardized,
   * alias-merged (e.g. ADF → azure data factory).
   */
  normalized: string;
}

export interface OpeningSkillRecord {
  openingId: string;
  primarySkill: string;
  mustHaveSkills: ExtractedSkill[];
  goodToHaveSkills: ExtractedSkill[];
}

export interface NormalizedSkillLibraryEntry {
  /** Canonical key used for matching / clustering */
  normalized: string;
  /** Most common original wording for display */
  preferredOriginal: string;
  /** All distinct original strings that mapped to this key */
  originals: string[];
  /** Distinct openings that mention this skill */
  openingCount: number;
  mustHaveCount: number;
  goodToHaveCount: number;
}

export interface OpeningSkillsExtractionResult {
  businessUnitId: string;
  sheetName: string;
  sourceFile: string;
  sourcePath: string;
  extractedAt: string;
  totalRows: number;
  extractedCount: number;
  /** Openings where Must Have Skills resolved to an empty list */
  emptyMustHaveCount: number;
  /**
   * Openings where Good to Have Skills resolved to an empty list
   * (includes explicit NA / N/A placeholders).
   */
  emptyGoodToHaveCount: number;
  /** Deduplicated normalized skill library across all openings */
  skillLibrary: NormalizedSkillLibraryEntry[];
  openings: OpeningSkillRecord[];
}
