import { readFilterSourceSheet } from "@/services/excel/reader";
import { extractSkillsFromJobDescription } from "@/services/excel/extract-job-description-skills";
import { buildNormalizedSkillLibrary } from "@/services/excel/skill-library";
import { resolveDatasetExcel } from "@/services/excel/registry";
import type { BusinessUnitId } from "@/types/business-unit";
import type { ExcelCellValue, ExcelDataRow, ExcelReaderOptions } from "@/types/excel";
import type {
  OpeningSkillRecord,
  OpeningSkillsExtractionResult,
} from "@/types/opening-skills";

const OPENING_ID_PATTERNS = [
  /^job\s*requisition\s*id$/i,
  /^requisition\s*id$/i,
  /^opening\s*id$/i,
  /^job\s*id$/i,
];

const PRIMARY_SKILL_PATTERNS = [/^primary\s*skills?$/i];
const JOB_DESCRIPTION_PATTERNS = [/^job\s*description$/i, /job\s*description/i];

function findColumn(headers: string[], patterns: RegExp[]) {
  for (const pattern of patterns) {
    const hit = headers.find((header) => pattern.test(header.trim()));
    if (hit) return hit;
  }
  return null;
}

function asText(value: ExcelCellValue): string {
  if (value === null || value === undefined) return "";
  return String(value).replace(/\u00a0/g, " ").trim();
}

/**
 * Extract opening skill records from already-loaded Master Sheet rows.
 * Pure / reusable — safe to unit test without Excel I/O.
 */
export function extractOpeningSkillsFromRows(
  headers: string[],
  rows: ExcelDataRow[]
): {
  openings: OpeningSkillRecord[];
  emptyMustHaveCount: number;
  emptyGoodToHaveCount: number;
  columns: {
    openingId: string;
    primarySkill: string;
    jobDescription: string;
  };
} {
  const openingIdCol = findColumn(headers, OPENING_ID_PATTERNS);
  const primarySkillCol = findColumn(headers, PRIMARY_SKILL_PATTERNS);
  const jobDescriptionCol = findColumn(headers, JOB_DESCRIPTION_PATTERNS);

  if (!openingIdCol || !primarySkillCol || !jobDescriptionCol) {
    throw new Error(
      `Master Sheet is missing required columns. Found: ${headers.join(", ")}. ` +
        `Need Job Requisition ID, Primary Skills, and Job Description.`
    );
  }

  const openings: OpeningSkillRecord[] = [];
  let emptyMustHaveCount = 0;
  let emptyGoodToHaveCount = 0;

  for (const row of rows) {
    const openingId = asText(row[openingIdCol]);
    const primarySkill = asText(row[primarySkillCol]);
    const jobDescription = asText(row[jobDescriptionCol]);

    if (!openingId && !primarySkill && !jobDescription) continue;

    const extracted = extractSkillsFromJobDescription(jobDescription);
    if (extracted.mustHaveSkills.length === 0) emptyMustHaveCount += 1;
    if (extracted.goodToHaveSkills.length === 0) emptyGoodToHaveCount += 1;

    openings.push({
      openingId: openingId || String(row.id),
      primarySkill,
      mustHaveSkills: extracted.mustHaveSkills,
      goodToHaveSkills: extracted.goodToHaveSkills,
    });
  }

  return {
    openings,
    emptyMustHaveCount,
    emptyGoodToHaveCount,
    columns: {
      openingId: openingIdCol,
      primarySkill: primarySkillCol,
      jobDescription: jobDescriptionCol,
    },
  };
}

/**
 * Read the Lateral (or any BU with a detail Master Sheet) Excel source and
 * extract Must Have / Good to Have skills for every opening.
 * Re-runs against the live file whenever it changes (mtime cache bust).
 */
export async function extractOpeningSkills(
  businessUnitId: BusinessUnitId = "lateral",
  options?: ExcelReaderOptions
): Promise<OpeningSkillsExtractionResult> {
  const dataset = await resolveDatasetExcel(businessUnitId);
  const filePath = dataset.filePath;
  const sheet = await readFilterSourceSheet(businessUnitId, options);
  const extracted = extractOpeningSkillsFromRows(sheet.headers, sheet.rows);
  const skillLibrary = buildNormalizedSkillLibrary(extracted.openings);

  return {
    businessUnitId,
    sheetName: sheet.sheetName,
    sourceFile: dataset.fileName,
    sourcePath: filePath,
    extractedAt: new Date().toISOString(),
    totalRows: sheet.rows.length,
    extractedCount: extracted.openings.length,
    emptyMustHaveCount: extracted.emptyMustHaveCount,
    emptyGoodToHaveCount: extracted.emptyGoodToHaveCount,
    skillLibrary,
    openings: extracted.openings,
  };
}
