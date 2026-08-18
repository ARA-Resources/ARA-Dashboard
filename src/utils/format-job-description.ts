/**
 * Job Description display helpers.
 * Never mutate Excel data — only organize existing text for the modal UI.
 *
 * Parsing architecture lives in parse-job-description.ts (two-stage).
 * This module maps ParsedJobDescription → FormattedBlock[] for the existing modal.
 */

import {
  filterTechnicalSkillCandidates,
  hasTechnicalSkillEvidence,
  extractTechnicalSkillsFromText,
} from "@/utils/detect-technical-skills";
import {
  isResponsibilityText,
  isSkillsSectionKind,
  isSkillsPlaceholder,
  isMustHaveIndicator,
  isGoodToHaveIndicator,
  isExperienceRequirement,
  isEducationRequirement,
  formatLocationDisplay,
  parseJobDescription,
  skillsVariantForKind,
  splitResponsibilityItems,
  type ParsedJdSection,
  type ParsedJobDescription,
} from "@/utils/parse-job-description";

export type {
  JdParseMode,
  JdSectionKind,
  ParsedJdSection,
  ParsedJobDescription,
} from "@/utils/parse-job-description";

export {
  parseJobDescription,
  normalizeJobDescriptionRaw,
  splitResponsibilityItems,
  isResponsibilityText,
  isMustHaveIndicator,
  isGoodToHaveIndicator,
  isExperienceRequirement,
  isEducationRequirement,
  isSkillsPlaceholder,
  formatLocationDisplay,
} from "@/utils/parse-job-description";

export {
  extractTechnicalSkillsFromText,
  hasTechnicalSkillEvidence,
  filterTechnicalSkillCandidates,
} from "@/utils/detect-technical-skills";

export interface JobDescriptionMetaField {
  label: string;
  value: string;
}

export interface JobDescriptionOpenPayload {
  /**
   * Exact Job Description cell text from the Master Sheet (source of truth).
   * Used as-is for ORIGINAL JOB DESCRIPTION.
   */
  description: string;
  meta: JobDescriptionMetaField[];
  /**
   * Stable id for the selected Master Sheet row.
   * Modal UI + Copy + PDF bind to this so downloads never use another row.
   */
  selectionKey: string;
}

export type FormattedBlock =
  | { type: "blank" }
  | { type: "heading"; text: string }
  | { type: "bullet"; text: string }
  | { type: "number"; text: string; index: string }
  | { type: "paragraph"; text: string }
  | {
      type: "skillChips";
      /** must | good | generic */
      variant: "must" | "good" | "generic";
      /** Original skill wording fragments */
      skills: string[];
    };

const META_FIELD_MATCHERS: Array<{
  label: string;
  match: RegExp;
}> = [
  { label: "Job Requisition ID", match: /job\s*requisition\s*id/i },
  { label: "Primary Skill", match: /^primary\s*skills?\b/i },
  {
    label: "Skill Categorization",
    match: /^skill\s*categor/i,
  },
  { label: "Job Management Level", match: /job\s*management\s*level|management\s*level/i },
  {
    label: "Primary Location",
    match: /primary\s*location|location\s*\/\s*office|office\s*locate/i,
  },
];

function cellToText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).replace(/\u00a0/g, " ").trim();
}

/**
 * Pull identifying fields from the current Master Sheet row when columns exist.
 */
export function extractJobDescriptionMeta(
  headers: string[],
  row: Record<string, unknown>
): JobDescriptionMetaField[] {
  const fields: JobDescriptionMetaField[] = [];

  for (const spec of META_FIELD_MATCHERS) {
    const header = headers.find((h) => spec.match.test(h.trim()));
    if (!header) continue;
    const value = cellToText(row[header]);
    if (!value) continue;
    fields.push({ label: spec.label, value });
  }

  return fields;
}

/**
 * Split a skills blob into original wording items (no paraphrasing / renaming).
 * Returns null when we cannot confidently identify discrete skills.
 *
 * - Explicit list structure (Must/Good Have sections): keep items unless they are
 *   action verbs / placeholders (author already labeled them as skills).
 * - Prose / responsibility sentences: only return catalog-evidenced technologies.
 */
