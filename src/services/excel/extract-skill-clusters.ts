import { extractSkillsFromJobDescription } from "@/services/excel/extract-job-description-skills";
import { buildPrimarySkillClusterGroups } from "@/services/excel/cluster-openings";
import { normalizeSkillName } from "@/services/excel/normalize-skill";
import { readFilterSourceSheet } from "@/services/excel/reader";
import { resolveDatasetExcel } from "@/services/excel/registry";
import type { BusinessUnitId } from "@/types/business-unit";
import type { ExcelCellValue, ExcelDataRow, ExcelReaderOptions } from "@/types/excel";
import type { ClusterOpening, SkillClustersResult } from "@/types/skill-clusters";

interface ClusterCacheEntry {
  mtimeMs: number;
  payload: SkillClustersResult;
}

interface OpeningsCacheEntry {
  mtimeMs: number;
  headers: string[];
  sheetName: string;
  /** Lightweight rows: primary skill + row index into sheet.rows */
  primaryIndex: Array<{
    rowIndex: number;
    primarySkill: string;
    primarySkillNormalized: string;
  }>;
}

const clusterResultCache = new Map<string, ClusterCacheEntry>();
const openingsIndexCache = new Map<string, OpeningsCacheEntry>();

/** Cap openings clustered per primary skill to keep Allocations responsive */
const MAX_OPENINGS_PER_PRIMARY = 200;

const OPENING_ID_PATTERNS = [
  /^job\s*requisition\s*id$/i,
  /^requisition\s*id$/i,
  /^opening\s*id$/i,
];
const PRIMARY_SKILL_PATTERNS = [/^primary\s*skills?$/i];
const JOB_DESCRIPTION_PATTERNS = [/^job\s*description$/i];
const CATEGORIZATION_PATTERNS = [/^skill\s*categorization$/i];
const PRIORITY_PATTERNS = [/^priority$/i];
const STATUS_PATTERNS = [/^job\s*status$/i];
const RECRUITER_PATTERNS = [
  /^team\s*member\s*1$/i,
  /^team\s*member\s*2$/i,
  /^team\s*lead$/i,
];

function findColumn(headers: string[], patterns: RegExp[]) {
  for (const pattern of patterns) {
    const hit = headers.find((header) => pattern.test(header.trim()));
    if (hit) return hit;
  }
  return null;
}

function findColumns(headers: string[], patterns: RegExp[]) {
  return headers.filter((header) =>
    patterns.some((pattern) => pattern.test(header.trim()))
  );
}

function asText(value: ExcelCellValue): string {
  if (value === null || value === undefined) return "";
  return String(value).replace(/\u00a0/g, " ").trim();
}

function parseRecruiterCell(value: string): string[] {
  if (!value) return [];
  return value
    .split(/[/|,]+/)
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter((part) => part && !/^(na|n\/a|-)$/i.test(part));
}

function buildOpeningFromRow(
  row: ExcelDataRow,
  cols: {
    openingIdCol: string;
    primarySkillCol: string;
    jobDescriptionCol: string;
    categorizationCol: string | null;
    priorityCol: string | null;
    statusCol: string | null;
    recruiterCols: string[];
  }
): ClusterOpening | null {
  const openingId = asText(row[cols.openingIdCol]);
  const primarySkill = asText(row[cols.primarySkillCol]);
  const jobDescription = asText(row[cols.jobDescriptionCol]);
  if (!openingId && !primarySkill) return null;

  const extracted = extractSkillsFromJobDescription(jobDescription);
  const recruiters = Array.from(
    new Set(
      cols.recruiterCols.flatMap((column) =>
        parseRecruiterCell(asText(row[column]))
      )
    )
  );

  return {
    openingId: openingId || String(row.id),
    primarySkill,
    primarySkillNormalized: normalizeSkillName(primarySkill),
    skillCategorization: cols.categorizationCol
      ? asText(row[cols.categorizationCol]) || null
      : null,
    priority: cols.priorityCol ? asText(row[cols.priorityCol]) || null : null,
    jobStatus: cols.statusCol ? asText(row[cols.statusCol]) || null : null,
    recruiters,
    mustHaveSkills: extracted.mustHaveSkills,
    goodToHaveSkills: extracted.goodToHaveSkills,
  };
}

/**
 * Build cluster-ready openings from Master Sheet rows.
 * Prefer extractSkillClusters which filters before JD parse.
 */
export function buildClusterOpeningsFromRows(
  headers: string[],
  rows: ExcelDataRow[]
): ClusterOpening[] {
  const openingIdCol = findColumn(headers, OPENING_ID_PATTERNS);
  const primarySkillCol = findColumn(headers, PRIMARY_SKILL_PATTERNS);
  const jobDescriptionCol = findColumn(headers, JOB_DESCRIPTION_PATTERNS);
  const categorizationCol = findColumn(headers, CATEGORIZATION_PATTERNS);
  const priorityCol = findColumn(headers, PRIORITY_PATTERNS);
  const statusCol = findColumn(headers, STATUS_PATTERNS);
  const recruiterCols = findColumns(headers, RECRUITER_PATTERNS);

  if (!openingIdCol || !primarySkillCol || !jobDescriptionCol) {
    throw new Error(
      `Master Sheet is missing required columns for clustering. Found: ${headers.join(", ")}`
    );
  }

  const cols = {
    openingIdCol,
    primarySkillCol,
    jobDescriptionCol,
    categorizationCol,
    priorityCol,
    statusCol,
    recruiterCols,
  };

  const openings: ClusterOpening[] = [];
  for (const row of rows) {
    const opening = buildOpeningFromRow(row, cols);
    if (opening) openings.push(opening);
  }
  return openings;
}

