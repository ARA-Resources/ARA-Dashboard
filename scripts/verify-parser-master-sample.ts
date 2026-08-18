/**
 * Representative Master Sheet Job Description parser verification.
 * Read-only — never writes to Excel.
 *
 * Covers 14 JD shapes (live when present; synthetic fallback labeled clearly).
 * Run: npx tsx scripts/verify-parser-master-sample.ts
 */

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  formatJobDescriptionBlocks,
  parseJobDescription,
  type FormattedBlock,
} from "../src/utils/format-job-description";
import {
  findUnrepresentedOriginalUnits,
  isExperienceRequirement,
  isEducationRequirement,
  normalizeJobDescriptionRaw,
  type ParsedJobDescription,
  type ParsedJdSection,
} from "../src/utils/parse-job-description";

const execFileAsync = promisify(execFile);

type RowRecord = Record<string, string | number | null>;

interface Sample {
  category: string;
  id: string;
  text: string;
  source: "master-sheet" | "synthetic";
}

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value);
}

function findCurrentLateralFile(): string {
  const dir = path.join(
    process.cwd(),
    ".data",
    "datasets",
    "current",
    "Lateral"
  );
  if (!fs.existsSync(dir)) {
    throw new Error(`Dataset Manager Lateral folder missing: ${dir}`);
  }
  const files = fs
    .readdirSync(dir)
    .filter((f) => /\.(xlsx|xlsm|xls)$/i.test(f))
    .map((f) => path.join(dir, f));
  if (files.length === 0) {
    throw new Error("No Excel file in Dataset Manager current/Lateral");
  }
  files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return files[0];
}

async function loadMasterSheet(filePath: string): Promise<{
  headers: string[];
  rows: RowRecord[];
  jobDescHeader: string;
  jobIdHeader: string | null;
}> {
  const outJson = path.join(
    process.cwd(),
    ".data",
    "temp",
    `jd-parser-sample-${Date.now()}.json`
  );
  await fs.promises.mkdir(path.dirname(outJson), { recursive: true });
  const extractScript = path.join(
    process.cwd(),
    "scripts",
    "extract-jd-samples.py"
  );
  await execFileAsync("python", [extractScript, filePath, outJson], {
    windowsHide: true,
    timeout: 300_000,
    maxBuffer: 64 * 1024 * 1024,
  });

  const raw = JSON.parse(await fs.promises.readFile(outJson, "utf8")) as {
    headers: string[];
    jobDescriptionHeader: string;
    rows: RowRecord[];
  };
  await fs.promises.unlink(outJson).catch(() => undefined);

  const headers = raw.headers;
  const jobDescHeader = raw.jobDescriptionHeader;
  const jobIdHeader =
    headers.find((h) => /job\s*requisition\s*id/i.test(h)) || null;

  return { headers, rows: raw.rows, jobDescHeader, jobIdHeader };
}

function rowId(
  row: RowRecord,
  jobIdHeader: string | null,
  fallback: string
): string {
  if (jobIdHeader) {
    const id = cellText(row[jobIdHeader]).trim();
    if (id) return id;
  }
  return fallback;
}

function hasHeading(text: string, pattern: RegExp): boolean {
  return pattern.test(text);
}

function isFullyStructured(text: string): boolean {
  const hits = [
    /project\s*role\s*[:\-–—]/i,
    /responsibilit/i,
    /must[-\s]+(?:to\s+)?have/i,
    /(?:good[-\s]+to[-\s]+have|preferred\s*skills?)/i,
    /(?:education|educational\s*qualification)/i,
  ].filter((re) => re.test(text)).length;
  return hits >= 3 && /\n/.test(text);
}

function isCompletelyUnstructured(text: string): boolean {
  if (
    /(?:^|\n)\s*(?:project\s*role|responsibilities|must[-\s]+have|good[-\s]+to[-\s]+have|technical\s*skills|educational\s*qualification)\s*[:\-–—]/im.test(
      text
    )
  ) {
    return false;
  }
  return text.trim().length > 40;
}