export function parseSkillChipItems(body: string): string[] | null {
  const trimmed = body.trim();
  if (!trimmed) return null;

  if (/^(n\/?a|none|nil|not\s*applicable|-|—|–|\.|null)$/i.test(trimmed)) {
    return null;
  }

  // Prose / duties → extract evidenced technologies only (never invent)
  if (isResponsibilityText(trimmed) || looksLikeRequirementProse(trimmed)) {
    const fromProse = extractTechnicalSkillsFromText(trimmed);
    return fromProse.length > 0 ? fromProse : null;
  }

  const lineParts = trimmed
    .split(/\n+/)
    .map((line) =>
      line.replace(/^\s*(?:[•·▪‣●*]|\-|\–|\—|\d+[.)])\s*/, "").trim()
    )
    .filter(Boolean);

  if (
    lineParts.some(
      (line) => isResponsibilityText(line) || looksLikeRequirementProse(line)
    )
  ) {
    const fromProse = extractTechnicalSkillsFromText(trimmed);
    return fromProse.length > 0 ? fromProse : null;
  }

  let items: string[];
  if (lineParts.length > 1) {
    items = lineParts.flatMap((line) => splitInlineList(line));
  } else {
    items = splitInlineList(trimmed);
  }

  items = items
    .map((item) =>
      item
        .replace(/^(?:and|or)\s+/i, "")
        .replace(/[.,;:]+$/g, "")
        .replace(/\s+/g, " ")
        .trim()
    )
    .filter(Boolean);

  const hasListStructure =
    /[,;/|·\n]/.test(trimmed) ||
    /(?:^|\n)\s*(?:[•·▪‣●*]|\-|\–|\—|\d+[.)])\s+/.test(trimmed);

  // Single known technology (e.g. "Java") counts as a confident skill item
  if (!hasListStructure) {
    if (items.length === 1 && hasTechnicalSkillEvidence(items[0] ?? "")) {
      return [items[0]];
    }
    const fromProse = extractTechnicalSkillsFromText(trimmed);
    return fromProse.length > 0 ? fromProse : null;
  }

  // Drop action verbs only — do not drop author-listed skills for lack of catalog hit
  const cleaned = items.filter((item) => {
    const key = item.toLowerCase();
    if (!key) return false;
    if (
      /^(?:build|develop|design|configure|implement|maintain|support|test|deploy|manage|analyze|analyse|monitor|troubleshoot|collaborate|provide|lead)$/i.test(
        key
      )
    ) {
      return false;
    }
    return true;
  });

  if (cleaned.length === 0) return null;

  // Comma-separated requirement prose must not become skill chips
  const proseLike = cleaned.filter(looksLikeProseSkillFragment);
  if (
    proseLike.length >= Math.max(1, Math.ceil(cleaned.length * 0.4)) ||
    cleaned.some((item) => item.split(/\s+/).length > 8)
  ) {
    const fromProse = extractTechnicalSkillsFromText(trimmed);
    return fromProse.length > 0 ? fromProse : null;
  }

  // Keep only short discrete skill labels
  const shortSkills = cleaned.filter(
    (item) =>
      !looksLikeProseSkillFragment(item) && item.split(/\s+/).length <= 6
  );
  if (shortSkills.length === 0) {
    const fromProse = extractTechnicalSkillsFromText(trimmed);
    return fromProse.length > 0 ? fromProse : null;
  }

  // If every remaining item is a bare action-like fragment, refuse
  if (
    shortSkills.every((item) => {
      const words = item.trim().split(/\s+/);
      return (
        words.length <= 2 &&
        /^(?:build|develop|design|configure|implement|maintain|support|test|deploy|manage)$/i.test(
          words[0] ?? ""
        )
      );
    })
  ) {
    return null;
  }

  const seen = new Set<string>();
  const unique: string[] = [];
  for (const item of shortSkills) {
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }

  return unique.length > 0 ? unique : null;
}

/** True when a comma-split fragment is requirement prose, not a skill label. */
function looksLikeProseSkillFragment(item: string): boolean {
  const compact = item.replace(/\s+/g, " ").trim();
  if (!compact) return true;
  const words = compact.split(/\s+/);
  if (words.length > 6) return true;
  if (compact.length > 55) return true;
  if (
    /^(?:this|these|they|the|a|an|strong|hands[-\s]?on|experience|ability|familiarity|understanding|preferred|ideal|working|comfortable|able|detail[-\s]?oriented|technically|candidates?|success)\b/i.test(
      compact
    )
  ) {
    return true;
  }
  if (/\b(?:should|must|preferred|including|across|that|which|with the)\b/i.test(compact)) {
    return true;
  }
  return false;
}

/**
 * Multi-sentence / requirement-style prose — not a short skill list.
 */
