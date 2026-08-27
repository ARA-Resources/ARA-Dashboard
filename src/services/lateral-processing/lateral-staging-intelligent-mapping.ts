/**
 * Intelligent ATCI DS → lateral_staging column mapping.
 *
 * Priority:
 *  1. Exact normalized header match
 *  2. Known header aliases
 *  3. Header similarity
 *  4. Data-pattern detection
 *  5. Position fallback ONLY when confidence is sufficient
 *  6. Ambiguous → FAIL (never silent wrong mapping)
 *
 * Date may be system-generated when ATCI DS has no Date column
 * (matches existing New Sheet behavior).
 *
 * Does NOT write Job Status / Posted / Master.
 */

import { CANONICAL_JML_ORDER } from "@/services/lateral-processing/lateral-p-roles-engine";
import { parseExcelDateToIso } from "@/services/lateral-processing/lateral-master-pg-backfill";

export const STAGING_TARGET_FIELDS = [
  "date",
  "job_requisition_id",
  "priority",
  "job_description",
  "skill_categorization",
  "primary_skills",
  "job_management_level",
  "primary_location",
  "market_map",
  "poc",
] as const;

export type StagingTargetField = (typeof STAGING_TARGET_FIELDS)[number];

export type MappingConfidence =
  | "exact"
  | "case_insensitive"
  | "normalized_alias"
  | "similarity"
  | "data_pattern"
  | "position_fallback"
  | "generated";

export interface StagingFieldMapping {
  field: StagingTargetField;
  sourceHeader: string | null;
  sourceColIndex: number; // -1 when generated
  confidence: MappingConfidence;
  score: number;
  reason: string;
}

export interface StagingMappingSuccess {
  ok: true;
  mappings: StagingFieldMapping[];
  ignoredSourceHeaders: string[];
  sourceHeaders: string[];
}

export interface StagingMappingAmbiguity {
  field: StagingTargetField;
  candidates: Array<{
    sourceHeader: string;
    sourceColIndex: number;
    confidence: MappingConfidence;
    score: number;
    reason: string;
  }>;
}

export interface StagingMappingFailure {
  ok: false;
  message: string;
  missingFields: StagingTargetField[];
  ambiguous: StagingMappingAmbiguity[];
  sourceHeaders: string[];
}

export type StagingMappingResult = StagingMappingSuccess | StagingMappingFailure;

/** Extended aliases beyond New Sheet candidates (still header-name based). */
export const STAGING_FIELD_ALIASES: Record<
  StagingTargetField,
  readonly string[]
> = {
  date: ["Date", "Processing Date", "DS Date"],
  job_requisition_id: [
    "Job Requisition ID",
    "Job Req ID",
    "Job Requisition Id",
    "Job Requisition",
    "JR ID",
    "Requisition ID",
    "Req ID",
  ],
  priority: ["Priority", "Job Priority"],
  job_description: [
    "Job Description",
    "JD",
    "Description",
    "Job Desc",
  ],
  skill_categorization: [
    "Skill Categorization",
    "Skill Category",
    "Skills Categorization",
    "Skill Classification",
  ],
  primary_skills: ["Primary Skills", "Primary Skill", "Skills"],
  job_management_level: [
    "Job Management Level",
    "JML",
    "Management Level",
    "Job Level",
  ],
  primary_location: [
    "Primary Location/Office Locate",
    "Primary Location/Office locate",
    "Primary Location/Office lOcate",
    "Primary Location/Office",
    "Primary Location",
    "Primary Office",
    "Location",
  ],
  market_map: ["Market Map", "Market", "Market Mapping"],
  poc: ["POC", "Point of Contact", "Point Of Contact", "POC Name"],
};

/** Expected New Sheet A–J positions — weak fallback only with pattern support. */
export const STAGING_EXPECTED_POSITION: Record<StagingTargetField, number> = {
  date: 0,
  job_requisition_id: 1,
  priority: 2,
  job_description: 3,
  skill_categorization: 4,
  primary_skills: 5,
  job_management_level: 6,
  primary_location: 7,
  market_map: 8,
  poc: 9,
};

const PRIORITY_PATTERN =
  /^(p[0-9]|priority\s*[0-9]|high|medium|low|critical)$/i;
