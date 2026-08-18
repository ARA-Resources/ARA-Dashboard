/**
 * Unstructured (no-heading) Job Description checks.
 * Run: npx tsx scripts/verify-unstructured-jd.ts
 */
import {
  extractTechnicalSkillsFromText,
  formatJobDescriptionBlocks,
  parseJobDescription,
} from "../src/utils/format-job-description";

function assert(name: string, ok: boolean, detail: string) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  console.log(`      ${detail}\n`);
  return ok;
}

function render(blocks: ReturnType<typeof formatJobDescriptionBlocks>) {
  return blocks
    .map((b) => {
      if (b.type === "heading") return `# ${b.text}`;
      if (b.type === "bullet") return `• ${b.text}`;
      if (b.type === "paragraph") return b.text;
      if (b.type === "skillChips") return `[${b.variant}:${b.skills.join(" | ")}]`;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

let failed = 0;

const saas =
  "Build, configure and test packaged software & Software as a Service (SaaS) products. Develop and test new components or enhancements. Use declarative features to develop functionality where applicable. Provide primary support for application releases into production, including deployment plan and schedule.";

{
  const parsed = parseJobDescription(saas);
  const blocks = formatJobDescriptionBlocks(saas);
  const out = render(blocks);
  const bullets = blocks.filter((b) => b.type === "bullet");
  const chips = blocks.find((b) => b.type === "skillChips" && b.variant === "generic");
  const skills =
    chips && chips.type === "skillChips"
      ? chips.skills.map((s) => s.toLowerCase())
      : [];
  const kinds = parsed.sections.map((s) => s.kind);

  const ok =
    parsed.mode === "unstructured" &&
    kinds.includes("responsibilities") &&
    kinds.includes("technical-skills") &&
    !kinds.includes("must-have-skills") &&
    !kinds.includes("good-to-have-skills") &&
    !kinds.includes("education") &&
    !kinds.includes("experience") &&
    bullets.length === 4 &&
    skills.some((s) => s.includes("packaged software")) &&
    skills.some((s) => s.includes("saas") || s.includes("software as a service")) &&
    skills.some((s) => s.includes("declarative")) &&
    !/# MUST HAVE|# GOOD TO HAVE|# EDUCATION|# EXPERIENCE/.test(out);

  if (
    !assert(
      "No-heading SaaS JD → RESPONSIBILITIES + TECHNICAL SKILLS only",
      ok,
      out
    )
  )
    failed += 1;
}

{
  const skills = extractTechnicalSkillsFromText(saas);
  const ok =
    skills.some((s) => /packaged software/i.test(s)) &&
    skills.some((s) => /software as a service \(saas\)/i.test(s)) &&
    skills.some((s) => /declarative development/i.test(s)) &&
    !skills.some((s) => /^(build|configure|test|develop|use|provide)$/i.test(s));
  if (
    !assert(
      "Extract Packaged Software, SaaS, Declarative Development — not verbs",
      ok,
      JSON.stringify(skills)
    )
  )
    failed += 1;
}

{
  const text =
    "We value collaboration and ownership mindset across delivery teams.";
  const parsed = parseJobDescription(text);
  const kinds = parsed.sections.map((s) => s.kind);
  const ok =
    !kinds.includes("must-have-skills") &&
    !kinds.includes("good-to-have-skills") &&
    !kinds.includes("technical-skills") &&
    kinds.includes("other-information");
  if (
    !assert(
      "Soft prose invents neither skills nor mandatory sections",
      ok,
      kinds.join(",")
    )
  )
    failed += 1;
}

{
  const text = "Minimum 3 years of experience in SAP.";
  const parsed = parseJobDescription(text);
  const kinds = parsed.sections.map((s) => s.kind);
  const ok =
    kinds.includes("experience") &&
    !kinds.includes("must-have-skills") &&
    !kinds.includes("good-to-have-skills");
  if (
    !assert(
      "Experience-only JD does not invent Must/Good Have",
      ok,
      kinds.join(",")
    )
  )
    failed += 1;
}

console.log(`Summary: failures=${failed}`);
if (failed > 0) process.exitCode = 1;
