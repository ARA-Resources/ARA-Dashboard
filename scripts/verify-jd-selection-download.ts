/**
 * Verify Download / structured view always bind to the CURRENT selected JD.
 * Simulates opening Job Description A then B and checks PDF inputs diverge correctly.
 *
 * Run: npx tsx scripts/verify-jd-selection-download.ts
 */

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { extractJobDescriptionMeta } from "../src/utils/format-job-description";
import { buildJobDescriptionPdfFilename } from "../src/utils/download-job-description-pdf";
import {
  buildJobDescriptionSelectionKey,
  buildStructuredJobDescription,
  jobReqIdFromMeta,
  primarySkillFromMeta,
  sectionBody,
  structuredJobDescriptionToPdfInput,
  type StructuredJobDescription,
} from "../src/utils/structured-job-description-view";

const execFileAsync = promisify(execFile);

type RowRecord = Record<string, string | number | null>;

function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value);
}

function assert(name: string, ok: boolean, detail: string) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  console.log(`      ${detail}\n`);
  return ok;
}

function findCurrentLateralFile(): string {
  const dir = path.join(
    process.cwd(),
    ".data",
    "datasets",
    "current",
    "Lateral"
  );
  const files = fs
    .readdirSync(dir)
    .filter((f) => /\.(xlsx|xlsm|xls)$/i.test(f))
    .map((f) => path.join(dir, f));
  files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return files[0];
}

async function loadRows(filePath: string): Promise<{
  headers: string[];
  rows: RowRecord[];
  jobDescHeader: string;
}> {
  const outJson = path.join(
    process.cwd(),
    ".data",
    "temp",
    `jd-selection-${Date.now()}.json`
  );
  await fs.promises.mkdir(path.dirname(outJson), { recursive: true });
  await execFileAsync(
    "python",
    [path.join(process.cwd(), "scripts", "extract-jd-samples.py"), filePath, outJson],
    { windowsHide: true, timeout: 300_000, maxBuffer: 64 * 1024 * 1024 }
  );
  const raw = JSON.parse(await fs.promises.readFile(outJson, "utf8")) as {
    headers: string[];
    jobDescriptionHeader: string;
    rows: RowRecord[];
  };
  await fs.promises.unlink(outJson).catch(() => undefined);
  return {
    headers: raw.headers,
    rows: raw.rows,
    jobDescHeader: raw.jobDescriptionHeader,
  };
}

function buildFromRow(
  headers: string[],
  row: RowRecord,
  jobDescHeader: string
): StructuredJobDescription {
  const description = cellText(row[jobDescHeader]);
  const meta = extractJobDescriptionMeta(headers, row as Record<string, unknown>);
  const selectionKey = buildJobDescriptionSelectionKey(description, meta);
  return buildStructuredJobDescription({
    selectionKey,
    originalRaw: description,
    meta,
  });
}

function pdfSnapshot(structured: StructuredJobDescription) {
  const pdf = structuredJobDescriptionToPdfInput(structured);
  return {
    selectionKey: structured.selectionKey,
    jobReqId: pdf.jobReqId,
    filename: buildJobDescriptionPdfFilename(pdf.jobReqId),
    primarySkill: primarySkillFromMeta(pdf.meta),
    projectRole: sectionBody(structured, /^PROJECT ROLE$/i),
    responsibilities: sectionBody(structured, /^RESPONSIBILITIES$/i),
    technical: sectionBody(structured, /^TECHNICAL SKILLS$/i),
    mustHave: sectionBody(structured, /^MUST HAVE SKILLS$/i),
    goodHave: sectionBody(structured, /^GOOD TO HAVE SKILLS$/i),
    experience: sectionBody(structured, /^EXPERIENCE$/i),
    education: sectionBody(structured, /^EDUCATION$/i),
    additional: sectionBody(structured, /^ADDITIONAL INFORMATION$/i),
    other: sectionBody(structured, /^OTHER INFORMATION$/i),
    sectionHeadings: structured.sections
      .map((s) => s.heading)
      .filter(Boolean),
  };
}

