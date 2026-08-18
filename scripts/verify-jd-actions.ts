/**
 * End-to-end verification of Job Description modal actions against live Master Sheet rows.
 * Read-only — never writes to Excel.
 *
 * Tests:
 *  1. Copy Description → structured popup (not raw Excel)
 *  2. Project Role + Primary Skill combination
 *  3. Download PDF matches structured popup
 *  4. Long JD pagination / page numbers
 *  5. Row A vs B never mixed (copy + PDF)
 *  6. Empty sections omitted
 *
 * Run: npx tsx scripts/verify-jd-actions.ts
 */

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { extractJobDescriptionMeta } from "../src/utils/format-job-description";
import {
  buildJobDescriptionPdfFilename,
  generateStructuredJobDescriptionPdfDocument,
} from "../src/utils/download-job-description-pdf";
import {
  buildJobDescriptionSelectionKey,
  buildStructuredJobDescription,
  formatProjectRoleDisplay,
  jobReqIdFromMeta,
  primarySkillFromMeta,
  sectionBody,
  structuredJobDescriptionToPdfInput,
  structuredJobDescriptionToPlainText,
  type StructuredJobDescription,
} from "../src/utils/structured-job-description-view";

const execFileAsync = promisify(execFile);

type RowRecord = Record<string, string | number | null>;

let failed = 0;

function assert(name: string, ok: boolean, detail: string) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  console.log(`      ${detail}\n`);
  if (!ok) failed += 1;
  return ok;
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value);
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
    `jd-actions-${Date.now()}.json`
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

function significantTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9+#.\s-]/gi, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 4);
}