const JR_PATTERN = /^ATCI-/i;
const JR_LOOSE_PATTERN = /^[A-Z]{2,}[-_]\d+/i;
const JML_KNOWN = new Set(
  CANONICAL_JML_ORDER.map((v) => v.toLowerCase())
);

export function normalizeHeader(h: string): string {
  return String(h ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 0; i < a.length; i += 1) {
    let prev = i;
    row[0] = i + 1;
    for (let j = 0; j < b.length; j += 1) {
      const cur = row[j + 1];
      const cost = a[i] === b[j] ? 0 : 1;
      row[j + 1] = Math.min(row[j + 1] + 1, row[j] + 1, prev + cost);
      prev = cur;
    }
  }
  return row[b.length];
}

function similarityRatio(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const dist = levenshtein(a, b);
  return 1 - dist / Math.max(a.length, b.length);
}

function aliasesForField(field: StagingTargetField): string[] {
  return [...STAGING_FIELD_ALIASES[field]];
}

interface CandidateHit {
  sourceColIndex: number;
  sourceHeader: string;
  confidence: MappingConfidence;
  score: number;
  reason: string;
}

function headerCandidatesForField(
  field: StagingTargetField,
  sourceHeaders: string[]
): CandidateHit[] {
  const hits: CandidateHit[] = [];
  const aliases = aliasesForField(field);

  sourceHeaders.forEach((header, index) => {
    const trimmed = (header ?? "").trim();
    if (!trimmed) return;

    // 1) Exact
    for (const alias of aliases) {
      if (trimmed === alias) {
        hits.push({
          sourceColIndex: index,
          sourceHeader: trimmed,
          confidence: "exact",
          score: 100,
          reason: `exact header match "${alias}"`,
        });
        return;
      }
    }

    // 2) Case-insensitive / alias
    for (const alias of aliases) {
      if (trimmed.toLowerCase() === alias.toLowerCase()) {
        hits.push({
          sourceColIndex: index,
          sourceHeader: trimmed,
          confidence: "case_insensitive",
          score: 95,
          reason: `case-insensitive match "${alias}"`,
        });
        return;
      }
    }

    // 3) Normalized alias
    const headerNorm = normalizeHeader(trimmed);
    for (const alias of aliases) {
      const aliasNorm = normalizeHeader(alias);
      if (aliasNorm && headerNorm === aliasNorm) {
        hits.push({
          sourceColIndex: index,
          sourceHeader: trimmed,
          confidence: "normalized_alias",
          score: 90,
          reason: `normalized alias match "${alias}"`,
        });
        return;
      }
    }

    // 4) Similarity against primary alias norms
    let bestSim = 0;
    let bestAlias = "";
    for (const alias of aliases) {
      const sim = similarityRatio(headerNorm, normalizeHeader(alias));
      if (sim > bestSim) {
        bestSim = sim;
        bestAlias = alias;
      }
    }
    // Also containership for shortened headers (e.g. Primary Location/Office)
    for (const alias of aliases) {
      const a = normalizeHeader(alias);
      if (
        a.length >= 8 &&
        headerNorm.length >= 8 &&
        (a.includes(headerNorm) || headerNorm.includes(a))
      ) {
        bestSim = Math.max(bestSim, 0.88);
        bestAlias = alias;
      }
    }
    if (bestSim >= 0.82) {
      hits.push({
        sourceColIndex: index,
        sourceHeader: trimmed,
        confidence: "similarity",
        score: Math.round(bestSim * 85),
        reason: `header similarity ${(bestSim * 100).toFixed(0)}% vs "${bestAlias}"`,
      });
    }
  });

  // Deduplicate by column — keep highest score
  const byCol = new Map<number, CandidateHit>();
  for (const hit of hits) {
    const prev = byCol.get(hit.sourceColIndex);
    if (!prev || hit.score > prev.score) byCol.set(hit.sourceColIndex, hit);
  }
  return [...byCol.values()].sort((a, b) => b.score - a.score);
}

function sampleColumnValues(
  dataRows: string[][],
  colIndex: number,
  limit = 40
): string[] {
  const out: string[] = [];
  for (const row of dataRows) {
    if (out.length >= limit) break;
    const v = (row[colIndex] ?? "").trim();
    if (v) out.push(v);
  }
  return out;
}