function resolveColumnMap(headers: string[]) {
  const openingIdCol = findColumn(headers, OPENING_ID_PATTERNS);
  const primarySkillCol = findColumn(headers, PRIMARY_SKILL_PATTERNS);
  const jobDescriptionCol = findColumn(headers, JOB_DESCRIPTION_PATTERNS);
  const categorizationCol = findColumn(headers, CATEGORIZATION_PATTERNS);
  const priorityCol = findColumn(headers, PRIORITY_PATTERNS);
  const statusCol = findColumn(headers, STATUS_PATTERNS);
  const recruiterCols = findColumns(headers, RECRUITER_PATTERNS);

  if (!openingIdCol || !primarySkillCol || !jobDescriptionCol) {
    throw new Error(
      `Master Sheet is missing required columns for clustering. Found: ${headers.join(", ")}`
    );
  }

  return {
    openingIdCol,
    primarySkillCol,
    jobDescriptionCol,
    categorizationCol,
    priorityCol,
    statusCol,
    recruiterCols,
  };
}

/**
 * Extract openings from Excel and build Skill Clusters per Primary Skill.
 * JD parsing runs only for selected primary skills (top-N / filter),
 * and each skill is capped so Allocations stays responsive.
 */
export async function extractSkillClusters(
  businessUnitId: BusinessUnitId = "lateral",
  options?: ExcelReaderOptions & {
    primarySkill?: string;
    mergeThreshold?: number;
    /** Cluster only the top N primary skills by opening volume */
    limitGroups?: number;
  }
): Promise<SkillClustersResult> {
  const dataset = await resolveDatasetExcel(businessUnitId);
  const filePath = dataset.filePath;
  const mtimeMs = dataset.mtimeMs;

  const cacheKey = [
    businessUnitId,
    filePath,
    options?.primarySkill ?? "",
    options?.limitGroups ?? "",
    options?.mergeThreshold ?? "",
  ].join("::");

  const cached = clusterResultCache.get(cacheKey);
  if (cached && cached.mtimeMs === mtimeMs && !options?.bypassCache) {
    return cached.payload;
  }

  const sheet = await readFilterSourceSheet(businessUnitId, options);
  const cols = resolveColumnMap(sheet.headers);

  const indexKey = `${businessUnitId}::${filePath}`;
  let primaryIndex = openingsIndexCache.get(indexKey);
  if (
    !primaryIndex ||
    primaryIndex.mtimeMs !== mtimeMs ||
    options?.bypassCache
  ) {
    const entries: OpeningsCacheEntry["primaryIndex"] = [];
    for (let rowIndex = 0; rowIndex < sheet.rows.length; rowIndex += 1) {
      const row = sheet.rows[rowIndex];
      const primarySkill = asText(row[cols.primarySkillCol]);
      const openingId = asText(row[cols.openingIdCol]);
      if (!openingId && !primarySkill) continue;
      entries.push({
        rowIndex,
        primarySkill,
        primarySkillNormalized: normalizeSkillName(primarySkill),
      });
    }
    primaryIndex = {
      mtimeMs,
      headers: sheet.headers,
      sheetName: sheet.sheetName,
      primaryIndex: entries,
    };
    openingsIndexCache.set(indexKey, primaryIndex);
  }

  let selected = primaryIndex.primaryIndex;

  if (options?.primarySkill) {
    const wanted = normalizeSkillName(options.primarySkill);
    selected = selected.filter(
      (entry) => entry.primarySkillNormalized === wanted
    );
  } else if (options?.limitGroups) {
    const counts = new Map<string, number>();
    for (const entry of selected) {
      counts.set(
        entry.primarySkillNormalized,
        (counts.get(entry.primarySkillNormalized) ?? 0) + 1
      );
    }
    const keep = new Set(
      [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, options.limitGroups)
        .map(([key]) => key)
    );
    selected = selected.filter((entry) => keep.has(entry.primarySkillNormalized));
  }

  // Cap per primary skill before expensive JD parse + clustering
  const taken = new Map<string, number>();
  const capped = selected.filter((entry) => {
    const count = taken.get(entry.primarySkillNormalized) ?? 0;
    if (count >= MAX_OPENINGS_PER_PRIMARY) return false;
    taken.set(entry.primarySkillNormalized, count + 1);
    return true;
  });

  const openings: ClusterOpening[] = [];
  for (const entry of capped) {
    const opening = buildOpeningFromRow(sheet.rows[entry.rowIndex], cols);
    if (opening) openings.push(opening);
  }

  const groups = buildPrimarySkillClusterGroups(openings, {
    mergeThreshold: options?.mergeThreshold,
  });

  const payload: SkillClustersResult = {
    businessUnitId,
    sheetName: sheet.sheetName,
    sourceFile: dataset.fileName,
    sourcePath: filePath,
    extractedAt: new Date().toISOString(),
    totalOpenings: openings.length,
    primarySkillCount: groups.length,
    clusterCount: groups.reduce((sum, group) => sum + group.clusterCount, 0),
    groups,
  };

  clusterResultCache.set(cacheKey, { mtimeMs, payload });
  return payload;
}

export function clearSkillClusterCache() {
  clusterResultCache.clear();
  openingsIndexCache.clear();
}
