/**
 * Good To Have Skills detection checks.
 * Run: npx tsx scripts/verify-good-to-have-skills.ts
 */
import {
  formatJobDescriptionBlocks,
  isGoodToHaveIndicator,
  parseJobDescription,
} from "../src/utils/format-job-description";

function assert(name: string, ok: boolean, detail: string) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  console.log(`      ${detail}\n`);
  return ok;
}

let failed = 0;

{
  const text = "Good to have knowledge of AWS and Docker.";
  const parsed = parseJobDescription(text);
  const blocks = formatJobDescriptionBlocks(text);
  const good = parsed.sections.filter((s) => s.kind === "good-to-have-skills");
  const chips = blocks.find((b) => b.type === "skillChips" && b.variant === "good");
  const skills =
    chips && chips.type === "skillChips"
      ? chips.skills.map((s) => s.toLowerCase())
      : [];
  const ok =
    good.length === 1 &&
    skills.some((s) => s.includes("aws")) &&
    skills.some((s) => s.includes("docker"));
  if (
    !assert(
      "Good to have knowledge of AWS and Docker",
      ok,
      `skills=${JSON.stringify(chips && chips.type === "skillChips" ? chips.skills : [])}`
    )
  )
    failed += 1;
}

{
  const text = "Good to have skills: NA";
  const blocks = formatJobDescriptionBlocks(text);
  const heading = blocks.some(
    (b) => b.type === "heading" && b.text === "GOOD TO HAVE SKILLS"
  );
  const none = blocks.some(
    (b) => b.type === "paragraph" && b.text === "None specified"
  );
  const chips = blocks.filter((b) => b.type === "skillChips");
  if (
    !assert(
      "Good to have skills: NA → None specified",
      heading && none && chips.length === 0,
      `heading=${heading} none=${none} chips=${chips.length}`
    )
  )
    failed += 1;
}

{
  const text =
    "Good to have skills: NA\nMinimum 3 year(s) of experience is required";
  const parsed = parseJobDescription(text);
  const good = parsed.sections.filter((s) => s.kind === "good-to-have-skills");
  const exp = parsed.sections.filter((s) => s.kind === "experience");
  const blocks = formatJobDescriptionBlocks(text);
  const none = blocks.some(
    (b) => b.type === "paragraph" && b.text === "None specified"
  );
  const expHeading = blocks.some(
    (b) => b.type === "heading" && b.text === "EXPERIENCE"
  );
  const badGoodChips = blocks.some(
    (b) =>
      b.type === "skillChips" &&
      b.variant === "good" &&
      b.skills.some((s) => /minimum|year/i.test(s))
  );
  if (
    !assert(
      "Minimum years peels to EXPERIENCE, not Good To Have chips",
      good.length === 1 &&
        exp.length >= 1 &&
        none &&
        expHeading &&
        !badGoodChips,
      `good=${good.length} exp=${exp.length} none=${none}`
    )
  )
    failed += 1;
}

{
  const text = "Minimum 3 years of experience is required.";
  const parsed = parseJobDescription(text);
  const good = parsed.sections.filter((s) => s.kind === "good-to-have-skills");
  const exp = parsed.sections.filter((s) => s.kind === "experience");
  if (
    !assert(
      "Standalone experience is never Good To Have",
      good.length === 0 && exp.length >= 1,
      `good=${good.length} exp=${exp.map((s) => s.rawBody).join(" | ")}`
    )
  )
    failed += 1;
}

{
  const text =
    "Build, configure and test packaged software & Software as a Service (SaaS) products.";
  const parsed = parseJobDescription(text);
  const good = parsed.sections.filter((s) => s.kind === "good-to-have-skills");
  if (
    !assert(
      "No Good To Have invented for unstructured SaaS JD",
      good.length === 0,
      `good=${good.length}`
    )
  )
    failed += 1;
}

{
  const variants = [
    "Good-to-have: Kubernetes",
    "Preferred skills: Kubernetes",
    "Nice to have: Kubernetes",
    "Desired skills: Kubernetes",
    "Desirable skills: Kubernetes",
    "Added advantage: Kubernetes",
    "Plus: Kubernetes",
  ];
  let allOk = true;
  const notes: string[] = [];
  for (const text of variants) {
    const parsed = parseJobDescription(text);
    const good = parsed.sections.some((s) => s.kind === "good-to-have-skills");
    const blocks = formatJobDescriptionBlocks(text);
    const chips = blocks.find((b) => b.type === "skillChips" && b.variant === "good");
    const skills =
      chips && chips.type === "skillChips"
        ? chips.skills.map((s) => s.toLowerCase())
        : [];
    const ok = good && skills.some((s) => s.includes("kubernetes"));
    if (!ok) allOk = false;
    notes.push(`${ok ? "ok" : "FAIL"} ${text}`);
  }
  if (!assert("Preferred phrase variants", allOk, notes.join(" | "))) failed += 1;
}

{
  const ok =
    isGoodToHaveIndicator("Good to have AWS") &&
    isGoodToHaveIndicator("Preferred skills: AWS") &&
    !isGoodToHaveIndicator("Minimum 3 years of experience is required") &&
    !isGoodToHaveIndicator("Must have Java");
  if (!assert("isGoodToHaveIndicator gate", ok, "explicit preferred only"))
    failed += 1;
}

console.log(`Summary: failures=${failed}`);
if (failed > 0) process.exitCode = 1;
