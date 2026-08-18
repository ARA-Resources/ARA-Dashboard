/**
 * Soft / semantic similarity between skills and openings.
 * Uses normalized aliases, token overlap, and related-tech families
 * — not exact string equality alone.
 */

import { normalizeSkillName } from "@/services/excel/normalize-skill";

/**
 * Related technology families. Used only for soft similarity boosts —
 * never as hardcoded cluster names.
 */
const SEMANTIC_FAMILIES: string[][] = [
  ["azure", "adf", "databricks", "synapse", "fabric", "power", "bi", "microsoft"],
  ["aws", "amazon", "lambda", "glue", "s3", "redshift", "bedrock"],
  ["gcp", "google", "bigquery", "vertex"],
  ["sap", "abap", "fiori", "hana", "s/4hana", "btp", "mdg", "ewm", "fico"],
  ["salesforce", "lightning", "apex", "lwc", "omnistudio", "agentforce"],
  ["servicenow", "itsm", "itom", "itil"],
  ["java", "spring", "boot", "jvm", "j2ee"],
  ["python", "pyspark", "django", "flask", "fastapi"],
  ["react", "node", "javascript", "typescript", "angular", "vue"],
  ["machine", "learning", "llm", "generative", "mlops", "openai"],
  ["oracle", "plsql", "pl/sql", "oic"],
  ["workday", "hcm", "peoplesoft"],
  ["snowflake", "dbt", "etl", "elt"],
  ["dynamics", "crm", "d365", "powerapps"],
];

const FAMILY_INDEX = buildFamilyIndex(SEMANTIC_FAMILIES);

function buildFamilyIndex(families: string[][]) {
  const map = new Map<string, number>();
  families.forEach((family, index) => {
    for (const token of family) map.set(token, index);
  });
  return map;
}

const STOP_TOKENS = new Set([
  "and",
  "or",
  "the",
  "for",
  "with",
  "to",
  "of",
  "in",
  "on",
  "a",
  "an",
  "language",
  "programming",
  "tool",
  "tools",
  "platform",
  "suite",
  "management",
  "development",
  "technical",
  "functional",
  "application",
  "applications",
  "service",
  "services",
  "data",
  "cloud",
]);

export function tokenizeSkill(normalized: string): string[] {
  return normalized
    .split(/[^a-z0-9/+#.]+/i)
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length > 1 && !STOP_TOKENS.has(token));
}

function charBigrams(value: string): Set<string> {
  const compact = value.replace(/\s+/g, "");
  const grams = new Set<string>();
  if (compact.length < 2) {
    if (compact) grams.add(compact);
    return grams;
  }
  for (let i = 0; i < compact.length - 1; i += 1) {
    grams.add(compact.slice(i, i + 2));
  }
  return grams;
}

function diceCoefficient(a: string, b: string): number {
  if (a === b) return 1;
  const aGrams = charBigrams(a);
  const bGrams = charBigrams(b);
  if (aGrams.size === 0 || bGrams.size === 0) return 0;
  let overlap = 0;
  for (const gram of aGrams) {
    if (bGrams.has(gram)) overlap += 1;
  }
  return (2 * overlap) / (aGrams.size + bGrams.size);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function familyOverlap(tokensA: string[], tokensB: string[]): number {
  const familiesA = new Set<number>();
  const familiesB = new Set<number>();
  for (const token of tokensA) {
    const family = FAMILY_INDEX.get(token);
    if (family != null) familiesA.add(family);
  }
  for (const token of tokensB) {
    const family = FAMILY_INDEX.get(token);
    if (family != null) familiesB.add(family);
  }
  if (familiesA.size === 0 || familiesB.size === 0) return 0;
  let hit = 0;
  for (const family of familiesA) {
    if (familiesB.has(family)) hit += 1;
  }
  return hit / Math.max(familiesA.size, familiesB.size);
}

/**
 * Similarity between two skill labels in [0, 1].
 */
export function skillSimilarity(a: string, b: string): number {
  const left = normalizeSkillName(a);
  const right = normalizeSkillName(b);
  if (!left || !right) return 0;
  if (left === right) return 1;

  const tokensA = tokenizeSkill(left);
  const tokensB = tokenizeSkill(right);
  const tokenScore = jaccard(new Set(tokensA), new Set(tokensB));
  const dice = diceCoefficient(left, right);
  const family = familyOverlap(tokensA, tokensB);

  // Containment boost (e.g. "sap fi" vs "sap fi s/4hana accounting")
  const setA = new Set(tokensA);
  const setB = new Set(tokensB);
  let contained = 0;
  if (setA.size && setB.size) {
    const [smaller, larger] =
      setA.size <= setB.size ? [setA, setB] : [setB, setA];
    let hits = 0;
    for (const token of smaller) {
      if (larger.has(token)) hits += 1;
    }
    contained = hits / smaller.size;
  }

  return Math.min(
    1,
    tokenScore * 0.45 + dice * 0.25 + family * 0.2 + contained * 0.25
  );
}

export interface WeightedSkill {
  normalized: string;
  weight: number;
}

/**
 * Soft weighted Jaccard between two openings' skill bags.
 * Must-have skills weigh more than good-to-have.
 */
export function openingSkillSimilarity(
  left: WeightedSkill[],
  right: WeightedSkill[]
): number {
  if (left.length === 0 && right.length === 0) return 1;
  if (left.length === 0 || right.length === 0) return 0.05;

  const pairScore = (a: WeightedSkill[], b: WeightedSkill[]) => {
    let weighted = 0;
    let total = 0;
    for (const skill of a) {
      total += skill.weight;
      let best = 0;
      for (const other of b) {
        const sim =
          skillSimilarity(skill.normalized, other.normalized) *
          Math.min(skill.weight, other.weight);
        if (sim > best) best = sim;
      }
      weighted += best;
    }
    return total === 0 ? 0 : weighted / total;
  };

  return (pairScore(left, right) + pairScore(right, left)) / 2;
}

export function toWeightedSkills(
  mustHave: { normalized: string }[],
  goodToHave: { normalized: string }[]
): WeightedSkill[] {
  const map = new Map<string, number>();
  for (const skill of mustHave) {
    map.set(skill.normalized, Math.max(map.get(skill.normalized) ?? 0, 1));
  }
  for (const skill of goodToHave) {
    map.set(
      skill.normalized,
      Math.max(map.get(skill.normalized) ?? 0, 0.45)
    );
  }
  return [...map.entries()].map(([normalized, weight]) => ({
    normalized,
    weight,
  }));
}