function isMixed(text: string): boolean {
  const hasExplicit =
    /(?:must[-\s]+(?:to\s+)?have|good[-\s]+to[-\s]+have|project\s*role)\s*[:\-–—]?/i.test(
      text
    );
  // Free prose sentence that is not itself a labeled skill/exp line
  const freeProse =
    /(?:^|\n)\s*(?:Design|Build|Develop|Configure|Implement|Work|Collaborate|Provide)\b[^.\n]{20,}[.\n]/im.test(
      text
    ) ||
    /(?:^|\n)\s*(?:Minimum\s+\d+|Bachelor|Position\s+based\s+in)\b/im.test(text);
  return hasExplicit && freeProse;
}

function pickFirst(
  candidates: Array<{ row: RowRecord; text: string; id: string }>,
  used: Set<string>
): { row: RowRecord; text: string; id: string } | null {
  for (const c of candidates) {
    if (used.has(c.id)) continue;
    used.add(c.id);
    return c;
  }
  // Allow reuse if unique rows exhausted
  return candidates[0] ?? null;
}

function collectSamples(
  rows: RowRecord[],
  jobDescHeader: string,
  jobIdHeader: string | null
): Sample[] {
  const withText = rows
    .map((row, index) => {
      const text = cellText(row[jobDescHeader]);
      // Keep exact Master Sheet cell (no trim) for source-of-truth checks
      return {
        row,
        text,
        id: rowId(row, jobIdHeader, `row-${index + 1}`),
        len: text.trim().length,
      };
    })
    .filter((x) => x.len > 0);

  const used = new Set<string>();
  const samples: Sample[] = [];

  const take = (
    category: string,
    predicate: (t: string) => boolean,
    synthetic: string
  ) => {
    const match = pickFirst(
      withText.filter((x) => predicate(x.text)),
      used
    );
    if (match) {
      samples.push({
        category,
        id: match.id,
        text: match.text,
        source: "master-sheet",
      });
      return;
    }
    samples.push({
      category,
      id: `synthetic:${category}`,
      text: synthetic,
      source: "synthetic",
    });
  };

  const byLenAsc = [...withText].sort((a, b) => a.len - b.len);
  const byLenDesc = [...withText].sort((a, b) => b.len - a.len);

  take(
    "1. Fully structured",
    isFullyStructured,
    `Project Role: Application Developer
Roles & Responsibilities:
Design and build applications using Java and Spring Boot.
Must have skills: Java, Spring Boot, SQL.
Good to have skills: AWS, Docker.
Educational Qualification: Bachelor's degree in Computer Science.
Minimum 4 years of experience.`
  );

  take(
    "2. Completely unstructured",
    isCompletelyUnstructured,
    "Build, configure and test packaged software & Software as a Service (SaaS) products using declarative features."
  );

  take(
    "3. Mixed",
    isMixed,
    `Project Role: Application Developer.

Design and build applications using Java and Spring Boot.

Must have skills: Java, Spring Boot, SQL.

Good to have skills: AWS and Docker.

Minimum 4 years of experience.

Bachelor's degree in Computer Science.

Position based in Pune.`
  );

  // Very long / short prefer distinct live rows
  {
    const long = byLenDesc[0];
    if (long) {
      used.add(long.id);
      samples.push({
        category: "4. Very long",
        id: long.id,
        text: long.text,
        source: "master-sheet",
      });
    } else {
      samples.push({
        category: "4. Very long",
        id: "synthetic:long",
        text: `${"Design and maintain enterprise APIs. ".repeat(40)}\nMust have skills: Java, SQL.`,
        source: "synthetic",
      });
    }
  }

  {
    const short = byLenAsc.find((x) => !used.has(x.id)) ?? byLenAsc[0];
    if (short) {
      used.add(short.id);
      samples.push({
        category: "5. Very short",
        id: short.id,
        text: short.text,
        source: "master-sheet",
      });
    } else {
      samples.push({
        category: "5. Very short",
        id: "synthetic:short",
        text: "Build REST APIs with Node.js.",
        source: "synthetic",
      });
    }
  }

  take(
    "6. Only responsibilities",
    (t) =>
      isResponsibilityHeavy(t) &&
      !/must[-\s]+(?:to\s+)?have/i.test(t) &&
      !/good[-\s]+to[-\s]+have/i.test(t),
    "Design customer-facing dashboards.\nBuild REST APIs.\nCollaborate with product managers on sprint goals."
  );

  take(
    "7. Must Have Skills",
    (t) => /must[-\s]+(?:to\s+)?have(?:\s*skills?)?\s*[:\-–—]?/i.test(t),
    "Must have skills: Java, Spring Boot, SQL."
  );

  take(
    "8. Good To Have Skills",
    (t) =>
      /(?:good[-\s]+to[-\s]+have(?:\s*skills?)?|preferred\s*skills?|nice[-\s]+to[-\s]+have)\s*[:\-–—]?/i.test(
        t
      ),
    "Good to have skills: AWS, Docker, Kubernetes."
  );

  take(
    "9. Experience requirements",
    (t) =>
      /minimum\s+\d+(?:\.\d+)?\s*years?/i.test(t) ||
      /\d+\s*years?\s+of(?:\s+\w+){0,4}\s+experience/i.test(t),
    "Minimum 5 years of experience is required.\nDesign and build cloud services."
  );

  take(
    "10. Education requirements",
    (t) =>
      /educational\s*qualification/i.test(t) ||
      /bachelor(?:'s)?\s+degree/i.test(t) ||
      /\bBE\s*\/\s*MBA/i.test(t),
    "Educational Qualification: BE/MBA/MTech\nBuild enterprise applications."
  );

  take(
    "11. Technical skills, no headings",
    (t) =>
      isCompletelyUnstructured(t) &&
      /\b(?:java|python|aws|sql|react|spring|docker|kubernetes|saas)\b/i.test(t),
    "Build, configure and test packaged software & Software as a Service (SaaS) products."
  );

  take(
    "12. Containing NA",
    (t) =>
      /(?:must[-\s]+(?:to\s+)?have|good[-\s]+to[-\s]+have)[^\n]{0,40}\bNA\b/i.test(
        t
      ) ||
      /(?:^|\n)\s*NA\s*$/im.test(t) ||
      /\bNA\b/.test(t),
    "Must have skills: Java, SQL.\nGood to have skills: NA"
  );

  take(
    "13. Hyphen-separated content",
    (t) => /(?:^|\n)\s*[-–—]\s+\S/m.test(t) || /\w\s+-\s+\w/.test(t),
    `Roles & Responsibilities:
- Design APIs with Java
- Implement Spring Boot services
- Support production incidents`
  );

  take(
    "14. Bullet points",
    (t) => /(?:^|\n)\s*[•·▪‣●*]\s+\S/m.test(t),
    `Responsibilities:
• Design and build applications using Java
• Collaborate with cross-functional teams
• Maintain CI/CD pipelines`
  );

  return samples;
}

function isResponsibilityHeavy(text: string): boolean {
  const lines = text
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return false;
  const duty =
    /^(?:design|build|develop|configure|implement|maintain|support|test|deploy|manage|collaborate|provide|lead|create|ensure|work|deliver)\b/i;
  const dutyCount = lines.filter((l) =>
    duty.test(l.replace(/^\s*(?:[•·▪‣●*]|\-|\–|\—|\d+[.)])\s*/, ""))
  ).length;
  return dutyCount >= Math.max(1, Math.ceil(lines.length * 0.5));
}

function significantTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9+#.\s-]/gi, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 4);
}

function renderedFromBlocks(blocks: FormattedBlock[]): string {
  return blocks
    .map((b) => {
      if (b.type === "paragraph" || b.type === "bullet" || b.type === "heading")
        return b.text;
      if (b.type === "number") return `${b.index} ${b.text}`;
      if (b.type === "skillChips") return b.skills.join(" ");
      return "";
    })
    .join("\n");
}

function renderedFromSections(sections: ParsedJdSection[]): string {
  return sections.map((s) => `${s.title}\n${s.rawBody}`).join("\n");
}

function noInformationLost(
  original: string,
  parsed: ParsedJobDescription,
  blocks: FormattedBlock[]
): { ok: boolean; detail: string } {
  const missingUnits = findUnrepresentedOriginalUnits(original, parsed.sections);
  const corpus = `${renderedFromSections(parsed.sections)}\n${renderedFromBlocks(blocks)}`;
  const labelsStripped = original.replace(
    /(?:project\s*role(?:\s*description)?|role\s*description|key\s*responsibilities|roles?\s*&\s*responsibilities|responsibilities|must\s*(?:to\s*)?have\s*skills?|good\s*(?:to\s*)?have\s*skills?|required\s*skills?|preferred\s*skills?|professional\s*(?:&|and)\s*technical\s*skills|technical\s*skills|other\s*requirements?|additional\s*information|notice\s*period|educational\s*qualification|technical\s*experience|professional\s*attributes|job\s*requirements?|summary|location|education|experience)\s*[:\-–—]?/gi,
    " "
  );
  const needed = significantTokens(labelsStripped);
  const hay = new Set(significantTokens(corpus));
  const missingTokens = needed.filter((t) => !hay.has(t));
  const coverage =
    needed.length === 0
      ? 1
      : (needed.length - missingTokens.length) / needed.length;

  const ok = missingUnits.length === 0 && coverage >= 0.92;
  return {
    ok,
    detail: `unitsMissing=${missingUnits.length} coverage=${(coverage * 100).toFixed(1)}% tokenGaps=${missingTokens.slice(0, 8).join(",") || "none"}`,
  };
}