function looksLikeRequirementProse(text: string): boolean {
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) return false;
  if (compact.length > 220) return true;
  if ((compact.match(/\./g) || []).length >= 2) return true;
  if (
    /^(?:experience|strong|ability|familiarity|understanding|preferred|ideal candidate|this person|hands[-\s]?on)\b/i.test(
      compact
    ) &&
    compact.split(/\s+/).length > 10
  ) {
    return true;
  }
  return false;
}

function splitInlineList(text: string): string[] {
  if (/[,;/|·]/.test(text) || /\s+and\s+/i.test(text)) {
    return text
      .split(/\s*(?:,|;|\/|\||·|\band\b)\s*/i)
      .map((part) => part.trim())
      .filter(Boolean);
  }
  return [text.trim()].filter(Boolean);
}

function appendProseBlocks(body: string, blocks: FormattedBlock[]) {
  const lines = body.replace(/\n{3,}/g, "\n\n").split("\n");

  for (const line of lines) {
    if (!line.trim()) {
      if (blocks.length === 0 || blocks[blocks.length - 1]?.type === "blank") {
        continue;
      }
      blocks.push({ type: "blank" });
      continue;
    }

    const bullet = line.match(/^\s*(?:[•·▪‣●*]|\-|\–|\—)\s+(.*)$/);
    if (bullet) {
      blocks.push({ type: "bullet", text: bullet[1].trimEnd() });
      continue;
    }

    const numbered = line.match(/^\s*(\d+)[.)]\s+(.*)$/);
    if (numbered) {
      blocks.push({
        type: "number",
        index: numbered[1],
        text: numbered[2].trimEnd(),
      });
      continue;
    }

    blocks.push({ type: "paragraph", text: line.trimEnd() });
  }
}

function appendResponsibilitiesBlocks(body: string, blocks: FormattedBlock[]) {
  const items = splitResponsibilityItems(body);
  if (items.length === 0) {
    appendProseBlocks(body, blocks);
    return;
  }

  // Single short non-list line can stay as paragraph; multi-items → bullets
  if (items.length === 1 && !/^\s*(?:[•·▪‣●*]|\d+[.)])\s+/m.test(body)) {
    const only = items[0];
    // Still show as a bullet when it is clearly a responsibility duty
    if (isResponsibilityText(only)) {
      blocks.push({ type: "bullet", text: only });
      return;
    }
    appendProseBlocks(body, blocks);
    return;
  }

  for (const item of items) {
    blocks.push({ type: "bullet", text: item });
  }
}

function appendGoodToHaveBlocks(body: string, blocks: FormattedBlock[]) {
  if (isSkillsPlaceholder(body)) {
    blocks.push({ type: "paragraph", text: "None specified" });
    return;
  }

  let skills = parseSkillChipItems(body);
  if (!skills || skills.length === 0) {
    const extracted = extractTechnicalSkillsFromText(body);
    skills = extracted.length > 0 ? extracted : null;
  }

  if (skills && skills.length > 0) {
    blocks.push({ type: "skillChips", variant: "good", skills });
    // Pure skill lists — chips only (avoid duplicating "Java, SQL" as prose)
    if (isPureSkillListBody(body)) return;
  }

  // Requirement prose → bullets (never chip-fragment sentences)
  if (looksLikeRequirementProse(body) || !isPureSkillListBody(body)) {
    appendSkillRequirementProse(body, blocks);
    return;
  }

  appendProseBlocks(body, blocks);
}

function appendMustHaveBlocks(body: string, blocks: FormattedBlock[]) {
  if (isSkillsPlaceholder(body)) {
    blocks.push({ type: "paragraph", text: "None specified" });
    return;
  }

  // Chips from evidenced technologies / list items — never invent
  let skills = parseSkillChipItems(body);
  if (!skills || skills.length === 0) {
    const extracted = extractTechnicalSkillsFromText(body);
    skills = extracted.length > 0 ? extracted : null;
  }

  if (skills && skills.length > 0) {
    blocks.push({ type: "skillChips", variant: "must", skills });
    if (isPureSkillListBody(body)) return;
  }

  // Requirement prose → bullets (never chip-fragment sentences)
  if (looksLikeRequirementProse(body) || !isPureSkillListBody(body)) {
    appendSkillRequirementProse(body, blocks);
    return;
  }

  appendProseBlocks(body, blocks);
}

/**
 * Keep Must/Good Have requirement sentences readable as bullets,
 * not as comma-split skill chips.
 */
