/**
 * Mixed-format Job Description checks (headings + unstructured prose).
 * Run: npx tsx scripts/verify-mixed-jd.ts
 */
import {
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
      if (b.type === "skillChips")
        return `[${b.variant}:${b.skills.join(" | ")}]`;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

let failed = 0;

const mixed = `Project Role: Application Developer.

Design and build applications using Java and Spring Boot.

Must have skills: Java, Spring Boot, SQL.

Good to have skills: AWS and Docker.

Minimum 4 years of experience.

Bachelor's degree in Computer Science.

Position based in Pune.`;

{
  const parsed = parseJobDescription(mixed);
  const byKind = Object.fromEntries(
    parsed.sections.map((s) => [s.kind, s.rawBody])
  );
  const blocks = formatJobDescriptionBlocks(mixed);
  const out = render(blocks);

  const must = blocks.find(
    (b) => b.type === "skillChips" && b.variant === "must"
  );
  const good = blocks.find(
    (b) => b.type === "skillChips" && b.variant === "good"
  );
  const mustSkills =
    must && must.type === "skillChips"
      ? must.skills.map((s) => s.toLowerCase())
      : [];
  const goodSkills =
    good && good.type === "skillChips"
      ? good.skills.map((s) => s.toLowerCase())
      : [];

  const ok =
    /Application Developer/i.test(byKind["project-role"] ?? "") &&
    !/Design and build/i.test(byKind["project-role"] ?? "") &&
    /Design and build applications using Java and Spring Boot/i.test(
      byKind.responsibilities ?? ""
    ) &&
    mustSkills.includes("java") &&
    mustSkills.some((s) => s.includes("spring")) &&
    mustSkills.includes("sql") &&
    goodSkills.includes("aws") &&
    goodSkills.includes("docker") &&
    /Minimum 4 years of experience/i.test(byKind.experience ?? "") &&
    !/Bachelor/i.test(byKind.experience ?? "") &&
    !/Pune/i.test(byKind.experience ?? "") &&
    /Bachelor's degree in Computer Science/i.test(byKind.education ?? "") &&
    /Pune/i.test(byKind.location ?? "") &&
    /# PROJECT ROLE/.test(out) &&
    /# RESPONSIBILITIES/.test(out) &&
    /# MUST HAVE SKILLS/.test(out) &&
    /# GOOD TO HAVE SKILLS/.test(out) &&
    /# EXPERIENCE/.test(out) &&
    /# EDUCATION/.test(out) &&
    /# LOCATION/.test(out) &&
    /• Pune/.test(out);

  if (!assert("Mixed JD maps all expected sections", ok, out)) failed += 1;
}

{
  const text =
    "Must have skills: Python, AWS.\n\nBuild APIs with FastAPI.\n\nMinimum 2 years of experience.\n\nBased in Bangalore.";
  const parsed = parseJobDescription(text);
  const kinds = parsed.sections.map((s) => s.kind);
  const out = render(formatJobDescriptionBlocks(text));
  const ok =
    kinds.includes("must-have-skills") &&
    kinds.includes("responsibilities") &&
    kinds.includes("experience") &&
    kinds.includes("location") &&
    /• Bangalore|• based in Bangalore/i.test(out);
  if (
    !assert(
      "Must Have + free responsibility + experience + location",
      ok,
      out
    )
  )
    failed += 1;
}

{
  const text =
    "Additional Information:\nTravel to Pune monthly.\nMinimum 5 years of experience is preferred for seniors.";
  const parsed = parseJobDescription(text);
  const add = parsed.sections.find((s) => s.kind === "additional-information");
  const ok =
    !!add &&
    /Travel to Pune monthly/i.test(add.rawBody) &&
    /Minimum 5 years/i.test(add.rawBody) &&
    !parsed.sections.some((s) => s.kind === "experience");
  if (
    !assert(
      "Additional Information still preserves mixed experience prose",
      ok,
      JSON.stringify(parsed.sections.map((s) => s.kind))
    )
  )
    failed += 1;
}

console.log(`Summary: failures=${failed}`);
if (failed > 0) process.exitCode = 1;
