/**
 * ADDITIONAL INFORMATION + OTHER INFORMATION fallback checks.
 * Run: npx tsx scripts/verify-fallback-sections.ts
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
      if (b.type === "skillChips") return `[${b.variant}:${b.skills.join(",")}]`;
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

/** Rough check that original wording is still present across sections/blocks. */
function preservesWording(original: string, rendered: string): boolean {
  const needed = tokens(original).filter(
    (t) =>
      !/^(additional|information|other|the|and|for|with|from)$/i.test(t)
  );
  const hay = tokens(rendered).join(" ");
  const missing = needed.filter((t) => !hay.includes(t));
  return missing.length === 0;
}

let failed = 0;

{
  const text =
    "Additional Information:\nTravel may be required.\nMinimum 3 years of experience is required.\nShift flexibility preferred.";
  const parsed = parseJobDescription(text);
  const add = parsed.sections.filter((s) => s.kind === "additional-information");
  const exp = parsed.sections.filter((s) => s.kind === "experience");
  const out = render(formatJobDescriptionBlocks(text));
  const ok =
    add.length === 1 &&
    /Travel may be required/i.test(add[0].rawBody) &&
    /Minimum 3 years of experience is required/i.test(add[0].rawBody) &&
    /Shift flexibility preferred/i.test(add[0].rawBody) &&
    exp.length === 0 &&
    /# ADDITIONAL INFORMATION/.test(out);
  if (
    !assert(
      "Additional Information keeps experience lines (no peel to EXPERIENCE)",
      ok,
      out
    )
  )
    failed += 1;
}

{
  const text =
    "Additional Information: Includes educational qualifications for tuition support and BE mentoring.";
  const parsed = parseJobDescription(text);
  const add = parsed.sections.filter((s) => s.kind === "additional-information");
  const edu = parsed.sections.filter((s) => s.kind === "education");
  const ok =
    add.length === 1 &&
    /educational qualifications for tuition/i.test(add[0].rawBody) &&
    edu.length === 0;
  if (
    !assert(
      "Mid-sentence educational wording stays in Additional Information",
      ok,
      JSON.stringify(parsed.sections.map((s) => ({ k: s.kind, b: s.rawBody })))
    )
  )
    failed += 1;
}

{
  const text =
    "Additional Information:\nTravel may be required.\nEducational Qualification: BE/MBA/MTech";
  const parsed = parseJobDescription(text);
  const add = parsed.sections.filter((s) => s.kind === "additional-information");
  const edu = parsed.sections.filter((s) => s.kind === "education");
  const out = render(formatJobDescriptionBlocks(text));
  const ok =
    add.length === 1 &&
    /Travel may be required/i.test(add[0].rawBody) &&
    edu.length === 1 &&
    /BE/i.test(edu[0].rawBody) &&
    /# EDUCATION/.test(out);
  if (
    !assert(
      "Line-start Educational Qualification may end Additional Information",
      ok,
      out
    )
  )
    failed += 1;
}

{
  const text =
    "We need a flexible teammate who enjoys ambiguous problem spaces and stakeholder workshops.";
  const parsed = parseJobDescription(text);
  const other = parsed.sections.filter((s) => s.kind === "other-information");
  const out = render(formatJobDescriptionBlocks(text));
  const ok =
    other.length >= 1 &&
    /flexible teammate/i.test(other.map((s) => s.rawBody).join(" ")) &&
    /# OTHER INFORMATION/.test(out) &&
    preservesWording(text, out);
  if (
    !assert(
      "Unstructured uncertain prose → OTHER INFORMATION (preserved)",
      ok,
      out
    )
  )
    failed += 1;
}

{
  const text =
    "Other Information: Badge access required. Weekend on-call rotation.";
  const parsed = parseJobDescription(text);
  const other = parsed.sections.filter((s) => s.kind === "other-information");
  const out = render(formatJobDescriptionBlocks(text));
  const ok =
    other.length >= 1 &&
    /Badge access required/i.test(other.map((s) => s.rawBody).join(" ")) &&
    /# OTHER INFORMATION/.test(out);
  if (!assert("Explicit Other Information heading", ok, out)) failed += 1;
}

{
  const text =
    "Project Role: Engineer\nAdditional Information:\nClient site visits monthly.\nSome unstructured compliance note about background checks.";
  const parsed = parseJobDescription(text);
  const other = parsed.sections.filter((s) => s.kind === "other-information");
  const add = parsed.sections.filter((s) => s.kind === "additional-information");
  const out = render(formatJobDescriptionBlocks(text));
  // Compliance note after Additional Information with no new heading stays in Additional
  // (preserve body). Unstructured-only docs use OTHER. Here Additional keeps its body.
  const ok =
    add.some((s) => /Client site visits monthly/i.test(s.rawBody)) &&
    add.some((s) => /background checks/i.test(s.rawBody)) &&
    preservesWording(text, out) &&
    !other.some((s) => /Client site visits/i.test(s.rawBody));
  if (
    !assert(
      "Additional Information body preserved intact; no deletion",
      ok,
      out
    )
  )
    failed += 1;
}

{
  const text =
    "Build packaged software.\nAlso coordinate with vendors on licensing renewals when needed.";
  const parsed = parseJobDescription(text);
  const kinds = parsed.sections.map((s) => s.kind);
  const out = render(formatJobDescriptionBlocks(text));
  const hasOtherOrResp =
    kinds.includes("other-information") || kinds.includes("responsibilities");
  const ok = hasOtherOrResp && preservesWording(text, out);
  if (
    !assert(
      "Never delete unclassified / mixed content",
      ok,
      `kinds=${kinds.join(",")} out=${out}`
    )
  )
    failed += 1;
}

console.log(`Summary: failures=${failed}`);
if (failed > 0) process.exitCode = 1;