function appendSkillRequirementProse(body: string, blocks: FormattedBlock[]) {
  const lines = body
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((line) => line.replace(/^\s*(?:[•·▪‣●*]|\-|\–|\—|\d+[.)])\s*/, "").trim())
    .filter(Boolean);

  if (lines.length === 0) {
    appendProseBlocks(body, blocks);
    return;
  }

  // Prefer sentence split for long multi-sentence lines
  const units = lines.flatMap((line) => {
    if (line.length < 140 || !/[.!?]\s+/.test(line)) return [line];
    return line
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter(Boolean);
  });

  for (const unit of units) {
    // Skip section labels that are not requirements
    if (/^(?:ideal candidate profile|success measures|and experience)$/i.test(unit)) {
      blocks.push({ type: "paragraph", text: unit });
      continue;
    }
    blocks.push({ type: "bullet", text: unit });
  }
}

/** True when body is only a short skill list (chips alone are enough). */
function isPureSkillListBody(body: string): boolean {
  const compact = body.replace(/\s+/g, " ").trim();
  if (!compact) return false;
  if (isResponsibilityText(compact)) return false;
  // Contextual prose around skills — keep original wording under chips
  if (
    /\b(?:experience|knowledge|proficient|familiar|strong|hands[-\s]?on|enterprise|years?)\b/i.test(
      compact
    ) &&
    compact.split(/\s+/).length > 6
  ) {
    return false;
  }
  if (/[,;/|]/.test(compact)) {
    const parts = compact.split(/\s*[,;/|]\s*/).filter(Boolean);
    return (
      parts.length >= 1 &&
      parts.every((p) => p.split(/\s+/).length <= 4) &&
      compact.length <= 140
    );
  }
  if (/\s+and\s+/i.test(compact)) {
    const parts = compact.split(/\s+and\s+/i).filter(Boolean);
    return (
      parts.length >= 2 &&
      parts.every((p) => p.split(/\s+/).length <= 3) &&
      compact.length <= 100
    );
  }
  return (
    compact.split(/\s+/).length <= 6 &&
    !/\b(?:with|for|using|from|about)\b/i.test(compact)
  );
}

/** Experience requirements as bullets — never skill chips. */
function appendExperienceBlocks(body: string, blocks: FormattedBlock[]) {
  const lines = body
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((line) => line.replace(/^\s*(?:[•·▪‣●*]|\-|\–|\—)\s+/, "").trim())
    .filter(Boolean);

  if (lines.length === 0) {
    appendProseBlocks(body, blocks);
    return;
  }

  for (const line of lines) {
    blocks.push({
      type: "bullet",
      text: line.replace(/\.$/, "").trim() || line,
    });
  }
}

/**
 * Education requirements as bullets.
 * Degree lists like "BE/MBA/MTech" display as "BE / MBA / MTech".
 */
function appendEducationBlocks(body: string, blocks: FormattedBlock[]) {
  const lines = body
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((line) => line.replace(/^\s*(?:[•·▪‣●*]|\-|\–|\—)\s+/, "").trim())
    .filter(Boolean);

  if (lines.length === 0) {
    appendProseBlocks(body, blocks);
    return;
  }

  for (const line of lines) {
    blocks.push({ type: "bullet", text: formatEducationDegreeLine(line) });
  }
}

/** Location as bullets — prefer place name when available. */
function appendLocationBlocks(body: string, blocks: FormattedBlock[]) {
  const lines = body
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((line) => line.replace(/^\s*(?:[•·▪‣●*]|\-|\–|\—)\s+/, "").trim())
    .filter(Boolean);

  if (lines.length === 0) {
    appendProseBlocks(body, blocks);
    return;
  }

  for (const line of lines) {
    blocks.push({ type: "bullet", text: formatLocationDisplay(line) });
  }
}

/** Light separator spacing for degree lists — does not invent credentials. */
function formatEducationDegreeLine(text: string): string {
  const trimmed = text.trim();
  // Only re-space slash-separated short credential lists
  if (
    /^(?:[A-Za-z.]{1,12})(?:\s*\/\s*[A-Za-z.]{1,12})+\.?$/.test(trimmed)
  ) {
    return trimmed
      .replace(/\s*\/\s*/g, " / ")
      .replace(/\.$/, "")
      .trim();
  }
  return trimmed;
}

