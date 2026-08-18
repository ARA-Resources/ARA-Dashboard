/**
 * Must Have Skills detection checks.
 * Run: npx tsx scripts/verify-must-have-skills.ts
 */
import {
  formatJobDescriptionBlocks,
  isMustHaveIndicator,
  parseJobDescription,
} from "../src/utils/format-job-description";

function assert(name: string, ok: boolean, detail: string) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  console.log(`      ${detail}\n`);
  return ok;
}

let failed = 0;

{
  const text = "Must have experience with Java and Spring Boot.";
  const parsed = parseJobDescription(text);
  const blocks = formatJobDescriptionBlocks(text);
  const must = parsed.sections.filter((s) => s.kind === "must-have-skills");
  const chips = blocks.find((b) => b.type === "skillChips" && b.variant === "must");
  const skills =
    chips && chips.type === "skillChips" ? chips.skills.map((s) => s.toLowerCase()) : [];
  const hasJava = skills.some((s) => s === "java");
  const hasSpring = skills.some((s) => /spring\s*boot/i.test(s));
  const heading = blocks.some(
    (b) => b.type === "heading" && b.text === "MUST HAVE SKILLS"
  );
  if (
    !assert(
      "Must have experience with Java and Spring Boot",
      must.length === 1 && heading && hasJava && hasSpring,
      `sections=${must.length} skills=${JSON.stringify(chips && chips.type === "skillChips" ? chips.skills : [])}`
    )
  )
    failed += 1;
}

{
  const text =
    "Must have strong experience with Java and Spring Boot for enterprise application development.";
  const blocks = formatJobDescriptionBlocks(text);
  const chips = blocks.find((b) => b.type === "skillChips" && b.variant === "must");
  const skills =
    chips && chips.type === "skillChips" ? chips.skills.map((s) => s.toLowerCase()) : [];
  const prose = blocks
    .filter((b) => b.type === "paragraph" || b.type === "bullet")
    .map((b) =>
      b.type === "paragraph" || b.type === "bullet" ? b.text : ""
    )
    .join(" ");
  const ok =
    skills.some((s) => s === "java") &&
    skills.some((s) => /spring/.test(s)) &&
    /enterprise application development/i.test(prose) &&
    /strong experience/i.test(prose);
  if (
    !assert(
      "Must have + context preserved",
      ok,
      `skills=${JSON.stringify(chips && chips.type === "skillChips" ? chips.skills : [])} prose=${JSON.stringify(prose)}`
    )
  )
    failed += 1;
}

{
  const text =
    "Build, configure and test packaged software & Software as a Service (SaaS) products.";
  const parsed = parseJobDescription(text);
  const must = parsed.sections.filter((s) => s.kind === "must-have-skills");
  const chips = formatJobDescriptionBlocks(text).filter(
    (b) => b.type === "skillChips" && b.variant === "must"
  );
  if (
    !assert(
      "No Must Have invented for unstructured SaaS JD",
      must.length === 0 && chips.length === 0,
      `mustSections=${must.length} mustChips=${chips.length}`
    )
  )
    failed += 1;
}

{
  const variants = [
    "Must-have skills: Python, AWS",
    "Must to have skills: Python, AWS",
    "Required skills: Python, AWS",
    "Mandatory skills: Python, AWS",
    "Essential skills: Python, AWS",
    "Required experience with Python and AWS",
    "Candidate must have Python and AWS",
    "Candidate should have Python and AWS",
    "Strong experience in Python and AWS",
  ];
  let allOk = true;
  const notes: string[] = [];
  for (const text of variants) {
    const parsed = parseJobDescription(text);
    const must = parsed.sections.some((s) => s.kind === "must-have-skills");
    const blocks = formatJobDescriptionBlocks(text);
    const chips = blocks.find((b) => b.type === "skillChips" && b.variant === "must");
    const skills =
      chips && chips.type === "skillChips"
        ? chips.skills.map((s) => s.toLowerCase())
        : [];
    const ok =
      must &&
      skills.some((s) => s.includes("python")) &&
      skills.some((s) => s.includes("aws"));
    if (!ok) allOk = false;
    notes.push(`${ok ? "ok" : "FAIL"} ${text.slice(0, 28)}… → ${JSON.stringify(skills)}`);
  }
  if (!assert("Mandatory phrase variants", allOk, notes.join(" | "))) failed += 1;
}

{
  const ok =
    isMustHaveIndicator("Must have experience with Java") &&
    isMustHaveIndicator("Required skills: Java") &&
    !isMustHaveIndicator("Build packaged software with Java") &&
    !isMustHaveIndicator("Nice to know Java");
  if (!assert("isMustHaveIndicator gate", ok, "explicit only")) failed += 1;
}

console.log(`Summary: failures=${failed}`);
if (failed > 0) process.exitCode = 1;