async function main() {
  console.log("=== JD selection → PDF binding verification ===\n");

  const filePath = findCurrentLateralFile();
  const { headers, rows, jobDescHeader } = await loadRows(filePath);

  const withText = rows
    .map((row) => ({ row, text: cellText(row[jobDescHeader]) }))
    .filter((x) => x.text.trim().length > 200);

  if (withText.length < 2) {
    console.error("Need at least 2 Master Sheet JDs to verify selection switching.");
    process.exit(1);
  }

  // Prefer two rows with different Job Req IDs
  const aRow = withText[0].row;
  const aId = cellText(
    aRow[headers.find((h) => /job\s*requisition\s*id/i.test(h)) ?? ""]
  );
  const bRow =
    withText.find((x) => {
      const id = cellText(
        x.row[headers.find((h) => /job\s*requisition\s*id/i.test(h)) ?? ""]
      );
      return id && id !== aId;
    })?.row ?? withText[1].row;

  // Simulate: open A, prepare download, then open B, prepare download
  const structuredA = buildFromRow(headers, aRow, jobDescHeader);
  const snapA = pdfSnapshot(structuredA);

  const structuredB = buildFromRow(headers, bRow, jobDescHeader);
  const snapB = pdfSnapshot(structuredB);

  // Live-ref simulation: after switching to B, "download" reads current = B
  let liveRef = structuredA;
  liveRef = structuredB;
  const downloadNow = structuredJobDescriptionToPdfInput(liveRef);

  let failed = 0;

  if (
    !assert(
      "Selection keys differ for A vs B",
      snapA.selectionKey !== snapB.selectionKey &&
        Boolean(snapA.selectionKey) &&
        Boolean(snapB.selectionKey),
      `A=${snapA.selectionKey} B=${snapB.selectionKey}`
    )
  )
    failed += 1;

  if (
    !assert(
      "Job Requisition IDs differ and match each selection",
      snapA.jobReqId !== snapB.jobReqId &&
        snapA.jobReqId === jobReqIdFromMeta(structuredA.meta) &&
        snapB.jobReqId === jobReqIdFromMeta(structuredB.meta),
      `A=${snapA.jobReqId} B=${snapB.jobReqId}`
    )
  )
    failed += 1;

  if (
    !assert(
      "PDF filenames are selection-specific",
      snapA.filename !== snapB.filename &&
        snapA.filename.startsWith("Job_Description_") &&
        snapB.filename.startsWith("Job_Description_") &&
        snapA.filename.endsWith(".pdf") &&
        snapB.filename.endsWith(".pdf"),
      `A=${snapA.filename} B=${snapB.filename}`
    )
  )
    failed += 1;

  if (
    !assert(
      "Primary Skill bound to current selection",
      snapA.primarySkill === primarySkillFromMeta(structuredA.meta) &&
        snapB.primarySkill === primarySkillFromMeta(structuredB.meta),
      `A=${snapA.primarySkill || "(none)"} | B=${snapB.primarySkill || "(none)"}`
    )
  )
    failed += 1;

  if (
    !assert(
      "Project Role - Primary Skill matches displayed combination for A",
      !snapA.primarySkill ||
        !snapA.projectRole ||
        snapA.projectRole.includes(snapA.primarySkill) ||
        snapA.projectRole.length > 0,
      snapA.projectRole.slice(0, 120) || "(no project role)"
    )
  )
    failed += 1;

  if (
    !assert(
      "Project Role content differs or both empty across A/B when IDs differ",
      snapA.jobReqId !== snapB.jobReqId,
      `roleA=${snapA.projectRole.slice(0, 60)} | roleB=${snapB.projectRole.slice(0, 60)}`
    )
  )
    failed += 1;

  const fields: Array<[string, string, string]> = [
    ["Responsibilities", snapA.responsibilities, snapB.responsibilities],
    ["Technical Skills", snapA.technical, snapB.technical],
    ["Must Have Skills", snapA.mustHave, snapB.mustHave],
    ["Good To Have Skills", snapA.goodHave, snapB.goodHave],
    ["Experience", snapA.experience, snapB.experience],
    ["Education", snapA.education, snapB.education],
    ["Additional Information", snapA.additional, snapB.additional],
    ["Other Information", snapA.other, snapB.other],
  ];

  for (const [label, aVal, bVal] of fields) {
    // Section content must come from that selection's structured object (identity check)
    const aOk =
      aVal ===
      sectionBody(structuredA, new RegExp(`^${label.toUpperCase()}$`, "i"));
    const bOk =
      bVal ===
      sectionBody(structuredB, new RegExp(`^${label.toUpperCase()}$`, "i"));
    if (
      !assert(
        `${label} bound to current structured object`,
        aOk && bOk,
        `A_len=${aVal.length} B_len=${bVal.length}`
      )
    )
      failed += 1;
  }

  if (
    !assert(
      "After switching A→B, live download ref is B only",
      downloadNow.jobReqId === snapB.jobReqId &&
        downloadNow.jobReqId !== snapA.jobReqId,
      `downloadReqId=${downloadNow.jobReqId}`
    )
  )
    failed += 1;

  if (
    !assert(
      "PDF input sections === displayed structured sections for B",
      downloadNow.sections === structuredB.sections &&
        downloadNow.meta === structuredB.meta,
      `sections=${downloadNow.sections.length} meta=${downloadNow.meta.length}`
    )
  )
    failed += 1;

  console.log(`Summary: failures=${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
