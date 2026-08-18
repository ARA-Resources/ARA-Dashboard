/**
 * Technical skill detection checks (read-only).
 * Run: npx tsx scripts/verify-technical-skills.ts
 */
import {
  extractTechnicalSkillsFromText,
  hasTechnicalSkillEvidence,
  filterTechnicalSkillCandidates,
  formatJobDescriptionBlocks,
  parseJobDescription,
  parseSkillChipItems,
} from "../src/utils/format-job-description";

function assert(name: string, ok: boolean, detail: string) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  console.log(`      ${detail}\n`);
  return ok;
}

let failed = 0;

const saas =
  "Build, configure and test packaged software & Software as a Service (SaaS) products.";

{
  const skills = extractTechnicalSkillsFromText(saas);
  const lower = skills.map((s) => s.toLowerCase());
  const hasSaas =
    lower.some((s) => s.includes("saas") || s.includes("software as a service"));
  const hasPackaged = lower.some((s) => s.includes("packaged software"));
  const hasAction = skills.some((s) =>
    /^(build|configure|test|develop)$/i.test(s.trim())
  );
  if (
    !assert(
      "SaaS sentence extracts tech concepts, not action verbs",
      hasSaas && !hasAction,
      `skills=${JSON.stringify(skills)} packaged=${hasPackaged}`
    )
  )
    failed += 1;
}

{
  const parsed = parseJobDescription(saas);
  const blocks = formatJobDescriptionBlocks(saas);
  const bullets = blocks.filter((b) => b.type === "bullet");
  const chips = blocks.filter((b) => b.type === "skillChips");
  const chipSkills =
    chips[0] && chips[0].type === "skillChips" ? chips[0].skills : [];
  const resp = parsed.sections.some((s) => s.kind === "responsibilities");
  const tech = parsed.sections.some((s) => s.kind === "technical-skills");
  const badChip = chipSkills.some((s) =>
    /^(build|configure|test)$/i.test(s.trim())
  );
  if (
    !assert(
      "SaaS JD → RESPONSIBILITIES bullets + TECHNICAL SKILLS chips",
      resp && tech && bullets.length >= 1 && chipSkills.length >= 1 && !badChip,
      `resp=${resp} tech=${tech} bullets=${bullets.length} chips=${JSON.stringify(chipSkills)}`
    )
  )
    failed += 1;
}

{
  const ok =
    !hasTechnicalSkillEvidence("Build") &&
    !hasTechnicalSkillEvidence("Configure") &&
    !hasTechnicalSkillEvidence("Test") &&
    !hasTechnicalSkillEvidence("Support") &&
    !hasTechnicalSkillEvidence("Manage") &&
    hasTechnicalSkillEvidence("Java") &&
    hasTechnicalSkillEvidence("Python") &&
    hasTechnicalSkillEvidence("SAP CRM") &&
    hasTechnicalSkillEvidence("Spring Boot") &&
    hasTechnicalSkillEvidence("Kubernetes") &&
    hasTechnicalSkillEvidence("SaaS");
  if (!assert("Evidence gate for verbs vs technologies", ok, "catalog checks"))
    failed += 1;
}

{
  const filtered = filterTechnicalSkillCandidates([
    "Build",
    "Java",
    "Configure",
    "AWS",
    "products",
  ]);
  const ok =
    filtered !== null &&
    filtered.length === 2 &&
    filtered.some((s) => /java/i.test(s)) &&
    filtered.some((s) => /aws/i.test(s));
  if (
    !assert(
      "filterTechnicalSkillCandidates drops verbs/generics",
      ok,
      JSON.stringify(filtered)
    )
  )
    failed += 1;
}

{
  const chips = parseSkillChipItems("Java, Python, SQL, React");
  const ok =
    chips !== null &&
    chips.length >= 3 &&
    !chips.some((s) => /^(build|test)$/i.test(s));
  if (
    !assert(
      "Explicit skill list chips with evidence",
      ok,
      JSON.stringify(chips)
    )
  )
    failed += 1;
}

{
  const chips = parseSkillChipItems("Strong communication and ownership mindset");
  if (
    !assert(
      "Vague soft-skill blob does not invent tech chips",
      chips === null,
      JSON.stringify(chips)
    )
  )
    failed += 1;
}

{
  const chips = parseSkillChipItems("Build, Configure, Test");
  if (
    !assert(
      "Action-verb list is not technical skills",
      chips === null,
      JSON.stringify(chips)
    )
  )
    failed += 1;
}

console.log(`Summary: failures=${failed}`);
if (failed > 0) process.exitCode = 1;