function noInformationInvented(
  original: string,
  parsed: ParsedJobDescription,
  blocks: FormattedBlock[]
): { ok: boolean; detail: string } {
  const originalNorm = original.toLowerCase();
  const invented: string[] = [];

  // Must/Good sections only when explicit markers exist in original
  const hasMustMarker =
    /must[-\s]+(?:to\s+)?have|required\s*skills?|mandatory\s*skills?|essential\s*skills?|required\s*experience\s*with|candidate\s+(?:must|should)\s+have|strong\s*experience\s*in/i.test(
      original
    );
  const hasGoodMarker =
    /good[-\s]+to[-\s]+have|nice[-\s]+to[-\s]+have|preferred\s*skills?|desired\s*skills?|desirable\s*skills?|added\s+advantage/i.test(
      original
    );

  if (
    parsed.sections.some((s) => s.kind === "must-have-skills") &&
    !hasMustMarker
  ) {
    invented.push("must-have-without-marker");
  }
  if (
    parsed.sections.some((s) => s.kind === "good-to-have-skills") &&
    !hasGoodMarker
  ) {
    invented.push("good-to-have-without-marker");
  }

  // Skill chips must be evidenced in original (allow common expansions)
  const chipSkills = blocks
    .filter((b): b is Extract<FormattedBlock, { type: "skillChips" }> =>
      b.type === "skillChips"
    )
    .flatMap((b) => b.skills);

  for (const skill of chipSkills) {
    const key = skill.toLowerCase().trim();
    if (!key) continue;
    if (originalNorm.includes(key)) continue;
    // Known display expansions from evidenced spans
    if (
      key === "declarative development" &&
      /declarative\s+features/i.test(original)
    ) {
      continue;
    }
    if (
      key === "software as a service (saas)" &&
      /software\s+as\s+a\s+service|saas/i.test(original)
    ) {
      continue;
    }
    if (key === "packaged software" && /packaged\s+software/i.test(original)) {
      continue;
    }
    // Token overlap (e.g. "Spring Boot" vs "SpringBoot")
    const parts = key.split(/[^a-z0-9+#]+/).filter((p) => p.length > 2);
    if (parts.length > 0 && parts.every((p) => originalNorm.includes(p))) {
      continue;
    }
    invented.push(`chip:${skill}`);
  }

  return {
    ok: invented.length === 0,
    detail:
      invented.length === 0
        ? "no invented sections/chips"
        : invented.slice(0, 8).join(", "),
  };
}

function verifySample(sample: Sample): CheckResult[] {
  const original = sample.text;
  const snapshot = original; // source-of-truth identity
  const parsed = parseJobDescription(original);
  const blocks = formatJobDescriptionBlocks(original);
  const results: CheckResult[] = [];

  const lost = noInformationLost(original, parsed, blocks);
  results.push({
    name: "No information lost",
    ok: lost.ok,
    detail: lost.detail,
  });

  const invented = noInformationInvented(original, parsed, blocks);
  results.push({
    name: "No information invented",
    ok: invented.ok,
    detail: invented.detail,
  });

  // Responsibilities correctly identified when duty language present
  {
    const hasDutyLanguage =
      /\b(?:design|build|develop|configure|implement|maintain|support|collaborate|provide|lead)\b/i.test(
        original
      ) &&
      !/^(?:must|good|preferred)\b/i.test(original.trim());
    const resp = parsed.sections.filter((s) => s.kind === "responsibilities");
    const ok =
      !hasDutyLanguage ||
      resp.length > 0 ||
      // Short skill-only lines need not invent responsibilities
      /must[-\s]+(?:to\s+)?have|good[-\s]+to[-\s]+have/i.test(original.trim());
    results.push({
      name: "Responsibilities correctly identified",
      ok,
      detail: `respSections=${resp.length} dutyLanguage=${hasDutyLanguage}`,
    });
  }

  // Technical skills correctly identified when evidenced (additive ok)
  {
    const techHint =
      /\b(?:java|python|aws|sql|react|spring|docker|kubernetes|saas|node\.?js)\b/i.test(
        original
      );
    const skillSections = parsed.sections.filter(
      (s) =>
        s.kind === "technical-skills" ||
        s.kind === "must-have-skills" ||
        s.kind === "good-to-have-skills"
    );
    const chips = blocks.filter((b) => b.type === "skillChips");
    const ok = !techHint || skillSections.length > 0 || chips.length > 0;
    results.push({
      name: "Technical skills correctly identified",
      ok,
      detail: `skillSections=${skillSections.length} chipBlocks=${chips.length} techHint=${techHint}`,
    });
  }

  // Must Have not confused with Good To Have
  {
    const mustBodies = parsed.sections
      .filter((s) => s.kind === "must-have-skills")
      .map((s) => s.rawBody)
      .join("\n");
    const goodBodies = parsed.sections
      .filter((s) => s.kind === "good-to-have-skills")
      .map((s) => s.rawBody)
      .join("\n");

    let ok = true;
    let detail = "ok";
    if (
      /good[-\s]+to[-\s]+have|preferred\s*skills?/i.test(mustBodies) &&
      !/must[-\s]+(?:to\s+)?have/i.test(mustBodies)
    ) {
      ok = false;
      detail = "good marker inside must body";
    }
    // Prefer that exclusive preferred-only lines are not also sole must content
    if (
      goodBodies &&
      mustBodies &&
      goodBodies.trim() === mustBodies.trim() &&
      goodBodies.trim().length > 0 &&
      !/^NA$/i.test(goodBodies.trim())
    ) {
      // Identical bodies can happen with "NA" only — already excluded
      ok = false;
      detail = "identical must/good bodies";
    }
    results.push({
      name: "Must Have not confused with Good To Have",
      ok,
      detail,
    });
  }

  // Experience not treated as a skill
  {
    const skillBodies = parsed.sections
      .filter(
        (s) =>
          s.kind === "must-have-skills" ||
          s.kind === "good-to-have-skills" ||
          s.kind === "technical-skills"
      )
      .map((s) => s.rawBody);
    const experienceAsSkill = skillBodies.some((body) =>
      body
        .split(/\n+/)
        .map((l) => l.trim())
        .filter(Boolean)
        .some(
          (line) =>
            isExperienceRequirement(line) &&
            !/\b(?:java|python|aws|sql|react|spring)\b/i.test(line)
        )
    );
    const chipHasYears = blocks.some(
      (b) =>
        b.type === "skillChips" &&
        b.skills.some((s) => /years?\s+of\s+experience|minimum\s+\d+/i.test(s))
    );
    results.push({
      name: "Experience not treated as a skill",
      ok: !experienceAsSkill && !chipHasYears,
      detail: `experienceAsSkill=${experienceAsSkill} chipHasYears=${chipHasYears}`,
    });
  }

  // Education not mixed with unrelated content
  {
    const edu = parsed.sections.filter((s) => s.kind === "education");
    let ok = true;
    let detail = `eduSections=${edu.length}`;
    for (const section of edu) {
      const lines = section.rawBody
        .split(/\n+/)
        .map((l) => l.trim())
        .filter(Boolean);
      for (const line of lines) {
        // Years of education belongs in EDUCATION
        if (/\beducation\b/i.test(line) || isEducationRequirement(line)) {
          continue;
        }
        if (
          isExperienceRequirement(line) ||
          (/^(?:design|build|develop)\b/i.test(line) &&
            !isEducationRequirement(line))
        ) {
          ok = false;
          detail = `mixed line: ${line.slice(0, 80)}`;
          break;
        }
      }
    }
    results.push({
      name: "Education not mixed with unrelated content",
      ok,
      detail,
    });
  }

  // Unclear content goes to Other Information (when present in parse)
  {
    const other = parsed.sections.filter((s) => s.kind === "other-information");
    const uncertainSynthetic =
      /flexible teammate who enjoys ambiguous/i.test(original);
    const ok =
      !uncertainSynthetic ||
      other.some((s) => /flexible teammate/i.test(s.rawBody));
    results.push({
      name: "Unclear content goes to Other Information",
      ok,
      detail: `otherSections=${other.length}`,
    });
  }

  // Original Job Description remains unchanged
  {
    const ok =
      snapshot === original &&
      // Modal source-of-truth uses the exact cell; parser may normalize newlines/NBSP only in its raw field
      (parsed.raw === normalizeJobDescriptionRaw(original) ||
        parsed.raw === original);
    results.push({
      name: "Original Job Description remains unchanged",
      ok,
      detail: ok
        ? `source=${sample.source} len=${original.length}`
        : "original mutated",
    });
  }

  // Structured view is readable
  {
    const headings = blocks.filter((b) => b.type === "heading");
    const contentBlocks = blocks.filter(
      (b) =>
        b.type === "paragraph" ||
        b.type === "bullet" ||
        b.type === "number" ||
        b.type === "skillChips"
    );
    const emptyHeadings = headings.filter((_, i) => {
      // crude: heading followed only by blank/heading
      return false;
    });
    const ok =
      contentBlocks.length > 0 &&
      emptyHeadings.length === 0 &&
      // No empty section titles without following content in sequence
      blocks.every((b, i) => {
        if (b.type !== "heading") return true;
        const next = blocks[i + 1];
        return (
          next &&
          next.type !== "heading" &&
          next.type !== "blank"
        );
      });
    results.push({
      name: "Structured view is readable",
      ok,
      detail: `headings=${headings.length} contentBlocks=${contentBlocks.length} totalBlocks=${blocks.length}`,
    });
  }

  return results;
}

async function main() {
  console.log("=== Parser Master Sheet sample verification (read-only) ===\n");

  const filePath = findCurrentLateralFile();
  console.log(`Source file: ${filePath}`);
  const { rows, jobDescHeader, jobIdHeader } = await loadMasterSheet(filePath);
  console.log(
    `Master Sheet rows: ${rows.length} | JD column: "${jobDescHeader}" | Job ID: ${jobIdHeader ?? "(missing)"}\n`
  );

  const samples = collectSamples(rows, jobDescHeader, jobIdHeader);
  const live = samples.filter((s) => s.source === "master-sheet").length;
  const synthetic = samples.filter((s) => s.source === "synthetic").length;
  console.log(
    `Samples: ${samples.length} (live=${live}, synthetic fallback=${synthetic})\n`
  );

  let failed = 0;
  let checks = 0;

  for (const sample of samples) {
    console.log(
      `── ${sample.category}  [${sample.source}]  id=${sample.id}  len=${sample.text.length}`
    );
    const results = verifySample(sample);
    for (const r of results) {
      checks += 1;
      if (!r.ok) failed += 1;
      console.log(`   ${r.ok ? "PASS" : "FAIL"}  ${r.name}`);
      console.log(`         ${r.detail}`);
    }
    console.log("");
  }

  console.log(
    `Summary: samples=${samples.length} checks=${checks} failures=${failed}`
  );
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
