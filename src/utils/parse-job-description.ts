/**
 * Two-stage Job Description parser.
 *
 * Stage 1 — Explicit section headings (when present)
 * Stage 2 — Unstructured sentence classification (when no headings)
 * Stage 3 — Information completeness check (missing → OTHER INFORMATION)
 *
 * Never summarizes, paraphrases, deletes, or invents content.
 * Never mutates Excel data — analysis only.
 */

import {
  extractTechnicalSkillsFromText,
  hasTechnicalSkillEvidence,
} from "@/utils/detect-technical-skills";

export type JdParseMode = "structured" | "unstructured";

export type JdSectionKind =
  | "project-role"
  | "role-description"
  | "summary"
  | "responsibilities"
  | "technical-skills"
  | "must-have-skills"
  | "good-to-have-skills"
  | "experience"
  | "education"
  | "additional-information"
  | "location"
  | "other-information";

export interface ParsedJdSection {
  kind: JdSectionKind;
  /** Canonical display title (uppercase). */
  title: string;
  /** Original section body text — never rewritten. */
  rawBody: string;
  /** How this section was produced. */
  source: "explicit" | "inferred";
}

export interface ParsedJobDescription {
  /** Full original Job Description (normalized newlines only). */
  raw: string;
  mode: JdParseMode;
  sections: ParsedJdSection[];
}

interface ExplicitSectionDef {
  kind: JdSectionKind;
  title: string;
  /** Global regex; more specific patterns should be listed earlier. */
  pattern: RegExp;
  /**
   * Soft breaks (e.g. standalone "Minimum N years…") are not real headings.
   * They must not carve into protected sections like ADDITIONAL INFORMATION.
   */
  soft?: boolean;
}

interface ExplicitMatch {
  start: number;
  labelEnd: number;
  kind: JdSectionKind;
  title: string;
  labelLength: number;
  soft?: boolean;
}

/** Sections whose bodies must stay intact until the next hard (non-soft) heading. */
const PRESERVE_BODY_SECTION_KINDS = new Set<JdSectionKind>([
  "additional-information",
]);

const SECTION_TITLES: Record<JdSectionKind, string> = {
  "project-role": "PROJECT ROLE",
  "role-description": "PROJECT ROLE DESCRIPTION",
  summary: "SUMMARY",
  responsibilities: "RESPONSIBILITIES",
  "technical-skills": "TECHNICAL SKILLS",
  "must-have-skills": "MUST HAVE SKILLS",
  "good-to-have-skills": "GOOD TO HAVE SKILLS",
  experience: "EXPERIENCE",
  education: "EDUCATION",
  "additional-information": "ADDITIONAL INFORMATION",
  location: "LOCATION",
  "other-information": "OTHER INFORMATION",
};

/**
 * Explicit headings — longer / more specific patterns first.
 * Handles capitalization, extra spaces, colon/hyphen after label.
 */
const EXPLICIT_SECTION_DEFS: ExplicitSectionDef[] = [
  {
    kind: "role-description",
    title: SECTION_TITLES["role-description"],
    pattern: /project\s*role\s*description\s*[:\-–—]?\s*/gi,
  },
  {
    kind: "role-description",
    title: "ROLE DESCRIPTION",
    pattern: /role\s*description\s*[:\-–—]?\s*/gi,
  },
  {
    kind: "responsibilities",
    title: "KEY RESPONSIBILITIES",
    pattern: /key\s*responsibilities\s*[:\-–—]?\s*/gi,
  },
  {
    kind: "responsibilities",
    title: "ROLES & RESPONSIBILITIES",
    pattern: /roles?\s*&\s*responsibilities\s*[:\-–—]?\s*/gi,
  },
  {
    kind: "responsibilities",
    title: SECTION_TITLES.responsibilities,
    pattern: /responsibilities\s*[:\-–—]?\s*/gi,
  },
  {
    kind: "must-have-skills",
    title: SECTION_TITLES["must-have-skills"],
    // Longer / more specific mandatory markers first
    pattern:
      /(?:required\s+experience\s+with|candidate\s+must\s+have|candidate\s+should\s+have|strong\s+experience\s+in|must[-\s]+(?:to\s+)?have(?:\s+skills?)?|mandatory\s+skills?|essential\s+skills?|required\s+skills?)\s*[:\-–—]?\s*/gi,
  },
  {
    kind: "good-to-have-skills",
    title: SECTION_TITLES["good-to-have-skills"],
    // Explicit preferred / desirable markers only — never invent
    pattern:
      /(?:good[-\s]+to[-\s]+have(?:\s*skills?)?|nice[-\s]+to[-\s]+have(?:\s*skills?)?|preferred\s*skills?|desired\s*skills?|desirable\s*skills?|added\s+advantage|(?:^|[\n\r])\s*preferred\b|(?:^|[\n\r])\s*(?:desired|desirable)\b|(?:^|[\n\r])\s*plus\b)\s*[:\-–—]?\s*/gi,
  },
  {
    kind: "technical-skills",
    title: SECTION_TITLES["technical-skills"],
    pattern:
      /(?:professional\s*(?:&|and)\s*technical\s*skills|technical\s*skills)\s*[:\-–—]?\s*/gi,
  },
  {
    kind: "education",
    title: SECTION_TITLES.education,
    // Require colon/dash after label so prose like "higher education clients" never matches.
    // Colon form may appear mid-sentence ("…team. Educational Qualification: BE").
    pattern:
      /(?:educational\s*qualifications?|(?:^|[\n\r])\s*qualifications|(?:^|[\n\r])\s*education)\s*[:\-–—]\s*/gi,
  },
  {
    kind: "experience",
    title: SECTION_TITLES.experience,
    // Do not steal "Required experience with <skill>" (handled as Must Have)
    pattern: /required\s*experience\s*[:\-–—](?!\s*with\b)\s*/gi,
  },
  {
    kind: "experience",
    title: SECTION_TITLES.experience,
    // Labels only — not prose like "Minimum 5 year(s) of experience is required"
    pattern:
      /(?:technical\s*experience|professional\s*attributes|years?\s+of\s+experience|(?:^|[\n\r])\s*experience)\s*[:\-–—]\s*/gi,
  },
  {
    kind: "additional-information",
    title: SECTION_TITLES["additional-information"],
    // Explicit Additional Information only — body preserved until next hard section
    pattern: /additional\s*information\s*[:\-–—]?\s*/gi,
  },
  {
    kind: "other-information",
    title: SECTION_TITLES["other-information"],
    // Explicit Other Information / Other Requirements labels
    pattern: /(?:other\s*information|other\s*requirements?)\s*[:\-–—]?\s*/gi,
  },
  {
    kind: "summary",
    title: "JOB SUMMARY",
    pattern: /job\s*summary\s*[:\-–—]?\s*/gi,
  },
  {
    kind: "summary",
    title: SECTION_TITLES.summary,
    pattern: /(?:^|[\n\r])\s*summary\s*[:\-–—]?\s*/gi,
  },
  {
    kind: "location",
    title: SECTION_TITLES.location,
    pattern: /(?:^|[\n\r])\s*location\s*[:\-–—]\s*/gi,
  },
  {
    kind: "project-role",
    title: SECTION_TITLES["project-role"],
    pattern: /project\s*role\s*[:\-–—]?\s*/gi,
  },
  {
    kind: "experience",
    title: SECTION_TITLES.experience,
    // Soft break before standalone experience-requirement lines (body kept intact).
    // Never splits ADDITIONAL INFORMATION (filtered in findExplicitSectionMatches).
    soft: true,
    pattern:
      /(?:^|[\n\r])\s*(?=(?:minimum\s+\d+(?:\.\d+)?\s*year|\d+\+\s*years?\b|\d+\s*years?\s+of\b|experienced\s+professional\b))/gi,
  },
];

