/**
 * Information completeness checks (missing content → OTHER INFORMATION).
 * Run: npx tsx scripts/verify-completeness.ts
 */
import {
  formatJobDescriptionBlocks,
  parseJobDescription,
} from "../src/utils/format-job-description";
import {
  ensureInformationCompleteness,
  findUnrepresentedOriginalUnits,
  stripLeadingSectionLabel,
} from "../src/utils/parse-job-description";

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

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9+#./]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2);
}

function preservesMeaningfulContent(original: string, rendered: string): boolean {
  const skip = /^(additional|information|other|the|and|for|with|from|must|have|skills|good|to|project|role)$/i;
  const needed = tokens(original).filter((t) => !skip.test(t));
  const hay = tokens(rendered).join(" ");
  const missing = needed.filter((t) => !hay.includes(t));
  return missing.length === 0;
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
  const missing = findUnrepresentedOriginalUnits(mixed, parsed.sections);
  const corpus = parsed.sections
    .map((s) => `${s.title}\n${s.rawBody}`)
    .join("\n");
  const out = render(formatJobDescriptionBlocks(mixed));
  const other = parsed.sections.filter((s) => s.kind === "other-information");
  const ok =
    missing.length === 0 &&
    preservesMeaningfulContent(mixed, corpus) &&
    /Pune/i.test(out) &&
    !other.some((s) => /Design and build/i.test(s.rawBody));
  if (
    !assert(
      "Fully classified mixed JD needs no completeness OTHER dump",
      ok,
      `missing=${JSON.stringify(missing)} other=${other.map((s) => s.rawBody).join(" | ")}\n${out}`
    )
  )
    failed += 1;
}

{
  // Simulate a parse that dropped an unclassified sentence
  const original =
    "Must have skills: Python, AWS.\nBackground verification is mandatory for all hires.";
  const incomplete = parseJobDescription("Must have skills: Python, AWS.");
  const repaired = ensureInformationCompleteness(original, incomplete.sections);
  const missingBefore = findUnrepresentedOriginalUnits(
    original,
    incomplete.sections
  );
  const missingAfter = findUnrepresentedOriginalUnits(original, repaired);
  const other = repaired.filter((s) => s.kind === "other-information");
  const ok =
    missingBefore.some((u) => /Background verification/i.test(u)) &&
    missingAfter.length === 0 &&
    other.some((s) => /Background verification is mandatory for all hires/i.test(s.rawBody));
  if (
    !assert(
      "Dropped sentence is preserved under OTHER INFORMATION",
      ok,
      `before=${JSON.stringify(missingBefore)} after=${JSON.stringify(missingAfter)} other=${other.map((s) => s.rawBody).join(" | ")}`
    )
  )
    failed += 1;
}

{
  const text =
    "We need a flexible teammate who enjoys ambiguous problem spaces and stakeholder workshops.";
  const parsed = parseJobDescription(text);
  const other = parsed.sections.filter((s) => s.kind === "other-information");
  const missing = findUnrepresentedOriginalUnits(text, parsed.sections);
  const out = render(formatJobDescriptionBlocks(text));
  const ok =
    missing.length === 0 &&
    other.some((s) => /flexible teammate/i.test(s.rawBody)) &&
    preservesMeaningfulContent(text, out);
  if (
    !assert(
      "Uncertain prose stays represented (OTHER INFORMATION)",
      ok,
      out
    )
  )
    failed += 1;
}

{
  const text =
    "Build, configure and test packaged software & Software as a Service (SaaS) products.";
  const parsed = parseJobDescription(text);
  const missing = findUnrepresentedOriginalUnits(text, parsed.sections);
  const out = render(formatJobDescriptionBlocks(text));
  const ok = missing.length === 0 && preservesMeaningfulContent(text, out);
  if (
    !assert(
      "Unstructured SaaS JD remains complete after formatting",
      ok,
      `missing=${JSON.stringify(missing)}\n${out}`
    )
  )
    failed += 1;
}

{
  const stripped = stripLeadingSectionLabel("Must have skills: Java, SQL.");
  const ok = /^Java,\s*SQL\.?$/i.test(stripped);
  if (
    !assert(
      "stripLeadingSectionLabel keeps skill body",
      ok,
      JSON.stringify(stripped)
    )
  )
    failed += 1;
}

{
  const text =
    "Project Role: Engineer\nAdditional Information:\nClient site visits monthly.\nSome unstructured compliance note about background checks.";
  const parsed = parseJobDescription(text);
  const missing = findUnrepresentedOriginalUnits(text, parsed.sections);
  const out = render(formatJobDescriptionBlocks(text));
  const ok = missing.length === 0 && preservesMeaningfulContent(text, out);
  if (
    !assert(
      "Additional Information body still complete (no deletion)",
      ok,
      `missing=${JSON.stringify(missing)}\n${out}`
    )
  )
    failed += 1;
}

console.log(`Summary: failures=${failed}`);
process.exit(failed > 0 ? 1 : 0);
