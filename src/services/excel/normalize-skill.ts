import {
  SKILL_ALIAS_KEYS_LONGEST_FIRST,
  SKILL_ALIAS_TO_CANONICAL,
} from "@/constants/skill-aliases";

/**
 * Normalize skill labels for clustering / matching.
 * Keeps meaningful punctuation (S/4HANA, C++, react.js) while
 * merging capitalization, aliases, and common glued forms.
 */
export function normalizeSkillName(value: string): string {
  if (!value) return "";

  let text = value.normalize("NFKC").replace(/\u00a0/g, " ").trim();
  if (!text) return "";

  text = splitCamelCaseWords(text);
  text = text.toLowerCase();
  text = standardizePunctuation(text);
  text = applyTokenRepairs(text);
  text = stripRedundantParentheticals(text);
  text = collapseWhitespace(text);
  text = applyAliasMap(text);
  text = collapseWhitespace(text);

  return text.replace(/^[\s·•\-\–\—:|;,.]+|[\s·•\-\–\—:|;,.]+$/g, "").trim();
}

export function isBlankSkillPlaceholder(value: string): boolean {
  const normalized = normalizeSkillName(value);
  return (
    !normalized ||
    normalized === "na" ||
    normalized === "n/a" ||
    normalized === "n.a" ||
    normalized === "n.a." ||
    normalized === "none" ||
    normalized === "nil" ||
    normalized === "null" ||
    normalized === "-" ||
    normalized === "--" ||
    normalized === "not applicable" ||
    normalized === "not available"
  );
}

/**
 * Build an ExtractedSkill-ready pair from original wording.
 */
export function toNormalizedSkillPair(original: string): {
  original: string;
  normalized: string;
} | null {
  const cleaned = original.replace(/\s+/g, " ").trim();
  if (!cleaned || isBlankSkillPlaceholder(cleaned)) return null;
  const normalized = normalizeSkillName(cleaned);
  if (!normalized) return null;
  return { original: cleaned, normalized };
}

function splitCamelCaseWords(text: string): string {
  return text.replace(/[A-Za-z]+/g, (word) => {
    if (word.length <= 3) return word;

    // Keep pure acronyms (ADF, AWS) and pluralized acronyms (LLMs, APIs)
    const withoutTrailingS = word.endsWith("s") || word.endsWith("S")
      ? word.slice(0, -1)
      : word;
    if (
      withoutTrailingS.length >= 2 &&
      withoutTrailingS === withoutTrailingS.toUpperCase()
    ) {
      return word;
    }

    return word
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
  });
}

function standardizePunctuation(text: string): string {
  return text
    .replace(/[_]+/g, " ")
    .replace(/[–—]/g, "-")
    .replace(/\s*\/\s*/g, "/") // keep S/4HANA compact
    .replace(/([a-z])\.([a-z])/g, "$1.$2") // preserve react.js
    .replace(/\s*([,+#])\s*/g, "$1 ")
    .replace(/\s+/g, " ")
    .trim();
}

function applyTokenRepairs(text: string): string {
  return text
    .replace(/\bwebui\b/g, "web ui")
    .replace(/\bweb-ui\b/g, "web ui")
    .replace(/\bpowerbi\b/g, "power bi")
    .replace(/\bnodejs\b/g, "node.js")
    .replace(/\breactjs\b/g, "react.js")
    .replace(/\bnode js\b/g, "node.js")
    .replace(/\breact js\b/g, "react.js")
    .replace(/\bgenai\b/g, "generative ai")
    .replace(/\bgen ai\b/g, "generative ai")
    .replace(/\bs\/4\s*hana\b/g, "s/4hana")
    .replace(/\bs4hana\b/g, "s/4hana")
    .replace(/\bs4 hana\b/g, "s/4hana");
}

/**
 * Drop parenthetical acronyms that repeat the surrounding phrase
 * e.g. "machine learning (ml)" → "machine learning"
 *      "adobe experience manager (aem) sites" → "adobe experience manager sites"
 */
function stripRedundantParentheticals(text: string): string {
  return text
    .replace(
      /([a-z0-9][a-z0-9 ./+#&-]*)\s*\(([^)]+)\)/g,
      (full, before: string, inner: string) => {
        const beforeTrim = collapseWhitespace(before);
        const words = beforeTrim.split(" ").filter(Boolean);
        for (let n = words.length; n >= 1; n -= 1) {
          const phrase = words.slice(-n).join(" ");
          if (isAcronymOf(inner, phrase)) {
            return beforeTrim;
          }
        }
        return full;
      }
    )
    .replace(/\s+/g, " ")
    .trim();
}

function isAcronymOf(inner: string, phrase: string): boolean {
  const compactInner = inner.replace(/[^a-z0-9]/gi, "").toLowerCase();
  if (!compactInner) return false;

  const words = phrase.split(/\s+/).filter(Boolean);
  const initials = words
    .map((word) => word.replace(/[^a-z0-9]/gi, "")[0] ?? "")
    .join("")
    .toLowerCase();

  if (!initials) return false;
  if (compactInner === initials) return true;
  // allow pluralized acronyms: llms vs llm
  if (compactInner === `${initials}s` || `${compactInner}s` === initials) {
    return true;
  }
  return false;
}

function applyAliasMap(text: string): string {
  const direct = SKILL_ALIAS_TO_CANONICAL[text];
  if (direct) return direct;

  let result = text;
  for (const alias of SKILL_ALIAS_KEYS_LONGEST_FIRST) {
    const canonical = SKILL_ALIAS_TO_CANONICAL[alias];
    if (!canonical || alias === canonical) continue;
    if (result === alias) {
      result = canonical;
      continue;
    }

    if (alias.length <= 4) {
      const pattern = new RegExp(
        `(^|[^a-z0-9])(${escapeRegExp(alias)})(?=[^a-z0-9]|$)`,
        "g"
      );
      result = result.replace(
        pattern,
        (_full, prefix: string) => `${prefix}${canonical}`
      );
    } else {
      const pattern = new RegExp(`\\b${escapeRegExp(alias)}\\b`, "g");
      result = result.replace(pattern, canonical);
    }
  }

  return collapseWhitespace(result);
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function collapseWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim();
}