/** Normalize line endings / NBSP only — never rewrite wording. */
export function normalizeJobDescriptionRaw(raw: string): string {
  return String(raw ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
}

function findExplicitSectionMatches(text: string): ExplicitMatch[] {
  const found: ExplicitMatch[] = [];

  for (const def of EXPLICIT_SECTION_DEFS) {
    const re = new RegExp(def.pattern.source, "gi");
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      if (match[0].length === 0) {
        re.lastIndex += 1;
        continue;
      }
      found.push({
        start: match.index,
        labelEnd: match.index + match[0].length,
        kind: def.kind,
        title: def.title,
        labelLength: match[0].length,
        soft: Boolean(def.soft),
      });
    }
  }

  found.sort((a, b) => a.start - b.start || b.labelLength - a.labelLength);

  const hardSorted = found
    .filter((m) => !m.soft)
    .sort((a, b) => a.start - b.start || b.labelLength - a.labelLength);

  const isLineStart = (index: number) => {
    if (index <= 0) return true;
    // Patterns often capture the leading newline in the match — treat that as line-start
    if (/[\n\r]/.test(text[index] ?? "")) return true;
    return /[\n\r]/.test(text[index - 1] ?? "");
  };

  const owningPreserveSection = (index: number): ExplicitMatch | null => {
    let owning: ExplicitMatch | null = null;
    for (const hard of hardSorted) {
      if (hard.start > index) break;
      if (PRESERVE_BODY_SECTION_KINDS.has(hard.kind)) {
        owning = hard;
      } else if (owning && hard.start > owning.start) {
        // A later hard section ends the preserve span — but only if it is a
        // line-start heading (checked by the caller for candidates inside the span).
        if (isLineStart(hard.start)) {
          owning = null;
        }
      }
    }
    return owning;
  };

  const filtered = found.filter((candidate) => {
    const owning = owningPreserveSection(candidate.start);
    if (!owning) return true;
    // The Additional Information heading itself
    if (candidate.start === owning.start) return true;
    // Soft breaks never carve Additional Information
    if (candidate.soft) return false;
    // Only an explicit line-start heading may end Additional Information
    return isLineStart(candidate.start);
  });

  const kept: ExplicitMatch[] = [];
  let cursor = 0;
  for (const candidate of filtered) {
    if (candidate.start < cursor) continue;
    kept.push(candidate);
    cursor = candidate.labelEnd;
  }

  return kept;
}

/**
 * Stage 1 — parse when explicit section headings exist.
 */
