/**
 * Conservative technical skill detection for Job Descriptions.
 *
 * Extracts technologies / platforms / products / tools / frameworks /
 * languages / systems / technical competencies only when there is
 * reasonable evidence. Never treats responsibility action verbs as skills.
 * Never invents or paraphrases — returns original wording spans.
 */

import {
  SKILL_ALIAS_KEYS_LONGEST_FIRST,
  SKILL_ALIAS_TO_CANONICAL,
} from "@/constants/skill-aliases";

/** Action words that are never technical skills by themselves. */
const ACTION_VERB_BLOCKLIST = new Set([
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
  "building",
  "developing",
  "designing",
  "configuring",
  "implementing",
  "maintaining",
  "supporting",
  "testing",
  "deploying",
  "managing",
  "analyzing",
  "analysing",
  "monitoring",
  "troubleshooting",
  "collaborating",
  "providing",
  "leading",
  "creating",
  "ensuring",
  "working",
  "delivering",
]);

/**
 * High-confidence technical phrases (lowercase).
 * Longer phrases are matched first.
 */
const TECHNICAL_PHRASES: string[] = [
  // From skill aliases (phrase form)
  ...SKILL_ALIAS_KEYS_LONGEST_FIRST,
  ...Object.values(SKILL_ALIAS_TO_CANONICAL),

  // User / common Accenture JD technologies
  "software as a service (saas)",
  "software as a service",
  "packaged software",
  "declarative development",
  "declarative features",
  "spring boot",
  "spring framework",
  "sap crm",
  "sap hana",
  "sap s/4hana",
  "s/4hana",
  "salesforce",
  "service now",
  "servicenow",
  "kubernetes",
  "docker",
  "terraform",
  "ansible",
  "jenkins",
  "github actions",
  "azure devops",
  "amazon web services",
  "google cloud platform",
  "microsoft azure",
  "power bi",
  "power apps",
  "power automate",
  "machine learning",
  "artificial intelligence",
  "generative ai",
  "large language models",
  "natural language processing",
  "react.js",
  "react native",
  "node.js",
  "next.js",
  "vue.js",
  "angular",
  "typescript",
  "javascript",
  "python",
  "java",
  "kotlin",
  "golang",
  "c++",
  "c#",
  ".net",
  "dotnet",
  "sql server",
  "postgresql",
  "postgres",
  "mysql",
  "mongodb",
  "redis",
  "kafka",
  "rabbitmq",
  "elasticsearch",
  "splunk",
  "tableau",
  "qlik",
  "informatica",
  "talend",
  "databricks",
  "snowflake",
  "hadoop",
  "spark",
  "hive",
  "airflow",
  "microservices",
  "rest api",
  "graphql",
  "soap",
  "xml",
  "json",
  "html",
  "css",
  "linux",
  "unix",
  "windows server",
  "active directory",
  "oauth",
  "saml",
  "ci/cd",
  "devops",
  "sre",
  "itil",
  "agile",
  "scrum",
  "jira",
  "confluence",
  "figma",
  "selenium",
  "cypress",
  "junit",
  "pytest",
  "oracle",
  "mainframe",
  "cobol",
  "abap",
  "sap",
  "aws",
  "azure",
  "gcp",
  "saas",
  "paas",
  "iaas",
  "sql",
  "nosql",
  "etl",
  "elt",
  "api",
  "apis",
  "ui",
  "ux",
  "crm",
  "erp",
  "hrm",
  "cms",
  "aem",
  "mulesoft",
  "boomi",
  "workday",
  "successfactors",
  "peoplesoft",
  "siebel",
  "hybris",
  "commerce cloud",
];

const TECHNICAL_PHRASES_LONGEST_FIRST = [
  ...new Set(TECHNICAL_PHRASES.map((p) => p.toLowerCase().trim()).filter(Boolean)),
].sort((a, b) => b.length - a.length);

/** Non-global parenthetical technology form: "Software as a Service (SaaS)" */
const PARENTHETICAL_TECH_RE =
  /\b([A-Za-z][A-Za-z0-9+/&.\s-]{2,60}?)\s*\(([A-Za-z][A-Za-z0-9+./-]{1,15})\)/;

