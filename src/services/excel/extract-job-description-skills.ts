import {
  isBlankSkillPlaceholder,
  toNormalizedSkillPair,
} from "@/services/excel/normalize-skill";
import { dedupeExtractedSkills } from "@/services/excel/skill-library";
import type { ExtractedSkill } from "@/types/opening-skills";

const MUST_HAVE_LABEL =
  /must\s*(?:to\s*)?have\s*skills?\s*[:\-–—]?\s*/i;
const GOOD_TO_HAVE_LABEL =
  /good\s*(?:to\s*)?have\s*skills?\s*[:\-–—]?\s*/i;

/** Sections that typically follow the must/good skill lines in Accenture JDs */
const SECTION_STOP =
  /(?:good\s*(?:to\s*)?have\s*skills?|must\s*(?:to\s*)?have\s*skills?|minimum\s+[\d.]+\s*year|educational\s*qualification|summary\s*:|project\s*role\s*(?:description)?\s*:|roles?\s*&\s*responsibilities|professional\s*(?:&|and)\s*technical\s*skills|additional\s*information|key\s*responsibilities|job\s*requirements|technical\s*experience|professional\s*attributes)/i;

/**
 * Capture the raw text after a Must/Good Have label until the next section.
 */
export function extractSkillSectionRaw(
  jobDescription: string,
  kind: "must" | "good"
): string | null {
  if (!jobDescription) return null;

  const label = kind === "must" ? MUST_HAVE_LABEL : GOOD_TO_HAVE_LABEL;
  const match = label.exec(jobDescription);
  if (!match || match.index == null) return null;

  const start = match.index + match[0].length;
  const rest = jobDescription.slice(start);
  const stop = SECTION_STOP.exec(rest);

  // When extracting must-have, always stop at good-to-have if present
  if (kind === "must") {
    const good = GOOD_TO_HAVE_LABEL.exec(rest);
    if (good && good.index != null) {
      const stopAt =
        stop && stop.index != null
          ? Math.min(good.index, stop.index)
          : good.index;
      return rest.slice(0, stopAt).trim();
    }
  }

  if (stop && stop.index != null) {
    return rest.slice(0, stop.index).trim();
  }

  // Prefer first line when no clear section follows
  const firstLine = rest.split(/\r?\n/, 1)[0] ?? rest;
  return firstLine.trim();
}

/**
 * Split a raw skills blob into individual skill strings (original wording).
 */
export function splitSkillList(raw: string | null | undefined): string[] {
  if (!raw) return [];

  const compact = raw.replace(/\u00a0/g, " ").replace(/\r\n/g, "\n").trim();
  if (!compact || isBlankSkillPlaceholder(compact)) return [];

  // Prefer newline / bullet splits when the blob is multi-line
  const lineParts = compact
    .split(/\n+/)
    .map((line) => line.replace(/^[\s•·\-\–\—*]+/, "").trim())
    .filter(Boolean);

  const candidates =
    lineParts.length > 1
      ? lineParts.flatMap((line) => splitCommaLike(line))
      : splitCommaLike(compact);

  const seen = new Set<string>();
  const skills: string[] = [];

  for (const part of candidates) {
    const pair = toNormalizedSkillPair(part);
    if (!pair) continue;
    if (seen.has(pair.normalized)) continue;
    seen.add(pair.normalized);
    skills.push(pair.original);
  }

  return skills;
}

function splitCommaLike(value: string): string[] {
  // Split on commas / semicolons / pipes; keep phrases like "Oil & Gas"
  return value
    .split(/\s*[;|]+\s*|\s*,\s*/)
    .map((part) =>
      part
        .replace(/^(?:and|or)\s+/i, "")
        .replace(/\s+/g, " ")
        .trim()
    )
    .filter(Boolean);
}

export function toExtractedSkills(raw: string | null | undefined): ExtractedSkill[] {
  const skills: ExtractedSkill[] = [];
  for (const original of splitSkillList(raw)) {
    const pair = toNormalizedSkillPair(original);
    if (!pair) continue;
    skills.push(pair);
  }
  return dedupeExtractedSkills(skills);
}

/**
 * Parse Must Have + Good to Have skills from a full Job Description cell.
 */
export function extractSkillsFromJobDescription(jobDescription: string): {
  mustHaveSkills: ExtractedSkill[];
  goodToHaveSkills: ExtractedSkill[];
  mustHaveRaw: string | null;
  goodToHaveRaw: string | null;
} {
  const mustHaveRaw = extractSkillSectionRaw(jobDescription, "must");
  const goodToHaveRaw = extractSkillSectionRaw(jobDescription, "good");

  return {
    mustHaveRaw,
    goodToHaveRaw,
    mustHaveSkills: toExtractedSkills(mustHaveRaw),
    goodToHaveSkills: toExtractedSkills(goodToHaveRaw),
  };
}