function patternScoreForField(
  field: StagingTargetField,
  samples: string[]
): { score: number; reason: string } | null {
  if (samples.length === 0) return null;

  if (field === "job_requisition_id") {
    const atci = samples.filter((s) => JR_PATTERN.test(s)).length;
    const loose = samples.filter((s) => JR_LOOSE_PATTERN.test(s)).length;
    const ratio = Math.max(atci, loose) / samples.length;
    if (ratio >= 0.7) {
      return {
        score: Math.round(70 + ratio * 20),
        reason: `JR-like values in ${(ratio * 100).toFixed(0)}% of sampled cells`,
      };
    }
    return null;
  }

  if (field === "date") {
    let ok = 0;
    for (const s of samples) {
      // Reject JR-like and long text
      if (JR_PATTERN.test(s) || s.length > 40) continue;
      const parsed = parseExcelDateToIso(s);
      if (parsed.ok && parsed.iso) ok += 1;
    }
    const ratio = ok / samples.length;
    if (ratio >= 0.7) {
      return {
        score: Math.round(65 + ratio * 20),
        reason: `date-like values in ${(ratio * 100).toFixed(0)}% of sampled cells`,
      };
    }
    return null;
  }

  if (field === "priority") {
    const hits = samples.filter((s) => PRIORITY_PATTERN.test(s.trim())).length;
    const ratio = hits / samples.length;
    if (ratio >= 0.6) {
      return {
        score: Math.round(60 + ratio * 20),
        reason: `priority-like values in ${(ratio * 100).toFixed(0)}% of samples`,
      };
    }
    return null;
  }

  if (field === "job_management_level") {
    const hits = samples.filter((s) => {
      const t = s.trim();
      if (JML_KNOWN.has(t.toLowerCase())) return true;
      return /^\d+\s*[-–]/.test(t);
    }).length;
    const ratio = hits / samples.length;
    if (ratio >= 0.5) {
      return {
        score: Math.round(60 + ratio * 20),
        reason: `JML-like values in ${(ratio * 100).toFixed(0)}% of samples`,
      };
    }
    return null;
  }

  // Do not pattern-map free-text fields (description/skills/location/poc/market)
  return null;
}

function patternCandidatesForField(
  field: StagingTargetField,
  sourceHeaders: string[],
  dataRows: string[][],
  claimed: Set<number>
): CandidateHit[] {
  const hits: CandidateHit[] = [];
  sourceHeaders.forEach((header, index) => {
    if (claimed.has(index)) return;
    const trimmed = (header ?? "").trim();
    if (!trimmed && field !== "date") {
      // still allow empty header columns for pattern? No — skip blank headers
    }
    const samples = sampleColumnValues(dataRows, index);
    const scored = patternScoreForField(field, samples);
    if (!scored) return;
    hits.push({
      sourceColIndex: index,
      sourceHeader: trimmed || `(column ${index + 1})`,
      confidence: "data_pattern",
      score: scored.score,
      reason: scored.reason,
    });
  });
  return hits.sort((a, b) => b.score - a.score);
}

/**
 * Position fallback: only when the expected New Sheet position column is still
 * free AND data-pattern (when available) also supports it, or for short
 * non-pattern fields when header is empty/garbage but position + non-empty data.
 */
function positionFallbackCandidate(
  field: StagingTargetField,
  sourceHeaders: string[],
  dataRows: string[][],
  claimed: Set<number>
): CandidateHit | null {
  const pos = STAGING_EXPECTED_POSITION[field];
  if (pos < 0 || pos >= sourceHeaders.length) return null;
  if (claimed.has(pos)) return null;

  const header = (sourceHeaders[pos] ?? "").trim();
  const samples = sampleColumnValues(dataRows, pos);
  if (samples.length === 0) return null;

  // Never position-fallback free-text fields without header support — too risky
  if (
    field === "job_description" ||
    field === "primary_skills" ||
    field === "skill_categorization" ||
    field === "poc" ||
    field === "market_map" ||
    field === "primary_location"
  ) {
    return null;
  }

  const patterned = patternScoreForField(field, samples);
  if (!patterned || patterned.score < 70) return null;

  // Require that header does NOT strongly match a different field
  return {
    sourceColIndex: pos,
    sourceHeader: header || `(column ${pos + 1})`,
    confidence: "position_fallback",
    score: Math.min(68, patterned.score - 5),
    reason: `expected position ${pos + 1} + ${patterned.reason}`,
  };
}

