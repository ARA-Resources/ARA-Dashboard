/**
 * Throwaway verification for the Lateral Master Sheet Job Description .docx
 * download. Builds edge-case documents, writes them to /tmp/jd-docx, and
 * asserts the crowding-bug class of failure cannot occur (skills land in real
 * table cells; no text is dropped).
 *
 * Run inside the verify container:  npx tsx scripts/verify-job-description-docx.ts
 */

import { writeFileSync, mkdirSync } from "node:fs";
import JSZip from "jszip";
import { Packer } from "docx";
import { generateStructuredJobDescriptionDocxDocument } from "@/utils/download-job-description-docx";
import type { StructuredJdPdfInput } from "@/utils/download-job-description-pdf";

const OUT = "/tmp/jd-docx";
mkdirSync(OUT, { recursive: true });

const longSkills = [
  "React",
  "TypeScript",
  "Node.js",
  "GraphQL",
  "Amazon Web Services (AWS) Solutions Architecture", // 47 chars — stays a pill
  "Distributed Systems Design and Implementation Patterns", // >48 → bullet fallback
  "Kubernetes",
  "PostgreSQL",
  "Redis",
  "Kafka",
  "CI/CD Pipeline Engineering",
  "Infrastructure as Code (Terraform)",
  "Observability & SRE Practices",
  "Python",
  "Go",
  "Rust",
  "Domain Driven Design",
  "Event Sourcing",
  "gRPC",
  "OpenTelemetry",
  "Service Mesh (Istio / Linkerd)",
  "Performance Profiling and Load Testing at Scale", // 46 chars — pill
];

const longParagraph =
  "The successful candidate will lead the design and delivery of a large-scale " +
  "distributed platform serving millions of requests per day, partnering closely " +
  "with product, design and data teams to translate ambiguous business goals into " +
  "resilient, well-tested services. ".repeat(3);

const manyBullets = Array.from({ length: 16 }, (_, i) =>
  `Responsibility ${i + 1}: own a meaningful slice of the platform end to end, ` +
  "including on-call, capacity planning, incident response and the associated " +
  "documentation and stakeholder communication that goes with it."
);

const fixtures: Record<string, StructuredJdPdfInput> = {
  "01-short-clean": {
    jobReqId: "REQ-1001",
    meta: [
      { label: "Job Requisition ID", value: "REQ-1001" },
      { label: "Primary Skill", value: "React" },
      { label: "Job Management Level", value: "9 - Specialist" },
      { label: "Primary Location", value: "Bengaluru" },
    ],
    sections: [
      { heading: "PROJECT ROLE", blocks: [{ type: "paragraph", text: "Frontend Engineer - React" }] },
      {
        heading: "RESPONSIBILITIES",
        blocks: [
          { type: "bullet", text: "Build UI components." },
          { type: "bullet", text: "Write tests." },
        ],
      },
      {
        heading: "MUST HAVE SKILLS",
        blocks: [{ type: "skillChips", variant: "must", skills: ["React", "TypeScript", "CSS"] }],
      },
    ],
  },
  "02-many-long-skills": {
    jobReqId: "REQ-2002",
    meta: [
      { label: "Job Requisition ID", value: "REQ-2002" },
      { label: "Primary Skill", value: "Platform Engineering" },
      { label: "Primary Location", value: "Remote — India" },
    ],
    sections: [
      { heading: "PROJECT ROLE", blocks: [{ type: "paragraph", text: "Principal Platform Engineer - Platform Engineering" }] },
      {
        heading: "MUST HAVE SKILLS",
        blocks: [{ type: "skillChips", variant: "must", skills: longSkills }],
      },
      {
        heading: "GOOD TO HAVE SKILLS",
        blocks: [{ type: "skillChips", variant: "good", skills: longSkills.slice(0, 12) }],
      },
    ],
  },
  "03-long-prose-and-bullets": {
    jobReqId: "REQ/3003:weird*chars",
    meta: [
      { label: "Job Requisition ID", value: "REQ/3003:weird*chars" },
      { label: "Primary Skill", value: "Backend" },
    ],
    sections: [
      { heading: "PROJECT ROLE", blocks: [{ type: "paragraph", text: longParagraph }] },
      {
        heading: "RESPONSIBILITIES",
        blocks: manyBullets.map((t) => ({ type: "bullet" as const, text: t })),
      },
      {
        heading: "EXPERIENCE",
        blocks: [
          { type: "number", text: "Ten years of backend experience.", index: "1" },
          { type: "number", text: "Five years leading teams.", index: "2" },
        ],
      },
      {
        heading: "MUST HAVE SKILLS",
        blocks: [{ type: "skillChips", variant: "must", skills: longSkills }],
      },
    ],
  },
  "04-missing-fields": {
    // no jobReqId, no meta, minimal sections
    meta: [],
    sections: [
      {
        heading: null,
        blocks: [{ type: "paragraph", text: "A bare job description with no metadata at all." }],
      },
      {
        heading: "MUST HAVE SKILLS",
        blocks: [{ type: "skillChips", variant: "generic", skills: ["Communication"] }],
      },
    ],
  },
};