const GENERIC_NOUN_BLOCKLIST = new Set([
  "software",
  "products",
  "product",
  "components",
  "enhancements",
  "application",
  "applications",
  "system",
  "systems",
  "features",
  "functionality",
  "releases",
  "production",
  "deployment",
  "plan",
  "schedule",
  "support",
  "primary",
  "new",
  "packaged", // alone — "packaged software" is the phrase
  "service",
  "services",
  "data",
  "team",
  "client",
  "business",
  "project",
  "role",
  "experience",
  "information",
  "requirements",
  "tools", // alone too vague
  "platform", // alone too vague
  "framework",
  "language",
  "technology",
  "technologies",
]);

function normalizeForMatch(text: string): string {
  return text
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Preferred display labels for known tech phrases (chip UI).
 * Keys must be normalizeForMatch() form.
 */
const SKILL_DISPLAY_LABELS: Record<string, string> = {
  "packaged software": "Packaged Software",
  "software as a service (saas)": "Software as a Service (SaaS)",
  "software as a service": "Software as a Service",
  saas: "SaaS",
  "declarative features": "Declarative Development",
  "declarative development": "Declarative Development",
};

/** Format a skill chip label for display without inventing new skills. */
export function formatTechnicalSkillLabel(original: string): string {
  const trimmed = String(original ?? "").replace(/\s+/g, " ").trim();
  if (!trimmed) return trimmed;
  const key = normalizeForMatch(trimmed);
  if (SKILL_DISPLAY_LABELS[key]) return SKILL_DISPLAY_LABELS[key];
  // Preserve original mixed-case / acronym spans from the JD
  if (/[A-Z]/.test(trimmed) && /[a-z]/.test(trimmed)) return trimmed;
  if (/^[A-Z0-9+.#/()-]+$/.test(trimmed)) return trimmed;
  // Title-case simple lowercase catalog phrases
  return trimmed.replace(/\b[a-z]/g, (ch) => ch.toUpperCase());
}

function isActionVerbToken(token: string): boolean {
  const t = token.toLowerCase().replace(/[^a-z+#.]/g, "");
  return ACTION_VERB_BLOCKLIST.has(t);
}

function isCatalogPhrase(lower: string): boolean {
  const stripped = lower.replace(/[()]/g, "").trim();
  for (const phrase of TECHNICAL_PHRASES_LONGEST_FIRST) {
    if (phrase.length < 2) continue;
    if (lower === phrase || stripped === phrase.replace(/[()]/g, "")) return true;
  }
  return false;
}

/**
 * True when a candidate fragment has reasonable evidence it is a
 * technology / tool / platform / framework / product / technical competency.
 */
export function hasTechnicalSkillEvidence(candidate: string): boolean {
  const raw = String(candidate ?? "").replace(/\s+/g, " ").trim();
  if (!raw || raw.length < 2) return false;

  const lower = normalizeForMatch(raw);
  if (!lower) return false;

  // Never skill-chip responsibility verbs / action words
  if (isActionVerbToken(lower)) return false;
  if (
    lower.split(/[\s,/|;]+/).every((part) => !part || isActionVerbToken(part))
  ) {
    return false;
  }

  // Reject vague generic nouns alone
  if (GENERIC_NOUN_BLOCKLIST.has(lower)) return false;

  if (isCatalogPhrase(lower)) return true;

  // Versioned / dotted tech tokens
  if (
    /^(?:c\+\+|c#|\.net|node\.js|react\.js|next\.js|vue\.js|s\/4hana|vb\.net)$/i.test(
      lower
    )
  ) {
    return true;
  }

  // Acronym-only candidates present in catalog
  if (/^[a-z]{2,8}$/i.test(lower)) {
    return TECHNICAL_PHRASES_LONGEST_FIRST.includes(lower);
  }

  // Parenthetical technology form
  if (PARENTHETICAL_TECH_RE.test(raw)) {
    return true;
  }

  return false;
}

interface SpanHit {
  start: number;
  end: number;
  text: string;
}

function findPhraseHits(source: string, phrase: string): SpanHit[] {
  const hits: SpanHit[] = [];
  if (!phrase || phrase.length < 2) return hits;

  const haystack = source.toLowerCase();
  const needle = phrase.toLowerCase();
  let from = 0;
  while (from <= haystack.length - needle.length) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) break;
    const before = idx === 0 ? "" : haystack[idx - 1];
    const after =
      idx + needle.length >= haystack.length
        ? ""
        : haystack[idx + needle.length];
    const boundaryBefore = idx === 0 || /[^a-z0-9+#./]/i.test(before);
    // Sentence punctuation after a phrase is a boundary (e.g. "Spring Boot.")
    const boundaryAfter =
      idx + needle.length >= haystack.length ||
      /[.,;:!?)]/.test(after) ||
      /[^a-z0-9+#./]/i.test(after);
    if (boundaryBefore && boundaryAfter) {
      hits.push({
        start: idx,
        end: idx + needle.length,
        text: source.slice(idx, idx + needle.length),
      });
    }
    from = idx + Math.max(needle.length, 1);
  }
  return hits;
}

/**
 * Find original wording spans in text that are technical skills.
 * Overlapping matches keep the longer span.
 */
export function extractTechnicalSkillsFromText(text: string): string[] {
  const source = String(text ?? "").replace(/\u00a0/g, " ");
  if (!source.trim()) return [];

  const hits: SpanHit[] = [];

  for (const phrase of TECHNICAL_PHRASES_LONGEST_FIRST) {
    for (const hit of findPhraseHits(source, phrase)) {
      if (hasTechnicalSkillEvidence(hit.text)) hits.push(hit);
    }
  }

  // Parenthetical technology names — reject spans that swallow responsibility verbs
  const parenRe = new RegExp(PARENTHETICAL_TECH_RE.source, "gi");
  let paren: RegExpExecArray | null;
  while ((paren = parenRe.exec(source)) !== null) {
    if (paren[0].length === 0) {
      parenRe.lastIndex += 1;
      continue;
    }
    const full = paren[0].trim();
    const name = paren[1].trim();
    const acronym = paren[2];
    if (isActionVerbToken(acronym) || isActionVerbToken(name)) continue;

    // Do not allow duty phrases like "configure and test packaged software … (SaaS)"
    const nameTokens = name.toLowerCase().split(/[^a-z0-9+#.]+/).filter(Boolean);
    if (nameTokens.some((t) => ACTION_VERB_BLOCKLIST.has(t))) {
      // Keep the acronym alone when it is a known technology
      if (hasTechnicalSkillEvidence(acronym)) {
        const acStart = paren.index + paren[0].lastIndexOf(acronym);
        hits.push({
          start: acStart,
          end: acStart + acronym.length,
          text: source.slice(acStart, acStart + acronym.length),
        });
      }
      continue;
    }

    if (
      hasTechnicalSkillEvidence(full) ||
      hasTechnicalSkillEvidence(acronym) ||
      hasTechnicalSkillEvidence(name)
    ) {
      hits.push({
        start: paren.index,
        end: paren.index + paren[0].length,
        text: full,
      });
    }
  }

  hits.sort((a, b) => a.start - b.start || b.end - a.end - (a.end - a.start));
  const kept: SpanHit[] = [];
  let cursor = 0;
  // Prefer longer spans at same start
  const byStart = [...hits].sort(
    (a, b) => a.start - b.start || b.end - b.start - (a.end - a.start)
  );
  for (const hit of byStart) {
    if (hit.start < cursor) continue;
    kept.push(hit);
    cursor = hit.end;
  }

  const seen = new Set<string>();
  const skills: string[] = [];
  for (const hit of kept) {
    const key = normalizeForMatch(hit.text);
    if (!key || seen.has(key)) continue;
    if (!hasTechnicalSkillEvidence(hit.text)) continue;
    if (isActionVerbToken(key)) continue;
    // Collapse aliases that share a display label (e.g. declarative features → development)
    const label = formatTechnicalSkillLabel(hit.text);
    const labelKey = normalizeForMatch(label);
    if (seen.has(labelKey)) continue;
    seen.add(key);
    seen.add(labelKey);
    skills.push(label);
  }

  return skills;
}

/**
 * Filter a candidate skill list down to items with technical evidence.
 * Returns null when nothing confident remains (caller should keep prose).
 */
export function filterTechnicalSkillCandidates(
  candidates: string[]
): string[] | null {
  const out: string[] = [];
  const seen = new Set<string>();

  for (const raw of candidates) {
    const item = String(raw ?? "").replace(/\s+/g, " ").trim();
    if (!item) continue;
    if (isActionVerbToken(item)) continue;
    if (!hasTechnicalSkillEvidence(item)) continue;
    const key = normalizeForMatch(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }

  return out.length > 0 ? out : null;
}
