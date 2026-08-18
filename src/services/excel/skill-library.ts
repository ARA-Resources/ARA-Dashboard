import type {
  ExtractedSkill,
  NormalizedSkillLibraryEntry,
  OpeningSkillRecord,
} from "@/types/opening-skills";

/**
 * Deduplicate skills by normalized value while preserving first original wording.
 */
export function dedupeExtractedSkills(
  skills: ExtractedSkill[]
): ExtractedSkill[] {
  const seen = new Set<string>();
  const result: ExtractedSkill[] = [];

  for (const skill of skills) {
    if (!skill.normalized || seen.has(skill.normalized)) continue;
    seen.add(skill.normalized);
    result.push(skill);
  }

  return result;
}

/**
 * Build a normalized skill library from extracted openings.
 * Used for clustering similar openings.
 */
export function buildNormalizedSkillLibrary(
  openings: OpeningSkillRecord[]
): NormalizedSkillLibraryEntry[] {
  const byNormalized = new Map<
    string,
    {
      originals: Map<string, number>;
      mustHaveCount: number;
      goodToHaveCount: number;
      openingIds: Set<string>;
    }
  >();

  for (const opening of openings) {
    const seenInOpening = new Set<string>();

    const track = (skills: ExtractedSkill[], bucket: "must" | "good") => {
      for (const skill of skills) {
        let entry = byNormalized.get(skill.normalized);
        if (!entry) {
          entry = {
            originals: new Map(),
            mustHaveCount: 0,
            goodToHaveCount: 0,
            openingIds: new Set(),
          };
          byNormalized.set(skill.normalized, entry);
        }

        entry.originals.set(
          skill.original,
          (entry.originals.get(skill.original) ?? 0) + 1
        );
        if (bucket === "must") entry.mustHaveCount += 1;
        else entry.goodToHaveCount += 1;

        if (!seenInOpening.has(skill.normalized)) {
          entry.openingIds.add(opening.openingId);
          seenInOpening.add(skill.normalized);
        }
      }
    };

    track(opening.mustHaveSkills, "must");
    track(opening.goodToHaveSkills, "good");
  }

  return [...byNormalized.entries()]
    .map(([normalized, entry]) => {
      const originalsRanked = [...entry.originals.entries()].sort(
        (a, b) => b[1] - a[1] || b[0].length - a[0].length
      );
      const preferredOriginal = originalsRanked[0]?.[0] ?? normalized;

      return {
        normalized,
        preferredOriginal,
        originals: originalsRanked.map(([original]) => original),
        openingCount: entry.openingIds.size,
        mustHaveCount: entry.mustHaveCount,
        goodToHaveCount: entry.goodToHaveCount,
      } satisfies NormalizedSkillLibraryEntry;
    })
    .sort(
      (a, b) =>
        b.openingCount - a.openingCount ||
        a.normalized.localeCompare(b.normalized)
    );
}
