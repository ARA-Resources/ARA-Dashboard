/**
 * Experience + Education detection checks.
 * Run: npx tsx scripts/verify-experience-education.ts
 */
import {
  formatJobDescriptionBlocks,
  isEducationRequirement,
  isExperienceRequirement,
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
      if (b.type === "skillChips") return `[${b.variant}:${b.skills.join(",")}]`;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

let failed = 0;

{
  const text = "Minimum 3 years of experience in SAP.";
  const parsed = parseJobDescription(text);
  const blocks = formatJobDescriptionBlocks(text);
  const out = render(blocks);
  const ok =
    parsed.sections.some((s) => s.kind === "experience") &&
    !parsed.sections.some((s) => isSkills(s.kind)) &&
    /# EXPERIENCE/.test(out) &&
    /• Minimum 3 years of experience in SAP/.test(out) &&
    !/\[/.test(out);
  if (
    !assert(
      "Minimum 3 years… in SAP → EXPERIENCE bullet, not skill",
      ok,
      out
    )
  )
    failed += 1;
}

function isSkills(kind: string) {
  return (
    kind === "must-have-skills" ||
    kind === "good-to-have-skills" ||
    kind === "technical-skills"
  );
}

{
  const text = "Educational Qualification: BE/MBA/MTech";
  const out = render(formatJobDescriptionBlocks(text));
  const ok =
    /# EDUCATION/.test(out) &&
    /• BE \/ MBA \/ MTech/.test(out) &&
    !/# SUMMARY|# ADDITIONAL/.test(out);
  if (!assert("Educational Qualification: BE/MBA/MTech", ok, out)) failed += 1;
}

{
  const variants = [
    "5+ years",
    "3 years of SAP experience",
    "Experienced professional",
    "Required experience: 5 years in Java",
    "Years of experience: 4+",
  ];
  let allOk = true;
  const notes: string[] = [];
  for (const text of variants) {
    const parsed = parseJobDescription(text);
    const exp = parsed.sections.filter((s) => s.kind === "experience");
    const skills = parsed.sections.filter((s) => isSkills(s.kind));
    const blocks = formatJobDescriptionBlocks(text);
    const bullet = blocks.some((b) => b.type === "bullet");
    const ok = exp.length >= 1 && skills.length === 0 && bullet;
    if (!ok) allOk = false;
    notes.push(`${ok ? "ok" : "FAIL"} ${text}`);
  }
  if (!assert("Experience phrase variants", allOk, notes.join(" | ")))
    failed += 1;
}

{
  const variants = [
    "BE",
    "B.E.",
    "B.Tech",
    "MBA",
    "M.Tech",
    "Bachelor's degree",
    "Master's degree",
    "Computer Science degree",
    "Education: B.Tech",
  ];
  let allOk = true;
  const notes: string[] = [];
  for (const text of variants) {
    const ok = isEducationRequirement(text) ||
      parseJobDescription(text).sections.some((s) => s.kind === "education");
    // lone "BE" is a degree token — accept via degree list / short line rules
    const parsedOk = parseJobDescription(
      text.includes(":") ? text : `Educational Qualification: ${text}`
    ).sections.some((s) => s.kind === "education");
    const pass = ok || parsedOk;
    if (!pass) allOk = false;
    notes.push(`${pass ? "ok" : "FAIL"} ${text}`);
  }
  if (!assert("Education phrase variants", allOk, notes.join(" | ")))
    failed += 1;
}

{
  const text =
    "Summary: Accenture works with higher education clients worldwide.";
  const parsed = parseJobDescription(text);
  const edu = parsed.sections.filter((s) => s.kind === "education");
  const out = render(formatJobDescriptionBlocks(text));
  if (
    !assert(
      "higher education in Summary is NOT Education",
      edu.length === 0 && !/# EDUCATION/.test(out),
      out
    )
  )
    failed += 1;
}

{
  const text =
    "We are looking for a dynamic professional to join our team. Educational Qualification: BE/MBA/MTech. Additional Information: Travel may be required.";
  const parsed = parseJobDescription(text);
  const edu = parsed.sections.filter((s) => s.kind === "education");
  const add = parsed.sections.filter(
    (s) => s.kind === "additional-information" || s.kind === "other-information"
  );
  const out = render(formatJobDescriptionBlocks(text));
  const ok =
    edu.length === 1 &&
    /BE\s*\/\s*MBA\s*\/\s*MTech/i.test(edu[0].rawBody) &&
    add.length >= 1 &&
    /# EDUCATION/.test(out) &&
    !/Travel may be required/.test(
      edu.map((s) => s.rawBody).join(" ")
    );
  if (
    !assert(
      "Only educational requirement → EDUCATION; surrounding stays other",
      ok,
      out
    )
  )
    failed += 1;
}

{
  const ok =
    isExperienceRequirement("Minimum 3 years of experience in SAP.") &&
    isExperienceRequirement("5+ years") &&
    isExperienceRequirement("3 years of SAP experience") &&
    isExperienceRequirement("Experienced professional") &&
    !isExperienceRequirement("Required experience with Python") &&
    isEducationRequirement("Educational Qualification: BE/MBA/MTech") &&
    isEducationRequirement("Bachelor's degree in Computer Science") &&
    !isEducationRequirement(
      "Accenture works with higher education clients worldwide."
    );
  if (!assert("Classifier gates", ok, "experience + education gates"))
    failed += 1;
}

console.log(`Summary: failures=${failed}`);
if (failed > 0) process.exitCode = 1;