function parseStructuredJobDescription(text: string): ParsedJobDescription {
  const matches = findExplicitSectionMatches(text);
  const sections: ParsedJdSection[] = [];

  const preamble = text.slice(0, matches[0].start);
  if (preamble.trim()) {
    sections.push({
      kind: "other-information",
      title: SECTION_TITLES["other-information"],
      rawBody: preamble.replace(/^\n+/, "").replace(/\n+$/, ""),
      source: "inferred",
    });
  }

  for (let i = 0; i < matches.length; i += 1) {
    const current = matches[i];
    const nextStart =
      i + 1 < matches.length ? matches[i + 1].start : text.length;
    const rawBody = text.slice(current.labelEnd, nextStart);
    if (!rawBody.trim()) continue;

    const trimmedBody = normalizeSkillSectionBody(
      rawBody.replace(/^\n+/, "").replace(/\n+$/, "")
    );

    // Keep experience requirements out of Good/Must Have skill bodies
    if (
      current.kind === "good-to-have-skills" ||
      current.kind === "must-have-skills"
    ) {
      const peeled = peelExperienceFromSkillBody(trimmedBody);
      const skillBody = normalizeSkillSectionBody(peeled.skillBody);
      if (skillBody) {
        sections.push({
          kind: current.kind,
          title: current.title,
          rawBody: skillBody,
          source: "explicit",
        });
      } else if (isSkillsPlaceholder(trimmedBody)) {
        sections.push({
          kind: current.kind,
          title: current.title,
          rawBody: "NA",
          source: "explicit",
        });
      }
      for (const line of peeled.experienceLines) {
        sections.push({
          kind: "experience",
          title: SECTION_TITLES.experience,
          rawBody: line,
          source: "inferred",
        });
      }
      continue;
    }

    sections.push({
      kind: current.kind,
      title: current.title,
      rawBody: trimmedBody,
      source: "explicit",
    });
  }

  return {
    raw: text,
    mode: "structured",
    sections: refineMixedStructuredSections(sections),
  };
}

// ── Stage 2: unstructured classification ───────────────────────────────────

type InferredKind = Exclude<JdSectionKind, never>;

interface ClassifiedSpan {
  kind: InferredKind;
  text: string;
  confident: boolean;
}

/**
 * Verbs that describe what the person will DO (responsibilities), not skill names.
 */
export const RESPONSIBILITY_VERBS = [
  "build",
  "develop",
  "design",
  "configure",
  "implement",
  "maintain",
  "support",
  "test",
  "deploy",
  "manage",
  "analyze",
  "analyse",
  "monitor",
  "troubleshoot",
  "collaborate",
  "provide",
  "lead",
  "create",
  "ensure",
  "work",
  "deliver",
  "own",
  "drive",
  "coordinate",
  "facilitate",
  "review",
  "write",
  "define",
  "establish",
  "optimize",
  "optimise",
  "resolve",
  "assist",
  "mentor",
  "guide",
  "document",
  "participate",
  "perform",
  "execute",
  "operate",
  "select",
  "use",
  "utilize",
  "utilise",
] as const;

const RESPONSIBILITY_START = new RegExp(
  `^(?:${RESPONSIBILITY_VERBS.join("|")})\\b`,
  "i"
);

/** Degree / credential tokens used for education requirements only. */
const DEGREE_TOKEN =
  /\b(?:b\.?\s*e\.?|b\.?\s*tech|m\.?\s*tech|m\.?\s*e\.?|mba|bachelor(?:'s)?|master(?:'s)?|diploma|post[\s-]?graduate)\b/i;

const DEGREE_LIST =
  /^(?:(?:b\.?\s*e\.?|be|b\.?\s*tech|m\.?\s*tech|m\.?\s*e\.?|mba|bachelor(?:'s)?(?:\s+degree)?|master(?:'s)?(?:\s+degree)?)(?:\s*[\/|,]\s*(?:b\.?\s*e\.?|be|b\.?\s*tech|m\.?\s*tech|m\.?\s*e\.?|mba|bachelor(?:'s)?(?:\s+degree)?|master(?:'s)?(?:\s+degree)?))+)\.?$/i;

const EXPERIENCE_HINT =
  /\b(?:minimum\s+\d+(?:\.\d+)?\s*years?(?:\s*\(\s*s\s*\))?|\d+\+\s*years?\b|\d+\s*year\(s\)\s+of\s+experience|\d+\s*years?\s+of(?:\s+\w+){0,4}\s+experience|\d+\s*years?(?:\s+of)?\s+experience|years?\s+of\s+(?:relevant\s+)?experience|experienced\s+professional|required\s+experience(?!\s+with\b))\b/i;

const LOCATION_HINT =
  /^(?:location|based\s+in|located\s+in|work\s+from|position\s+based\s+in|onsite|on[\s-]?site|remote|hybrid)\b/i;

const LOCATION_INLINE =
  /\b(?:position\s+)?(?:based|located)\s+in\s+(.+?)\.?$/i;

const MUST_HAVE_INDICATOR =
  /^(?:must[-\s]+(?:to\s+)?have|required\s+skills?|mandatory\s+skills?|essential\s+skills?|required\s+experience\s+with|candidate\s+(?:must|should)\s+have|strong\s+experience\s+in)\b/i;

/** True when text explicitly marks a mandatory / required skill requirement. */
export function isMustHaveIndicator(text: string): boolean {
  const compact = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!compact) return false;
  return MUST_HAVE_INDICATOR.test(compact);
}

const GOOD_TO_HAVE_INDICATOR =
  /^(?:good[-\s]+to[-\s]+have|nice[-\s]+to[-\s]+have|preferred(?:\s+skills?)?|desired(?:\s+skills?)?|desirable(?:\s+skills?)?|added\s+advantage|plus)\b/i;

/** True when text explicitly marks a preferred / desirable skill requirement. */
export function isGoodToHaveIndicator(text: string): boolean {
  const compact = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!compact) return false;
  // Experience requirements are never Good To Have
  if (isExperienceRequirement(compact) && !GOOD_TO_HAVE_INDICATOR.test(compact)) {
    return false;
  }
  if (/^minimum\s+\d+/i.test(compact)) return false;
  return GOOD_TO_HAVE_INDICATOR.test(compact);
}

/**
 * True when text is an experience requirement (years / experienced professional),
 * not a skill list.
 */