const AMBIGUITY_GAP = 8; // if top two within this score → ambiguous

/**
 * Map ATCI DS headers (+ optional sample rows) to staging fields.
 */
export function mapAtciDsToStagingFields(options: {
  sourceHeaders: string[];
  dataRows?: string[][];
  /** When true (default), Date may be generated if no Date column exists. */
  allowGeneratedDate?: boolean;
}): StagingMappingResult {
  const sourceHeaders = options.sourceHeaders.map((h) =>
    String(h ?? "").trim()
  );
  const dataRows = options.dataRows ?? [];
  const allowGeneratedDate = options.allowGeneratedDate !== false;

  const claimed = new Set<number>();
  const mappings: StagingFieldMapping[] = [];
  const missingFields: StagingTargetField[] = [];
  const ambiguous: StagingMappingAmbiguity[] = [];

  for (const field of STAGING_TARGET_FIELDS) {
    let candidates = headerCandidatesForField(field, sourceHeaders).filter(
      (c) => !claimed.has(c.sourceColIndex)
    );

    if (candidates.length === 0 && dataRows.length > 0) {
      candidates = patternCandidatesForField(
        field,
        sourceHeaders,
        dataRows,
        claimed
      );
    }

    if (candidates.length === 0 && dataRows.length > 0) {
      const pos = positionFallbackCandidate(
        field,
        sourceHeaders,
        dataRows,
        claimed
      );
      if (pos) candidates = [pos];
    }

    if (candidates.length === 0) {
      if (field === "date" && allowGeneratedDate) {
        mappings.push({
          field,
          sourceHeader: null,
          sourceColIndex: -1,
          confidence: "generated",
          score: 100,
          reason:
            "ATCI DS has no Date column — processing date will be generated (New Sheet parity)",
        });
        continue;
      }
      missingFields.push(field);
      continue;
    }

    const top = candidates[0];
    const second = candidates[1];
    if (
      second &&
      top.score - second.score < AMBIGUITY_GAP &&
      second.score >= 60
    ) {
      ambiguous.push({
        field,
        candidates: candidates.slice(0, 5).map((c) => ({
          sourceHeader: c.sourceHeader,
          sourceColIndex: c.sourceColIndex,
          confidence: c.confidence,
          score: c.score,
          reason: c.reason,
        })),
      });
      continue;
    }

    // Also fail if two different columns both exact/alias-level for same field
    const strong = candidates.filter((c) => c.score >= 88);
    if (strong.length > 1) {
      ambiguous.push({
        field,
        candidates: strong.map((c) => ({
          sourceHeader: c.sourceHeader,
          sourceColIndex: c.sourceColIndex,
          confidence: c.confidence,
          score: c.score,
          reason: c.reason,
        })),
      });
      continue;
    }

    claimed.add(top.sourceColIndex);
    mappings.push({
      field,
      sourceHeader: top.sourceHeader,
      sourceColIndex: top.sourceColIndex,
      confidence: top.confidence,
      score: top.score,
      reason: top.reason,
    });
  }

  if (missingFields.length > 0 || ambiguous.length > 0) {
    const parts: string[] = [
      "ATCI DS → staging intelligent mapping failed. Staging was NOT modified.",
    ];
    if (missingFields.length > 0) {
      parts.push(`Missing required field(s): ${missingFields.join(", ")}`);
    }
    for (const a of ambiguous) {
      parts.push(
        `Ambiguous mapping: target=${a.field}; candidates=${a.candidates
          .map(
            (c) =>
              `${c.sourceHeader} (col ${c.sourceColIndex + 1}, ${c.confidence}, score ${c.score})`
          )
          .join(" | ")}`
      );
    }
    parts.push(
      `Source headers: ${sourceHeaders.filter(Boolean).join(" | ") || "(none)"}`
    );
    return {
      ok: false,
      message: parts.join("\n"),
      missingFields,
      ambiguous,
      sourceHeaders,
    };
  }

  const ignoredSourceHeaders = sourceHeaders.filter(
    (h, idx) => h && !claimed.has(idx)
  );

  return {
    ok: true,
    mappings,
    ignoredSourceHeaders,
    sourceHeaders,
  };
}