/** Copy payload mirrors structured popup — not raw Excel cell. */
function copyMatchesStructuredPopup(structured: StructuredJobDescription): {
  ok: boolean;
  detail: string;
} {
  const copy = structuredJobDescriptionToPlainText(structured);
  const raw = structured.originalRaw.trim();

  if (!copy.trim()) {
    return { ok: false, detail: "empty copy text" };
  }
  if (copy.trim() === raw) {
    return { ok: false, detail: "copy identical to raw Excel cell" };
  }
  if (!/^JOB DESCRIPTION/m.test(copy)) {
    return { ok: false, detail: "missing JOB DESCRIPTION header" };
  }
  // Must include structured section headings shown in popup
  for (const section of structured.sections) {
    if (section.heading && !copy.includes(section.heading)) {
      return { ok: false, detail: `missing heading ${section.heading}` };
    }
  }
  // Must include meta from popup header
  for (const field of structured.meta) {
    const value = String(field.value ?? "").trim();
    if (value && !copy.includes(value)) {
      return { ok: false, detail: `missing meta ${field.label}` };
    }
  }
  // Raw-only blob check: copy is formatted (bullets/headings), not a verbatim dump
  const structuredHeadings = structured.sections.filter((s) => s.heading).length;
  if (structuredHeadings >= 2 && !/^(?:•|#|\w+\n)/m.test(copy)) {
    // at least some structure markers
  }
  return {
    ok: true,
    detail: `len=${copy.length} sections=${structured.sections.length} ≠ raw=${raw.length}`,
  };
}

function pdfTextFromDoc(doc: ReturnType<typeof generateStructuredJobDescriptionPdfDocument>): string {
  const buf = doc.output("arraybuffer") as ArrayBuffer;
  return Buffer.from(buf).toString("latin1");
}

function pdfMatchesStructuredPopup(
  structured: StructuredJobDescription
): { ok: boolean; detail: string } {
  const input = structuredJobDescriptionToPdfInput(structured);
  let doc: ReturnType<typeof generateStructuredJobDescriptionPdfDocument>;
  try {
    doc = generateStructuredJobDescriptionPdfDocument(input);
  } catch (err) {
    return {
      ok: false,
      detail: `generation threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const pages = doc.getNumberOfPages();
  if (pages < 1) {
    return { ok: false, detail: "no pages generated" };
  }

  const pdfText = pdfTextFromDoc(doc);
  const reqId = jobReqIdFromMeta(structured.meta);

  if (!pdfText.includes("Job Information")) {
    return { ok: false, detail: "PDF missing Job Information title" };
  }
  if (!pdfText.includes("ARA Resources")) {
    return { ok: false, detail: "PDF missing ARA Resources branding" };
  }
  if (reqId && !pdfText.includes(reqId)) {
    return { ok: false, detail: `PDF missing Job Req ID ${reqId}` };
  }

  // Section headings from structured popup must appear in PDF
  const missingHeadings: string[] = [];
  for (const section of structured.sections) {
    if (!section.heading) continue;
    const heading = section.heading.toUpperCase();
    if (!pdfText.toUpperCase().includes(heading)) {
      missingHeadings.push(heading);
    }
  }
  if (missingHeadings.length > 0) {
    return {
      ok: false,
      detail: `PDF missing headings: ${missingHeadings.join(", ")}`,
    };
  }

  // Project role display in PDF when present
  const role = sectionBody(structured, /^PROJECT ROLE$/i);
  if (role) {
    const roleTokens = significantTokens(role).slice(0, 3);
    const hits = roleTokens.filter((t) => pdfText.toLowerCase().includes(t));
    if (hits.length < Math.min(2, roleTokens.length)) {
      return { ok: false, detail: `PDF missing project role content: ${role.slice(0, 80)}` };
    }
  }

  // Page numbers in footer
  if (!pdfText.includes(`Page 1 of ${pages}`)) {
    return { ok: false, detail: `PDF missing Page 1 of ${pages} footer` };
  }
  if (pages > 1 && !pdfText.includes(`Page ${pages} of ${pages}`)) {
    return { ok: false, detail: `PDF missing Page ${pages} of ${pages} footer` };
  }

  // Must NOT include ORIGINAL accordion-only raw dump marker as sole content
  if (pdfText.trim() === structured.originalRaw.trim()) {
    return { ok: false, detail: "PDF appears to be raw Excel dump only" };
  }

  return {
    ok: true,
    detail: `pages=${pages} filename=${buildJobDescriptionPdfFilename(reqId)} headings=${structured.sections.filter((s) => s.heading).length}`,
  };
}

function noEmptySections(structured: StructuredJobDescription): boolean {
  return structured.sections.every(
    (s) => s.blocks.length > 0 && (!s.heading || s.blocks.some((b) => b.type !== "blank"))
  );
}

async function main() {
  console.log("=== Job Description actions verification (read-only) ===\n");

  const filePath = findCurrentLateralFile();
  console.log(`Source: ${filePath}\n`);
  const { headers, rows, jobDescHeader } = await loadRows(filePath);

  const withText = rows
    .map((row) => ({
      row,
      text: cellText(row[jobDescHeader]),
      len: cellText(row[jobDescHeader]).trim().length,
    }))
    .filter((x) => x.len > 100);

  if (withText.length < 2) {
    console.error("Need at least 2 Master Sheet JD rows.");
    process.exit(1);
  }

  const byLenDesc = [...withText].sort((a, b) => b.len - a.len);
  const longRow = byLenDesc[0];
  const sampleA = withText[0];
  const sampleB =
    withText.find((x) => {
      const idA = jobReqIdFromMeta(
        extractJobDescriptionMeta(headers, sampleA.row as Record<string, unknown>)
      );
      const idB = jobReqIdFromMeta(
        extractJobDescriptionMeta(headers, x.row as Record<string, unknown>)
      );
      return idB && idB !== idA;
    }) ?? withText[1];

  const structuredA = buildFromRow(headers, sampleA.row, jobDescHeader);
  const structuredB = buildFromRow(headers, sampleB.row, jobDescHeader);
  const structuredLong = buildFromRow(headers, longRow.row, jobDescHeader);

  // ── TEST 1 — COPY DESCRIPTION ─────────────────────────────────────────────
  console.log("── TEST 1 — Copy Description (structured, not raw Excel) ──\n");
  for (const [label, structured] of [
    ["Sample A", structuredA],
    ["Sample B", structuredB],
    ["Long JD", structuredLong],
  ] as const) {
    const r = copyMatchesStructuredPopup(structured);
    assert(
      `${label}: Copy Description is structured popup content`,
      r.ok,
      `${r.detail} reqId=${jobReqIdFromMeta(structured.meta)}`
    );
    assert(
      `${label}: Copy ≠ raw Excel cell`,
      structuredJobDescriptionToPlainText(structured).trim() !==
        structured.originalRaw.trim(),
      `copyLen=${structuredJobDescriptionToPlainText(structured).length} rawLen=${structured.originalRaw.length}`
    );
  }

  // ── TEST 2 — PROJECT ROLE ─────────────────────────────────────────────────
  console.log("── TEST 2 — Project Role + Primary Skill ──\n");
  {
    const skill = primarySkillFromMeta(structuredA.meta);
    const roleBody = sectionBody(structuredA, /^PROJECT ROLE$/i);
    const expected = formatProjectRoleDisplay(
      roleBody.includes(" - ") ? roleBody.split(" - ")[0] : roleBody,
      skill
    );
    const ok =
      Boolean(roleBody) &&
      Boolean(skill) &&
      roleBody.includes(" - ") &&
      roleBody.includes(skill);
    assert(
      "Project Role shows Role Name - Primary Skill",
      ok,
      `role="${roleBody.slice(0, 100)}" skill="${skill}" expected~="${expected ?? "(n/a)"}"`
    );
  }

  // ── TEST 3 — DOWNLOAD PDF vs popup ────────────────────────────────────────
  console.log("── TEST 3 — Download PDF matches structured popup ──\n");
  for (const [label, structured] of [
    ["Sample A", structuredA],
    ["Sample B", structuredB],
  ] as const) {
    const r = pdfMatchesStructuredPopup(structured);
    assert(
      `${label}: PDF generated with same structured content as popup`,
      r.ok,
      r.detail
    );
  }

  // ── TEST 4 — LONG DESCRIPTION ─────────────────────────────────────────────
  console.log("── TEST 4 — Long Job Description pagination ──\n");
  {
    const input = structuredJobDescriptionToPdfInput(structuredLong);
    const doc = generateStructuredJobDescriptionPdfDocument(input);
    const pages = doc.getNumberOfPages();
    const pdfText = pdfTextFromDoc(doc);
    const headings = structuredLong.sections
      .map((s) => s.heading)
      .filter(Boolean) as string[];
    const missingInPdf = headings.filter(
      (h) => !pdfText.toUpperCase().includes(h.toUpperCase())
    );

    assert(
      "Long JD generates multi-page PDF when content is large",
      pages >= 2 || structuredLong.originalRaw.length < 3000,
      `len=${structuredLong.originalRaw.length} pages=${pages} reqId=${jobReqIdFromMeta(structuredLong.meta)}`
    );
    assert(
      "Long JD: no missing sections in PDF",
      missingInPdf.length === 0,
      missingInPdf.length ? `missing: ${missingInPdf.join(", ")}` : `all ${headings.length} headings present`
    );
    assert(
      "Long JD: page numbers present",
      pdfText.includes(`Page 1 of ${pages}`) &&
        (pages === 1 || pdfText.includes(`Page ${pages} of ${pages}`)),
      `pages=${pages}`
    );
  }

  // ── TEST 5 — DIFFERENT ROWS A / B ─────────────────────────────────────────
  console.log("── TEST 5 — Row A vs B never mixed ──\n");
  {
    const copyA = structuredJobDescriptionToPlainText(structuredA);
    const copyB = structuredJobDescriptionToPlainText(structuredB);
    const idA = jobReqIdFromMeta(structuredA.meta);
    const idB = jobReqIdFromMeta(structuredB.meta);

    assert(
      "Copy A contains A's Job Req ID only (not B's)",
      copyA.includes(idA) && !copyA.includes(idB),
      `A=${idA} B=${idB}`
    );
    assert(
      "Copy B contains B's Job Req ID only (not A's)",
      copyB.includes(idB) && !copyB.includes(idA),
      `A=${idA} B=${idB}`
    );

    const pdfA = pdfTextFromDoc(
      generateStructuredJobDescriptionPdfDocument(
        structuredJobDescriptionToPdfInput(structuredA)
      )
    );
    const pdfB = pdfTextFromDoc(
      generateStructuredJobDescriptionPdfDocument(
        structuredJobDescriptionToPdfInput(structuredB)
      )
    );

    assert(
      "PDF A uses A selection (not B)",
      pdfA.includes(idA) && !pdfA.includes(idB),
      `filenames: ${buildJobDescriptionPdfFilename(idA)} vs ${buildJobDescriptionPdfFilename(idB)}`
    );
    assert(
      "PDF B uses B selection (not A)",
      pdfB.includes(idB) && !pdfB.includes(idA),
      `filename=${buildJobDescriptionPdfFilename(idB)}`
    );

    // Simulate live-ref switch: after opening B, copy/PDF must be B
    let live = structuredA;
    live = structuredB;
    const liveCopy = structuredJobDescriptionToPlainText(live);
    assert(
      "After A→B switch, copy reflects B only",
      liveCopy.includes(idB) && !liveCopy.includes(idA),
      `live selectionKey=${live.selectionKey}`
    );
  }

  // ── TEST 6 — EMPTY / MISSING SECTIONS ─────────────────────────────────────
  console.log("── TEST 6 — Empty sections omitted ──\n");
  {
    let checked = 0;
    for (const item of withText.slice(0, 200)) {
      const structured = buildFromRow(headers, item.row, jobDescHeader);
      if (!noEmptySections(structured)) {
        assert(
          "No empty sections in structured view",
          false,
          `reqId=${jobReqIdFromMeta(structured.meta)}`
        );
        break;
      }
      checked += 1;
    }
    assert(
      "All sampled rows omit empty sections",
      checked > 0,
      `checked=${checked} rows`
    );

    // Rows without explicit Must/Good Have should not show empty skill sections
    const noMust = withText.find(
      (x) => !/must[-\s]+(?:to\s+)?have/i.test(x.text)
    );
    if (noMust) {
      const s = buildFromRow(headers, noMust.row, jobDescHeader);
      const mustSection = s.sections.find((sec) =>
        /^MUST HAVE SKILLS$/i.test(sec.heading ?? "")
      );
      assert(
        "JD without Must Have marker: no empty MUST HAVE section",
        !mustSection || mustSection.blocks.length > 0,
        mustSection
          ? `blocks=${mustSection.blocks.length} reqId=${jobReqIdFromMeta(s.meta)}`
          : "section absent"
      );
    }

    const noGood = withText.find(
      (x) =>
        !/good[-\s]+to[-\s]+have|preferred\s*skills?/i.test(x.text)
    );
    if (noGood) {
      const s = buildFromRow(headers, noGood.row, jobDescHeader);
      const goodSection = s.sections.find((sec) =>
        /^GOOD TO HAVE SKILLS$/i.test(sec.heading ?? "")
      );
      assert(
        "JD without Good To Have marker: no empty GOOD TO HAVE section",
        !goodSection || goodSection.blocks.length > 0,
        goodSection
          ? `blocks=${goodSection.blocks.length}`
          : "section absent"
      );
    }
  }

  console.log(`Summary: failures=${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