function collectText(input: StructuredJdPdfInput): string[] {
  const out: string[] = [];
  for (const f of input.meta) out.push(f.value);
  for (const s of input.sections) {
    if (s.heading) out.push(s.heading.toUpperCase());
    for (const b of s.blocks) {
      if (b.type === "paragraph" || b.type === "bullet") out.push(b.text);
      else if (b.type === "number") out.push(b.text);
      else if (b.type === "skillChips") out.push(...b.skills);
    }
  }
  return out;
}

async function main() {
let failures = 0;

for (const [name, input] of Object.entries(fixtures)) {
  const doc = generateStructuredJobDescriptionDocxDocument(input);
  const buf = await Packer.toBuffer(doc);
  writeFileSync(`${OUT}/${name}.docx`, buf);

  const zip = await JSZip.loadAsync(buf);
  const xml = await zip.file("word/document.xml")!.async("string");

  // Strip tags → visible text, decode entities, normalise whitespace.
  const visible = xml
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\s+/g, " ")
    .trim();

  const problems: string[] = [];

  // 1. Every expected string survived (word-wrap can't drop content).
  for (const chunk of collectText(input)) {
    const needle = chunk.slice(0, 40).replace(/\s+/g, " ").trim();
    if (needle && !visible.includes(needle)) {
      problems.push(`missing text: "${needle}"`);
    }
  }

  // 2. Short skills rendered as inline shaded tag runs (w:shd with a fill) in a
  //    flowing paragraph — not a table grid (which stretches / ragged-rows).
  const shdCount = (xml.match(/<w:shd[^>]*w:fill="[0-9A-Fa-f]{6}"/g) ?? []).length;
  const shortSkills = new Set<string>();
  for (const s of input.sections) {
    for (const b of s.blocks) {
      if (b.type !== "skillChips") continue;
      for (const skill of b.skills) {
        const t = skill.trim();
        if (t && t.length <= 48 && t.split(/\s+/).length <= 6) shortSkills.add(t);
      }
    }
  }
  if (shortSkills.size > 0 && shdCount < shortSkills.size) {
    problems.push(
      `expected >= ${shortSkills.size} shaded tag runs, found ${shdCount}`
    );
  }
  // The only tables allowed are the header, meta grid, and footer — never one
  // per skill section. >3 tables would mean skills regressed to a grid.
  const tblCount = (xml.match(/<w:tbl>/g) ?? []).length;
  if (tblCount > 2) {
    problems.push(`unexpected table count ${tblCount} (skills back on a grid?)`);
  }

  // 3. Long single skill (>48 chars) must have fallen back to a bullet, not a pill.
  const longOne = "Distributed Systems Design and Implementation Patterns";
  if (JSON.stringify(input).includes(longOne)) {
    // numId-based bullet list marker present
    if (!xml.includes("<w:numPr>")) {
      problems.push("long skill did not fall back to a bulleted list item");
    }
  }

  // 4. Footer page numbering present.
  if (!xml.includes("PAGE") && !/<w:fldSimple[^>]*PAGE/i.test(xml)) {
    // docx emits page number as a field; check the footer part instead
    const footer = zip.file(/word\/footer\d+\.xml/)[0];
    const fxml = footer ? await footer.async("string") : "";
    if (!/PAGE/i.test(fxml)) problems.push("footer page number field missing");
  }

  const sizeKb = (buf.length / 1024).toFixed(1);
  if (problems.length) {
    failures += problems.length;
    console.log(`✗ ${name} (${sizeKb} KB, ${shdCount} tag runs)`);
    for (const p of problems) console.log(`    - ${p}`);
  } else {
    console.log(`✓ ${name} (${sizeKb} KB, ${shdCount} tag runs)`);
  }
}

console.log(failures === 0 ? "\nALL OK" : `\n${failures} PROBLEM(S)`);
process.exit(failures === 0 ? 0 : 1);
}

void main();