export function isExperienceRequirement(text: string): boolean {
  const compact = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!compact) return false;
  // Years of education is EDUCATION, not work experience
  if (/\bfull[\s-]?time\s+education\b/i.test(compact)) return false;
  if (/\byears?\s+of(?:\s+\w+){0,3}\s+education\b/i.test(compact)) return false;
  // Skill-framed "required experience with X" stays Must Have
  if (/required\s+experience\s+with\b/i.test(compact)) return false;
  if (/strong\s+experience\s+in\b/i.test(compact) && isMustHaveIndicator(compact)) {
    return false;
  }
  if (/^required\s+experience\b/i.test(compact)) return true;
  if (/^years?\s+of\s+experience\b/i.test(compact)) return true;
  if (/\bexperienced\s+professional\b/i.test(compact)) return true;
  if (/^\d+\+\s*years?\b/i.test(compact)) return true;
  if (/^minimum\s+\d+/i.test(compact)) return true;
  return EXPERIENCE_HINT.test(compact);
}

/**
 * True when text is an educational requirement only.
 * Does not treat summary / additional-info narrative (e.g. "higher education clients").
 */
export function isEducationRequirement(text: string): boolean {
  const compact = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!compact) return false;

  // Explicit education labels
  if (
    /^(?:educational\s+qualifications?|education|qualifications)\s*[:\-–—]/i.test(
      compact
    )
  ) {
    return true;
  }

  // Pure degree lists: BE/MBA/MTech
  if (DEGREE_LIST.test(compact)) return true;

  if (/\b(?:bachelor(?:'s)?|master(?:'s)?)\s+degree\b/i.test(compact)) {
    return true;
  }
  if (/\bcomputer\s+science\s+degree\b/i.test(compact)) return true;
  if (/\bfull[\s-]?time\s+education\b/i.test(compact)) return true;

  // Short degree-focused lines only (avoid summary prose)
  if (
    compact.length <= 140 &&
    DEGREE_TOKEN.test(compact) &&
    /(?:degree|qualification|education|[\/|,])/i.test(compact)
  ) {
    // "higher education clients…" is industry narrative, not a credential
    if (
      /\bhigher\s+education\b/i.test(compact) &&
      !/\b(?:bachelor|master|qualification|b\.?\s*e\b|mba|b\.?\s*tech|m\.?\s*tech)\b/i.test(
        compact
      )
    ) {
      return false;
    }
    return true;
  }

  return false;
}

/** Strip leading label punctuation left after heading match (e.g. ": NA"). */
export function normalizeSkillSectionBody(text: string): string {
  return String(text ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/^\s*[:\-–—]+\s*/, "")
    .replace(/^\n+/, "")
    .replace(/\n+$/, "")
    .trim();
}

/**
 * True when text states a work location.
 */
export function isLocationRequirement(text: string): boolean {
  const compact = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!compact || compact.length > 160) return false;
  if (LOCATION_HINT.test(compact)) return true;
  if (LOCATION_INLINE.test(compact)) return true;
  if (/^(?:onsite|on[\s-]?site|remote|hybrid)\b/i.test(compact)) return true;
  return false;
}

/**
 * Display value for a location line — prefer the place name when phrased as
 * "Position based in Pune" → "Pune".
 */
export function formatLocationDisplay(text: string): string {
  const compact = String(text ?? "").replace(/\s+/g, " ").trim();
  const inline = compact.match(LOCATION_INLINE);
  if (inline?.[1]) {
    return inline[1].replace(/[.,;:]+$/, "").trim();
  }
  const labeled = compact.match(
    /^(?:location)\s*[:\-–—]\s*(.+)$/i
  );
  if (labeled?.[1]) {
    return labeled[1].replace(/[.,;:]+$/, "").trim();
  }
  return compact.replace(/[.,;:]+$/, "").trim();
}

/** True when a Good/Must Have body is an empty placeholder (NA, none, …). */
export function isSkillsPlaceholder(text: string): boolean {
  const compact = normalizeSkillSectionBody(text).replace(/\s+/g, " ");
  return /^(n\/?a|none|nil|not\s*applicable|not\s*available|-|—|–|\.|null)$/i.test(
    compact
  );
}

/**
 * Peel experience-requirement lines out of a skill section body
 * (e.g. "NA\\nMinimum 3 year(s) of experience is required").
 */
export function peelExperienceFromSkillBody(body: string): {
  skillBody: string;
  experienceLines: string[];
} {
  const text = String(body ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!text.trim()) return { skillBody: "", experienceLines: [] };

  const lines = text.split("\n");
  const skillLines: string[] = [];
  const experienceLines: string[] = [];

  for (const line of lines) {
    const compact = line.replace(/\s+/g, " ").trim();
    if (!compact) {
      skillLines.push(line);
      continue;
    }
    if (
      /^(?:minimum\s+\d+)/i.test(compact) ||
      (isExperienceRequirement(compact) &&
        !GOOD_TO_HAVE_INDICATOR.test(compact) &&
        !MUST_HAVE_INDICATOR.test(compact))
    ) {
      experienceLines.push(line.replace(/^\n+/, "").replace(/\n+$/, "").trim());
      continue;
    }
    skillLines.push(line);
  }

  return {
    skillBody: skillLines.join("\n").replace(/^\n+/, "").replace(/\n+$/, ""),
    experienceLines: experienceLines.filter(Boolean),
  };
}