function appendSectionToBlocks(
  section: ParsedJdSection,
  blocks: FormattedBlock[]
) {
  const content = section.rawBody;
  if (!content.trim()) return;

  const sectionBlocks: FormattedBlock[] = [];

  if (section.kind === "responsibilities") {
    appendResponsibilitiesBlocks(content, sectionBlocks);
  } else if (section.kind === "must-have-skills") {
    appendMustHaveBlocks(content, sectionBlocks);
  } else if (section.kind === "good-to-have-skills") {
    appendGoodToHaveBlocks(content, sectionBlocks);
  } else if (section.kind === "experience") {
    appendExperienceBlocks(content, sectionBlocks);
  } else if (section.kind === "education") {
    appendEducationBlocks(content, sectionBlocks);
  } else if (section.kind === "location") {
    appendLocationBlocks(content, sectionBlocks);
  } else if (
    section.kind === "project-role" ||
    section.kind === "role-description"
  ) {
    const cleaned = content.replace(/\s+/g, " ").replace(/\.$/, "").trim();
    sectionBlocks.push({ type: "paragraph", text: cleaned || content.trim() });
  } else if (section.kind === "technical-skills") {
    const variant = skillsVariantForKind(section.kind) ?? "generic";
    let skills = parseSkillChipItems(content);
    if (!skills || skills.length === 0) {
      const extracted = extractTechnicalSkillsFromText(content);
      skills = extracted.length > 0 ? extracted : null;
    }
    if (skills && skills.length > 0) {
      sectionBlocks.push({ type: "skillChips", variant, skills });
    } else {
      appendProseBlocks(content, sectionBlocks);
    }
  } else if (
    section.kind === "additional-information" ||
    section.kind === "other-information"
  ) {
    appendReadableInfoBlocks(content, sectionBlocks);
  } else if (isSkillsSectionKind(section.kind)) {
    const variant = skillsVariantForKind(section.kind);
    const skills = parseSkillChipItems(content);
    if (variant && skills) {
      sectionBlocks.push({ type: "skillChips", variant, skills });
    } else {
      appendProseBlocks(content, sectionBlocks);
    }
  } else {
    appendProseBlocks(content, sectionBlocks);
  }

  // Never emit empty sections (heading with no content)
  if (sectionBlocks.length === 0) return;

  if (blocks.length > 0) {
    blocks.push({ type: "blank" });
  }
  blocks.push({ type: "heading", text: section.title });
  blocks.push(...sectionBlocks);
}

/**
 * ADDITIONAL / OTHER INFORMATION — readable paragraphs and bullets.
 * Preserves original wording; prefers bullets when the body is list-like.
 */
function appendReadableInfoBlocks(body: string, blocks: FormattedBlock[]) {
  const lines = body
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);

  if (lines.length === 0) {
    appendProseBlocks(body, blocks);
    return;
  }

  const listLike =
    lines.length > 1 ||
    lines.some((line) => /^\s*(?:[•·▪‣●*]|\-|\–|\—|\d+[.)])\s+/.test(line));

  if (!listLike) {
    appendProseBlocks(body, blocks);
    return;
  }

  for (const line of lines) {
    const bullet = line.match(/^\s*(?:[•·▪‣●*]|\-|\–|\—)\s+(.*)$/);
    if (bullet) {
      blocks.push({ type: "bullet", text: bullet[1].trim() });
      continue;
    }
    const numbered = line.match(/^\s*(\d+)[.)]\s+(.*)$/);
    if (numbered) {
      blocks.push({
        type: "number",
        index: numbered[1],
        text: numbered[2].trim(),
      });
      continue;
    }
    // Multi-line info body → bullets for scanability (wording unchanged)
    if (lines.length > 1) {
      blocks.push({ type: "bullet", text: line.trim() });
    } else {
      blocks.push({ type: "paragraph", text: line.trim() });
    }
  }
}

/**
 * Organize Job Description text into headed sections + readable blocks.
 * Uses the two-stage parser; source text is never summarized or dropped.
 */
export function formatJobDescriptionBlocks(raw: string): FormattedBlock[] {
  const parsed = parseJobDescription(raw);
  return formatParsedJobDescription(parsed);
}

/** Map a ParsedJobDescription to modal FormattedBlocks (UI-agnostic mapping). */
export function formatParsedJobDescription(
  parsed: ParsedJobDescription
): FormattedBlock[] {
  if (!parsed.raw.trim() || parsed.sections.length === 0) {
    if (!parsed.raw.trim()) return [];
    // Safety: always show original if sections somehow empty
    const blocks: FormattedBlock[] = [];
    appendProseBlocks(parsed.raw, blocks);
    return blocks;
  }

  const blocks: FormattedBlock[] = [];
  for (const section of parsed.sections) {
    if (!section.rawBody.trim()) continue;
    appendSectionToBlocks(section, blocks);
  }
  return blocks;
}

/** @deprecated kept for callers that still import prepare helpers */
export function prepareJobDescriptionText(raw: string): string {
  return String(raw ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
}
