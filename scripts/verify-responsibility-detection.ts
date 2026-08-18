/**
 * Responsibility detection checks against live Master Sheet samples.
 * Read-only.
 *
 * Run: npx tsx scripts/verify-responsibility-detection.ts
 */
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  formatJobDescriptionBlocks,
  parseJobDescription,
  parseSkillChipItems,
  splitResponsibilityItems,
  isResponsibilityText,
} from "../src/utils/format-job-description";

const execFileAsync = promisify(execFile);

function findCurrentLateralFile(): string {
  const dir = path.join(process.cwd(), ".data", "datasets", "current", "Lateral");
  const files = fs
    .readdirSync(dir)
    .filter((f) => /\.(xlsx|xlsm|xls)$/i.test(f))
    .map((f) => path.join(dir, f));
  files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return files[0];
}

async function loadRows(filePath: string): Promise<Record<string, string>[]> {
  const outJson = path.join(
    process.cwd(),
    ".data",
    "temp",
    `resp-samples-${Date.now()}.json`
  );
  await fs.promises.mkdir(path.dirname(outJson), { recursive: true });
  await execFileAsync(
    "python",
    [path.join(process.cwd(), "scripts", "extract-jd-samples.py"), filePath, outJson],
    { windowsHide: true, timeout: 300_000, maxBuffer: 64 * 1024 * 1024 }
  );
  const raw = JSON.parse(await fs.promises.readFile(outJson, "utf8")) as {
    jobDescriptionHeader: string;
    rows: Record<string, string>[];
  };
  await fs.promises.unlink(outJson).catch(() => undefined);
  return raw.rows.map((r) => ({
    id: String(r["Job Requisition ID"] ?? ""),
    jd: String(r[raw.jobDescriptionHeader] ?? ""),
  }));
}

function assert(name: string, ok: boolean, detail: string) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  console.log(`      ${detail}\n`);
  return ok;
}