const SKILL_LIST_HINT =
  /^(?:[A-Za-z0-9+#./() -]{1,40})(?:\s*[,;/|]\s*[A-Za-z0-9+#./() -]{1,40}){1,}$/;

/** True when text reads as a responsibility (action the person will perform). */
export function isResponsibilityText(text: string): boolean {
  const compact = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!compact) return false;
  if (!RESPONSIBILITY_START.test(compact)) return false;
  // Single verb / tiny fragments are not responsibilities
  if (compact.length < 12) return false;
  // Lone verb lists like "Build, Configure, Test" without object → not chips, not a duty
  if (
    /^(?:[A-Za-z]+)(?:\s*[,;/]\s*[A-Za-z]+){1,6}\.?$/i.test(compact) &&
    compact.split(/[,;/]/).every((part) => {
      const p = part.trim();
      return RESPONSIBILITY_START.test(p) && p.split(/\s+/).length <= 2;
    })
  ) {
    return false;
  }
  return true;
}

/**
 * Split a responsibilities body into display items without rewriting wording.
 * Splits on: bullets, numbered items, separate sentences, spaced " - " separators.
 * Does NOT split hyphenated words (cross-functional, full-stack, real-time, end-to-end).
 */
export function splitResponsibilityItems(body: string): string[] {
  const text = String(body ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();
  if (!text) return [];

  const lines = text.split(/\n+/).map((l) => l.trimEnd()).filter((l) => l.trim());

  // Bullet / numbered lines → one item per line (strip marker only)
  const lineItems: string[] = [];
  let structuredLines = 0;
  for (const line of lines) {
    const bullet = line.match(/^\s*(?:[•·▪‣●*]|\-|\–|\—)\s+(.*)$/);
    if (bullet) {
      structuredLines += 1;
      const item = bullet[1].trim();
      if (item) lineItems.push(item);
      continue;
    }
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (numbered) {
      structuredLines += 1;
      const item = numbered[1].trim();
      if (item) lineItems.push(item);
      continue;
    }
    lineItems.push(line.trim());
  }

  if (structuredLines > 0 && lineItems.length > 0) {
    return expandResponsibilitySeparators(lineItems);
  }

  // Single block (possibly multiple sentences on one/few lines)
  return expandResponsibilitySeparators(
    lines.length > 0 ? lines.map((l) => l.trim()) : [text]
  );
}

/**
 * Further split items on sentence boundaries and spaced dash separators.
 * Keeps hyphenated compounds intact.
 */
function expandResponsibilitySeparators(items: string[]): string[] {
  const out: string[] = [];
  for (const item of items) {
    for (const part of splitSpacedDashSeparators(item)) {
      for (const sentence of splitResponsibilitySentences(part)) {
        const trimmed = sentence.trim();
        if (trimmed) out.push(trimmed);
      }
    }
  }
  return out.length > 0 ? out : items.map((i) => i.trim()).filter(Boolean);
}

/** Split on " - " / " – " / " — " only (not intra-word hyphens). */
function splitSpacedDashSeparators(text: string): string[] {
  if (!/\s[-–—]\s/.test(text)) return [text];
  return text
    .split(/\s[-–—]\s/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * Split into sentences when multiple responsibilities are clearly separate.
 * Does not split on periods inside abbreviations like SaaS when followed by lowercase...
 * Prefer split when `. ` is followed by a capital letter (often a new verb).
 */
function splitResponsibilitySentences(text: string): string[] {
  const compact = text.trim();
  if (!compact) return [];

  // Only one terminal sentence → keep whole
  if (!/[.!?]\s+[A-Z]/.test(compact)) {
    return [compact];
  }

  const units: string[] = [];
  const re = /[^.!?]+(?:[.!?]+["']?(?=\s+[A-Z]|$)|$)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(compact)) !== null) {
    const piece = match[0].trim();
    if (piece) units.push(piece);
  }

  // If split produced nothing useful, keep original
  if (units.length === 0) return [compact];

  // Don't over-split: if a fragment is tiny, merge back into previous
  const merged: string[] = [];
  for (const unit of units) {
    if (
      merged.length > 0 &&
      (unit.length < 12 || !/^[A-Z]/.test(unit))
    ) {
      merged[merged.length - 1] = `${merged[merged.length - 1]} ${unit}`.trim();
      continue;
    }
    merged.push(unit);
  }

  return merged;
}

/**
 * Split unstructured JD into original sentence/line units without rewriting.
 */
export function splitUnstructuredUnits(text: string): string[] {
  const normalized = text.replace(/\n{3,}/g, "\n\n").trim();
  if (!normalized) return [];

  // Prefer explicit line breaks when present
  if (/\n/.test(normalized)) {
    const lines = normalized
      .split(/\n+/)
      .map((line) => line.trimEnd())
      .filter((line) => line.trim().length > 0);
    // Expand multi-sentence lines
    return lines.flatMap((line) => splitResponsibilitySentences(line));
  }

  return splitResponsibilitySentences(normalized);
}

function classifyUnstructuredUnit(unit: string): ClassifiedSpan {
  const trimmed = unit.trim();
  const compact = trimmed.replace(/\s+/g, " ");

  // Explicit mandatory / preferred markers only — never invent
  if (isMustHaveIndicator(compact)) {
    return { kind: "must-have-skills", text: unit, confident: true };
  }
  if (isGoodToHaveIndicator(compact)) {
    return { kind: "good-to-have-skills", text: unit, confident: true };
  }

  // Explicit Additional / Other Information labels (preserve as-is)
  if (/^additional\s+information\b/i.test(compact)) {
    return { kind: "additional-information", text: unit, confident: true };
  }
  if (/^other\s+(?:information|requirements?)\b/i.test(compact)) {
    return { kind: "other-information", text: unit, confident: true };
  }

  // Experience before education — years requirements are never skills
  if (isExperienceRequirement(compact)) {
    return { kind: "experience", text: unit, confident: true };
  }
  if (isEducationRequirement(compact)) {
    return { kind: "education", text: unit, confident: true };
  }
  if (LOCATION_HINT.test(compact) && compact.length < 120) {
    return { kind: "location", text: unit, confident: true };
  }
  if (isLocationRequirement(compact)) {
    return { kind: "location", text: unit, confident: true };
  }

  // Responsibilities before skill-list heuristic — never treat duties as skills
  if (isResponsibilityText(compact)) {
    return { kind: "responsibilities", text: unit, confident: true };
  }

  // Short comma/slash lists look like skills only when items have tech evidence
  if (
    compact.length <= 220 &&
    SKILL_LIST_HINT.test(compact) &&
    /[,;/|]/.test(compact) &&
    !RESPONSIBILITY_START.test(compact)
  ) {
    const parts = compact.split(/\s*[,;/|]\s*/).map((p) => p.trim()).filter(Boolean);
    const evidenced = parts.filter((p) => hasTechnicalSkillEvidence(p));
    if (evidenced.length >= Math.max(1, Math.ceil(parts.length * 0.5))) {
      return { kind: "technical-skills", text: unit, confident: true };
    }
  }

  // Fallback — never delete: uncertain / miscellaneous → OTHER INFORMATION
  return {
    kind: "other-information",
    text: unit,
    confident: false,
  };
}

/**
 * Stage 2 — no clear headings: classify each sentence/line across the ENTIRE JD.
 * Uncertain units → OTHER INFORMATION (never delete).
 *
 * Technical skills are additive chips from evidenced spans only.
 * Never invent Must Have / Good To Have / Education / Experience unless the
 * source unit actually belongs to those categories.
 */
function parseUnstructuredJobDescription(text: string): ParsedJobDescription {
  const units = splitUnstructuredUnits(text);
  const classified = units.map(classifyUnstructuredUnit);

  const merged: ParsedJdSection[] = [];

  for (const span of classified) {
    // Uncertain classifications always land in OTHER INFORMATION (never drop)
    let kind: JdSectionKind = span.confident
      ? span.kind
      : "other-information";

    // Hard guard: never invent mandatory/preferred sections without explicit markers
    if (
      kind === "must-have-skills" &&
      !isMustHaveIndicator(span.text.replace(/\s+/g, " ").trim())
    ) {
      kind = "other-information";
    }
    if (
      kind === "good-to-have-skills" &&
      !isGoodToHaveIndicator(span.text.replace(/\s+/g, " ").trim())
    ) {
      kind = "other-information";
    }
    if (
      kind === "education" &&
      !isEducationRequirement(span.text.replace(/\s+/g, " ").trim())
    ) {
      kind = "other-information";
    }
    if (
      kind === "experience" &&
      !isExperienceRequirement(span.text.replace(/\s+/g, " ").trim())
    ) {
      kind = "other-information";
    }

    const title = SECTION_TITLES[kind];
    const last = merged[merged.length - 1];

    if (last && last.kind === kind) {
      last.rawBody = `${last.rawBody}\n${span.text}`.replace(/\n{3,}/g, "\n\n");
      continue;
    }

    merged.push({
      kind,
      title,
      rawBody: span.text,
      source: "inferred",
    });
  }

  if (merged.length === 0 && text.trim()) {
    merged.push({
      kind: "other-information",
      title: SECTION_TITLES["other-information"],
      rawBody: text.trim(),
      source: "inferred",
    });
  }

  // Scan the entire original description for evidenced technologies.
  // Additive only — never removes responsibility prose; never marks skills as Must Have.
  const hasSkillsSection = merged.some((s) => isSkillsSectionKind(s.kind));
  if (!hasSkillsSection) {
    const skills = extractTechnicalSkillsFromText(text);
    const allowedSource = merged
      .filter((s) => s.kind !== "experience" && s.kind !== "education")
      .map((s) => s.rawBody)
      .join("\n")
      .toLowerCase();
    const keptSkills = skills.filter((skill) => {
      const key = skill.toLowerCase();
      if (allowedSource.includes(key)) return true;
      // Display label may differ from source span (declarative features → Declarative Development)
      if (
        key === "declarative development" &&
        /declarative\s+features/i.test(allowedSource)
      ) {
        return true;
      }
      return false;
    });

    if (keptSkills.length > 0) {
      merged.push({
        kind: "technical-skills",
        title: SECTION_TITLES["technical-skills"],
        rawBody: keptSkills.join(", "),
        source: "inferred",
      });
    }
  }

  return {
    raw: text,
    mode: "unstructured",
    sections: merged,
  };
}

/**
 * After Stage 1 heading splits, re-scan each section body with sentence-level
 * classification so mixed JDs (headings + free prose) redistribute correctly.
 * Explicit Additional Information bodies stay intact.
 */
function refineMixedStructuredSections(
  sections: ParsedJdSection[]
): ParsedJdSection[] {
  const out: ParsedJdSection[] = [];

  const pushMerged = (kind: JdSectionKind, text: string, source: ParsedJdSection["source"]) => {
    const compact = text.replace(/^\n+/, "").replace(/\n+$/, "").trim();
    if (!compact) return;
    const last = out[out.length - 1];
    if (last && last.kind === kind) {
      last.rawBody = `${last.rawBody}\n${compact}`.replace(/\n{3,}/g, "\n\n");
      return;
    }
    out.push({
      kind,
      title: SECTION_TITLES[kind],
      rawBody: compact,
      source,
    });
  };

  const unitFitsParent = (
    parentKind: JdSectionKind,
    classified: ClassifiedSpan,
    unit: string
  ): boolean => {
    const compact = unit.replace(/\s+/g, " ").trim();
    if (parentKind === "additional-information") return true;
    if (classified.kind === parentKind && classified.confident) return true;

    if (
      parentKind === "must-have-skills" ||
      parentKind === "good-to-have-skills" ||
      parentKind === "technical-skills"
    ) {
      if (classified.kind === "technical-skills") return true;
      if (isResponsibilityText(compact)) return false;
      if (isExperienceRequirement(compact)) return false;
      if (isEducationRequirement(compact)) return false;
      if (isLocationRequirement(compact)) return false;
      // Skill lists / short tech phrases stay with the skill heading
      if (
        SKILL_LIST_HINT.test(compact) ||
        /[,;/|]/.test(compact) ||
        hasTechnicalSkillEvidence(compact) ||
        compact.split(/\s+/).length <= 8
      ) {
        return true;
      }
      return false;
    }

    if (parentKind === "project-role" || parentKind === "role-description") {
      return (
        !isResponsibilityText(compact) &&
        !isExperienceRequirement(compact) &&
        !isEducationRequirement(compact) &&
        !isLocationRequirement(compact) &&
        !isMustHaveIndicator(compact) &&
        !isGoodToHaveIndicator(compact)
      );
    }

    if (parentKind === "experience") {
      return isExperienceRequirement(compact);
    }
    if (parentKind === "education") {
      return isEducationRequirement(compact);
    }
    if (parentKind === "location") {
      return isLocationRequirement(compact);
    }
    if (parentKind === "responsibilities") {
      return isResponsibilityText(compact) || classified.kind === "responsibilities";
    }
    if (parentKind === "summary") {
      return (
        !isResponsibilityText(compact) &&
        !isExperienceRequirement(compact) &&
        !isEducationRequirement(compact) &&
        !isLocationRequirement(compact) &&
        !isMustHaveIndicator(compact) &&
        !isGoodToHaveIndicator(compact)
      );
    }
    return classified.kind === parentKind;
  };

  for (const section of sections) {
    if (section.kind === "additional-information") {
      out.push(section);
      continue;
    }

    const units = splitUnstructuredUnits(section.rawBody);
    if (units.length <= 1) {
      // Still allow single-unit reclassification when parent kind clearly mismatches
      if (units.length === 1) {
        const classified = classifyUnstructuredUnit(units[0]);
        if (
          classified.confident &&
          !unitFitsParent(section.kind, classified, units[0]) &&
          classified.kind !== section.kind
        ) {
          pushMerged(classified.kind, units[0], "inferred");
          continue;
        }
      }
      out.push(section);
      continue;
    }

    let parentChunk: string[] = [];
    const flushParent = () => {
      if (parentChunk.length === 0) return;
      pushMerged(section.kind, parentChunk.join("\n"), section.source);
      parentChunk = [];
    };

    for (const unit of units) {
      const classified = classifyUnstructuredUnit(unit);
      if (unitFitsParent(section.kind, classified, unit)) {
        parentChunk.push(unit);
        continue;
      }
      flushParent();
      if (classified.confident) {
        pushMerged(classified.kind, unit, "inferred");
      } else {
        pushMerged("other-information", unit, "inferred");
      }
    }
    flushParent();
  }

  return out;
}

// ── Stage 3: information completeness ──────────────────────────────────────

/** Leading explicit section labels (may change formatting; not body content). */
const LEADING_SECTION_LABEL =
  /^(?:project\s*role(?:\s*description)?|role\s*description|key\s*responsibilities|roles?\s*&\s*responsibilities|responsibilities|must[-\s]+(?:to\s+)?have(?:\s*skills?)?|mandatory\s*skills?|essential\s*skills?|required\s*skills?|required\s*experience\s*with|candidate\s*(?:must|should)\s*have|strong\s*experience\s*in|good[-\s]+to[-\s]+have(?:\s*skills?)?|nice[-\s]+to[-\s]+have(?:\s*skills?)?|preferred\s*skills?|desired\s*skills?|desirable\s*skills?|added\s+advantage|professional\s*(?:&|and)\s*technical\s*skills|technical\s*skills|educational\s*qualifications?|qualifications|education|technical\s*experience|professional\s*attributes|years?\s+of\s+experience|experience|additional\s*information|other\s*(?:information|requirements?)|job\s*summary|summary|location|preferred|desired|desirable|plus)\s*[:\-–—]?\s*/i;

const COMPLETENESS_STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "of",
  "to",
  "in",
  "on",
  "at",
  "by",
  "for",
  "with",
  "from",
  "as",
  "is",
  "are",
  "be",
  "been",
  "being",
  "will",
  "may",
  "can",
  "should",
  "must",
  "have",
  "has",
  "had",
  "this",
  "that",
  "these",
  "those",
  "also",
  "any",
  "all",
  "into",
  "using",
  "via",
  "per",
  "etc",
]);

/** Normalize for fuzzy coverage compare (formatting may differ). */
export function normalizeForCompletenessCompare(text: string): string {
  return String(text ?? "")
    .toLowerCase()
    .replace(/^[•\-\u2013\u2014*]+\s*/, "")
    .replace(/[^a-z0-9+#./]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function meaningfulCompletenessTokens(text: string): string[] {
  return normalizeForCompletenessCompare(text)
    .split(" ")
    .filter((t) => t.length > 1 && !COMPLETENESS_STOPWORDS.has(t));
}

/** Strip a leading section heading label; remainder is the content to cover. */
export function stripLeadingSectionLabel(unit: string): string {
  return String(unit ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(LEADING_SECTION_LABEL, "")
    .trim();
}

function buildCompletenessCorpus(sections: ParsedJdSection[]): string {
  const parts: string[] = [];
  for (const section of sections) {
    parts.push(section.title);
    parts.push(section.rawBody);
    if (section.kind === "location") {
      parts.push(formatLocationDisplay(section.rawBody));
    }
    if (isSkillsSectionKind(section.kind)) {
      for (const skill of extractTechnicalSkillsFromText(section.rawBody)) {
        parts.push(skill);
      }
    }
  }
  return parts.join("\n");
}

/**
 * True when a meaningful original unit is already represented in structured
 * content (exact wording not required — token / substring coverage).
 */
export function isUnitRepresentedInStructuredContent(
  unit: string,
  corpus: string
): boolean {
  const trimmed = String(unit ?? "").replace(/\s+/g, " ").trim();
  if (!trimmed) return true;

  const content = stripLeadingSectionLabel(trimmed);
  // Label-only lines are represented by section titles / structure
  if (!content) return true;

  const needed = meaningfulCompletenessTokens(content);
  if (needed.length === 0) return true;

  const hay = normalizeForCompletenessCompare(corpus);
  if (!hay) return false;

  const contentNorm = normalizeForCompletenessCompare(content);
  if (contentNorm && hay.includes(contentNorm)) return true;

  // Location phrasing may display as place name only
  const loc = content.match(LOCATION_INLINE);
  if (loc?.[1]) {
    const place = normalizeForCompletenessCompare(loc[1]);
    if (place && hay.includes(place)) return true;
  }

  const hits = needed.filter((t) => hay.includes(t));
  if (needed.length <= 3) return hits.length === needed.length;
  return hits.length / needed.length >= 0.85;
}

/**
 * Find original units not confidently represented in structured sections.
 * Used by the completeness pass and by verification.
 */
export function findUnrepresentedOriginalUnits(
  original: string,
  sections: ParsedJdSection[]
): string[] {
  const units = splitUnstructuredUnits(original);
  if (units.length === 0) return [];

  const corpus = buildCompletenessCorpus(sections);
  const missing: string[] = [];
  const seen = new Set<string>();

  for (const unit of units) {
    const trimmed = unit.replace(/\s+/g, " ").trim();
    if (!trimmed) continue;
    if (isUnitRepresentedInStructuredContent(trimmed, corpus)) continue;

    const key = normalizeForCompletenessCompare(stripLeadingSectionLabel(trimmed) || trimmed);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    missing.push(trimmed);
  }

  return missing;
}

function appendMissingToOtherInformation(
  sections: ParsedJdSection[],
  missing: string[]
): ParsedJdSection[] {
  if (missing.length === 0) return sections;

  const out = sections.map((s) => ({ ...s }));
  const body = missing.join("\n");
  const lastOtherIdx = [...out]
    .map((s, i) => (s.kind === "other-information" ? i : -1))
    .filter((i) => i >= 0)
    .pop();

  if (lastOtherIdx !== undefined) {
    const existing = out[lastOtherIdx];
    const existingNorm = normalizeForCompletenessCompare(existing.rawBody);
    const fresh = missing.filter(
      (u) =>
        !normalizeForCompletenessCompare(u) ||
        !existingNorm.includes(normalizeForCompletenessCompare(u))
    );
    if (fresh.length === 0) return out;
    out[lastOtherIdx] = {
      ...existing,
      rawBody: `${existing.rawBody}\n${fresh.join("\n")}`.replace(/\n{3,}/g, "\n\n"),
    };
    return out;
  }

  out.push({
    kind: "other-information",
    title: SECTION_TITLES["other-information"],
    rawBody: body,
    source: "inferred",
  });
  return out;
}

/**
 * Stage 3 — after structured/unstructured parse, ensure every meaningful
 * original unit remains represented. Uncovered / uncertain content is
 * preserved under OTHER INFORMATION (never deleted).
 */
export function ensureInformationCompleteness(
  original: string,
  sections: ParsedJdSection[]
): ParsedJdSection[] {
  const missing = findUnrepresentedOriginalUnits(original, sections);
  if (missing.length === 0) return sections;
  return appendMissingToOtherInformation(sections, missing);
}

/**
 * Two-stage Job Description parse + completeness check.
 * Stage 1 if explicit headings found (then mixed-body refinement);
 * otherwise Stage 2 unstructured classification;
 * then Stage 3 completeness → OTHER INFORMATION for uncovered content.
 */
export function parseJobDescription(raw: string): ParsedJobDescription {
  const text = normalizeJobDescriptionRaw(raw);
  if (!text.trim()) {
    return { raw: text, mode: "unstructured", sections: [] };
  }

  const explicit = findExplicitSectionMatches(text);
  const parsed =
    explicit.length > 0
      ? parseStructuredJobDescription(text)
      : parseUnstructuredJobDescription(text);

  return {
    ...parsed,
    sections: ensureInformationCompleteness(parsed.raw, parsed.sections),
  };
}

/** True when a parsed section is a skills bucket (for chip formatting). */
export function isSkillsSectionKind(kind: JdSectionKind): boolean {
  return (
    kind === "must-have-skills" ||
    kind === "good-to-have-skills" ||
    kind === "technical-skills"
  );
}

export function skillsVariantForKind(
  kind: JdSectionKind
): "must" | "good" | "generic" | null {
  if (kind === "must-have-skills") return "must";
  if (kind === "good-to-have-skills") return "good";
  if (kind === "technical-skills") return "generic";
  return null;
}