async function main() {
  let failed = 0;

  const saas =
    "Build, configure and test packaged software & Software as a Service (SaaS) products. Develop and test new components or enhancements. Use declarative features to develop functionality where applicable. Provide primary support for application releases into production, including deployment plan and schedule.";

  {
    const parsed = parseJobDescription(saas);
    const resp = parsed.sections.filter((s) => s.kind === "responsibilities");
    const blocks = formatJobDescriptionBlocks(saas);
    const bullets = blocks.filter((b) => b.type === "bullet");
    const chips = blocks.filter((b) => b.type === "skillChips");
    const chipSkills =
      chips[0] && chips[0].type === "skillChips" ? chips[0].skills : [];
    const ok =
      parsed.mode === "unstructured" &&
      resp.length === 1 &&
      bullets.length === 4 &&
      !chipSkills.some((s) => /^(Build|Configure|Test)$/i.test(s.trim()));
    if (
      !assert(
        "SaaS example → RESPONSIBILITIES as 4 bullets (not action-verb chips)",
        ok,
        `mode=${parsed.mode} respSections=${resp.length} bullets=${bullets.length} techChips=${JSON.stringify(chipSkills)}\n      ${bullets
          .map((b) => (b.type === "bullet" ? `• ${b.text}` : ""))
          .join("\n      ")}`
      )
    )
      failed += 1;
  }

  {
    const items = splitResponsibilityItems(
      "Develop and test new components or enhancements."
    );
    const ok =
      items.length === 1 &&
      items[0] === "Develop and test new components or enhancements.";
    if (
      !assert(
        "Single responsibility sentence stays one item",
        ok,
        JSON.stringify(items)
      )
    )
      failed += 1;
  }

  {
    const items = splitResponsibilityItems(
      "Own end-to-end delivery - Partner with cross-functional teams - Support full-stack releases in real-time"
    );
    const ok =
      items.length === 3 &&
      items.some((i) => /end-to-end/.test(i)) &&
      items.some((i) => /cross-functional/.test(i)) &&
      items.some((i) => /full-stack/.test(i)) &&
      items.some((i) => /real-time/.test(i));
    if (
      !assert(
        "Spaced dash splits; hyphenated words kept",
        ok,
        items.map((i) => `• ${i}`).join(" | ")
      )
    )
      failed += 1;
  }

  {
    const chips = parseSkillChipItems("Build, Configure, Test");
    const ok = chips === null && !isResponsibilityText("Build, Configure, Test");
    if (
      !assert(
        "Build/Configure/Test alone are not skills and not a responsibility",
        ok,
        `chips=${chips === null ? "null" : chips.join("|")}`
      )
    )
      failed += 1;
  }

  {
    const chips = parseSkillChipItems(
      "Build, configure and test packaged software & Software as a Service (SaaS) products."
    );
    // May extract SaaS / packaged software — must not chip Build/Configure/Test
    const ok =
      chips === null ||
      (chips.length > 0 &&
        !chips.some((s) => /^(build|configure|test)$/i.test(s.trim())) &&
        chips.some(
          (s) =>
            /saas|packaged software|software as a service/i.test(s)
        ));
    if (
      !assert(
        "Responsibility sentence does not chip action verbs",
        ok,
        `chips=${chips === null ? "null" : chips.join("|")}`
      )
    )
      failed += 1;
  }

  console.log("=== Live Master Sheet samples ===\n");
  const filePath = findCurrentLateralFile();
  console.log(`Source: ${filePath}\n`);
  const rows = await loadRows(filePath);

  const unstructured = rows.filter((r) => {
    const jd = r.jd.trim();
    if (jd.length < 80) return false;
    const parsed = parseJobDescription(jd);
    return parsed.mode === "unstructured";
  });

  const saasLike = rows.find((r) =>
    /Build,\s*configure and test packaged software/i.test(r.jd)
  );
  if (saasLike) {
    const blocks = formatJobDescriptionBlocks(saasLike.jd);
    const bullets = blocks.filter((b) => b.type === "bullet");
    const chips = blocks.filter((b) => b.type === "skillChips");
    const chipSkills =
      chips[0] && chips[0].type === "skillChips" ? chips[0].skills : [];
    const heading = blocks.some(
      (b) => b.type === "heading" && b.text === "RESPONSIBILITIES"
    );
    if (
      !assert(
        `Live SaaS-like row ${saasLike.id}`,
        heading &&
          bullets.length >= 3 &&
          !chipSkills.some((s) => /^(Build|Configure|Test)$/i.test(s.trim())),
        `bullets=${bullets.length} techChips=${JSON.stringify(chipSkills)}`
      )
    )
      failed += 1;
  } else {
    console.log("SKIP  Live SaaS-like row not found (synthetic already covered)\n");
  }

  let sampleOk = 0;
  const sampleNotes: string[] = [];
  for (const row of unstructured.slice(0, 12)) {
    const parsed = parseJobDescription(row.jd);
    const blocks = formatJobDescriptionBlocks(row.jd);
    const resp = parsed.sections.find((s) => s.kind === "responsibilities");
    const bullets = blocks.filter((b) => b.type === "bullet");
    const chips = blocks.filter((b) => b.type === "skillChips");

    // Content preservation: every responsibility bullet text appears in original
    const bulletLeak =
      bullets.some(
        (b) =>
          b.type === "bullet" &&
          !row.jd.toLowerCase().includes(b.text.toLowerCase().slice(0, 40))
      ) || false;

    // No verb-only skill chips
    const badChips =
      chips.some(
        (b) =>
          b.type === "skillChips" &&
          b.skills.some((s) =>
            /^(build|configure|test|develop|design|implement)$/i.test(s.trim())
          )
      ) || false;

    if (!bulletLeak && !badChips) {
      sampleOk += 1;
      sampleNotes.push(
        `ok ${row.id} resp=${Boolean(resp)} bullets=${bullets.length}`
      );
    } else {
      failed += 1;
      sampleNotes.push(
        `FAIL ${row.id} leak=${bulletLeak} badChips=${badChips}`
      );
    }
  }

  if (
    !assert(
      `Unstructured samples content-safe (${sampleOk}/12)`,
      sampleOk === Math.min(12, unstructured.length) && unstructured.length > 0,
      sampleNotes.join(" | ")
    )
  ) {
    // already counted per-fail above for individual; don't double-count summary
  }

  // Structured JD with Roles & Responsibilities still works
  const structured = rows.find((r) =>
    /roles?\s*&\s*responsibilities|key\s*responsibilities/i.test(r.jd)
  );
  if (structured) {
    const parsed = parseJobDescription(structured.jd);
    const blocks = formatJobDescriptionBlocks(structured.jd);
    const resp = parsed.sections.some((s) => s.kind === "responsibilities");
    const bullets = blocks.filter((b) => b.type === "bullet");
    if (
      !assert(
        `Structured responsibilities row ${structured.id}`,
        parsed.mode === "structured" && resp && bullets.length >= 1,
        `mode=${parsed.mode} bullets=${bullets.length}`
      )
    )
      failed += 1;
  }

  console.log(`Summary: failures=${failed}`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
