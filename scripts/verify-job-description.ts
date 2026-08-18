/**
 * Job Description functionality verification against live Master Sheet data.
 * Read-only — never writes to Excel.
 *
 * Run: npx tsx scripts/verify-job-description.ts
 */

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  extractJobDescriptionMeta,
  formatJobDescriptionBlocks,
  parseSkillChipItems,
  type FormattedBlock,
} from "../src/utils/format-job-description";

const execFileAsync = promisify(execFile);

type RowRecord = Record<string, string | number | null>;

interface CaseResult {
  name: string;
  pass: boolean;
  detail: string;
}

const results: CaseResult[] = [];

function pass(name: string, detail: string) {
  results.push({ name, pass: true, detail });
}

function fail(name: string, detail: string) {
  results.push({ name, pass: false, detail });
}

function assert(name: string, condition: boolean, detail: string) {
  if (condition) pass(name, detail);
  else fail(name, detail);
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value);
}

/** Reconstruct visible text from blocks (rough content check — no summarization). */
function blocksContainOriginalSkills(blocks: FormattedBlock[], originals: string[]) {
  const joined = blocks
    .map((b) => {
      if (b.type === "paragraph" || b.type === "bullet" || b.type === "heading")
        return b.text;
      if (b.type === "number") return b.text;
      if (b.type === "skillChips") return b.skills.join(" ");
      return "";
    })
    .join(" ")
    .toLowerCase();

  return originals.every((skill) =>
    joined.includes(skill.toLowerCase().trim())
  );
}

function significantTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9+#.\s-]/gi, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 4);
}

/** Ensure formatting did not drop meaningful original tokens (format ≠ summarize). */
function preservesContent(original: string, blocks: FormattedBlock[]): {
  ok: boolean;
  missing: string[];
  coverage: number;
} {
  const rendered = blocks
    .map((b) => {
      if (b.type === "paragraph" || b.type === "bullet" || b.type === "heading")
        return b.text;
      if (b.type === "number") return `${b.index} ${b.text}`;
      if (b.type === "skillChips") return b.skills.join(" ");
      return "";
    })
    .join("\n");

  // Section labels are normalized into headings (e.g. "Educational Qualification" → EDUCATION).
  // Strip common label phrasing from the original before comparing body tokens.
  const originalWithoutLabels = original
    .replace(
      /(?:project\s*role\s*description|role\s*description|key\s*responsibilities|roles?\s*&\s*responsibilities|responsibilities|must\s*(?:to\s*)?have\s*skills?|good\s*(?:to\s*)?have\s*skills?|required\s*skills?|preferred\s*skills?|professional\s*(?:&|and)\s*technical\s*skills|technical\s*skills|other\s*requirements?|additional\s*information|notice\s*period|educational\s*qualification|technical\s*experience|professional\s*attributes|project\s*role|job\s*requirements?|summary|location|education|experience)\s*[:\-–—]?/gi,
      " "
    );

  const originalTokens = significantTokens(originalWithoutLabels);
  const renderedTokens = new Set(significantTokens(rendered));
  const missing = originalTokens.filter((t) => !renderedTokens.has(t));
  const coverage =
    originalTokens.length === 0
      ? 1
      : (originalTokens.length - missing.length) / originalTokens.length;

  return {
    ok: coverage >= 0.95,
    missing: missing.slice(0, 12),
    coverage,
  };
}

function findCurrentLateralFile(): string {
  const dir = path.join(
    process.cwd(),
    ".data",
    "datasets",
    "current",
    "Lateral"
  );
  if (!fs.existsSync(dir)) {
    throw new Error(`Dataset Manager Lateral folder missing: ${dir}`);
  }
  const files = fs
    .readdirSync(dir)
    .filter((f) => /\.(xlsx|xlsm|xls)$/i.test(f))
    .map((f) => path.join(dir, f));
  if (files.length === 0) {
    throw new Error("No Excel file in Dataset Manager current/Lateral");
  }
  // Prefer newest by mtime
  files.sort(
    (a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs
  );
  return files[0];
}

async function loadMasterSheet(filePath: string): Promise<{
  headers: string[];
  rows: RowRecord[];
  jobDescHeader: string;
  jobIdHeader: string | null;
}> {
  // Read-only extract via openpyxl (ExcelJS cannot reliably open .xlsm).
  const outJson = path.join(
    process.cwd(),
    ".data",
    "temp",
    `jd-samples-${Date.now()}.json`
  );
  await fs.promises.mkdir(path.dirname(outJson), { recursive: true });

  const extractScript = path.join(
    process.cwd(),
    "scripts",
    "extract-jd-samples.py"
  );
  await execFileAsync("python", [extractScript, filePath, outJson], {
    windowsHide: true,
    timeout: 300_000,
    maxBuffer: 64 * 1024 * 1024,
  });

  const raw = JSON.parse(await fs.promises.readFile(outJson, "utf8")) as {
    headers: string[];
    jobDescriptionHeader: string;
    rows: RowRecord[];
  };
  await fs.promises.unlink(outJson).catch(() => undefined);

  const headers = raw.headers;
  const jobDescHeader = raw.jobDescriptionHeader;
  const jobIdHeader =
    headers.find((h) => /job\s*requisition\s*id/i.test(h)) || null;

  return {
    headers,
    rows: raw.rows,
    jobDescHeader,
    jobIdHeader,
  };
}

function pickRows(
  rows: RowRecord[],
  jobDescHeader: string
): Record<string, RowRecord | null> {
  const withText = rows
    .map((r) => ({ row: r, text: cellText(r[jobDescHeader]).trim() }))
    .filter((x) => x.text.length > 0);

  const empty =
    rows.find((r) => !cellText(r[jobDescHeader]).trim()) ?? null;

  // Master Sheet JDs are typically long; treat the shortest real sample as "short".
  const short =
    [...withText].sort((a, b) => a.text.length - b.text.length)[0]?.row ?? null;

  const long =
    [...withText].sort((a, b) => b.text.length - a.text.length)[0]?.row ?? null;

  const multiPara =
    withText.find((x) => (x.text.match(/\n/g) || []).length >= 2)?.row ?? null;

  const mustHave =
    withText.find((x) => /must\s*(?:to\s*)?have\s*skills?/i.test(x.text))
      ?.row ?? null;

  const goodHave =
    withText.find((x) => /good\s*(?:to\s*)?have\s*skills?/i.test(x.text))
      ?.row ?? null;

  const bullets =
    withText.find((x) => /(?:^|\n)\s*[•·▪\-–—*]\s+/m.test(x.text))?.row ??
    null;

  const numbered =
    withText.find((x) => /(?:^|\n)\s*\d+[.)]\s+/m.test(x.text))?.row ?? null;

  const special =
    withText.find((x) => /[&<>"'`@#$%^*_~\\/]|[^\x00-\x7F]/.test(x.text))
      ?.row ?? null;

  const veryLarge =
    withText.find((x) => x.text.length > 2500)?.row ?? long;

  return {
    short,
    long,
    multiPara,
    mustHave,
    goodHave,
    bullets,
    numbered,
    empty,
    special,
    veryLarge,
  };
}

async function main() {
  console.log("=== Job Description verification (read-only) ===\n");

  const filePath = findCurrentLateralFile();
  console.log(`Source file: ${filePath}`);
  const { headers, rows, jobDescHeader, jobIdHeader } =
    await loadMasterSheet(filePath);
  console.log(
    `Master Sheet rows: ${rows.length} | JD column: "${jobDescHeader}" | Job ID: ${jobIdHeader ?? "(missing)"}\n`
  );

  assert(
    "Master Sheet has Job Description column",
    Boolean(jobDescHeader),
    jobDescHeader
  );
  assert(
    "Master Sheet has multiple rows",
    rows.length >= 5,
    `${rows.length} rows`
  );

  const picks = pickRows(rows, jobDescHeader);

  // 1 Short (shortest JD in this Master Sheet — none are under ~200 chars)
  if (picks.short) {
    const text = cellText(picks.short[jobDescHeader]);
    const blocks = formatJobDescriptionBlocks(text);
    const check = preservesContent(text, blocks);
    assert(
      "1. Short Job Description — full content preserved",
      check.ok && text.length > 0,
      `len=${text.length} (shortest in sheet), coverage=${(check.coverage * 100).toFixed(1)}%`
    );
  } else {
    fail("1. Short Job Description", "No short JD sample found in Master Sheet");
  }

  // 2 Very long / 10 Very large
  if (picks.long) {
    const text = cellText(picks.long[jobDescHeader]);
    const blocks = formatJobDescriptionBlocks(text);
    const check = preservesContent(text, blocks);
    assert(
      "2. Very long Job Description — full content preserved",
      check.ok && text.length > 200,
      `len=${text.length}, coverage=${(check.coverage * 100).toFixed(1)}%, missing=${check.missing.join(",") || "none"}`
    );
  } else {
    fail("2. Very long Job Description", "No long JD sample found");
  }

  // 3 Multiple paragraphs
  if (picks.multiPara) {
    const text = cellText(picks.multiPara[jobDescHeader]);
    const blocks = formatJobDescriptionBlocks(text);
    const paras = blocks.filter((b) => b.type === "paragraph" || b.type === "blank");
    const check = preservesContent(text, blocks);
    assert(
      "3. Multi-paragraph Job Description",
      check.ok && (text.match(/\n/g) || []).length >= 2,
      `newlines=${(text.match(/\n/g) || []).length}, blocks=${blocks.length}, para-ish=${paras.length}`
    );
  } else {
    // Synthetic fallback still validates formatter (does not invent Excel data — marks as synthetic)
    const synthetic =
      "Summary : Line one.\n\nRoles & Responsibilities\nBuild APIs\n\nAdditional Information : Remote ok";
    const blocks = formatJobDescriptionBlocks(synthetic);
    const check = preservesContent(synthetic, blocks);
    assert(
      "3. Multi-paragraph Job Description (synthetic — none in sheet)",
      check.ok,
      `coverage=${(check.coverage * 100).toFixed(1)}%`
    );
  }

  // 4 Must Have Skills
  if (picks.mustHave) {
    const text = cellText(picks.mustHave[jobDescHeader]);
    const blocks = formatJobDescriptionBlocks(text);
    const chips = blocks.find(
      (b) => b.type === "skillChips" && b.variant === "must"
    );
    const heading = blocks.some(
      (b) => b.type === "heading" && b.text === "MUST HAVE SKILLS"
    );
    const check = preservesContent(text, blocks);
    assert(
      "4. Must Have Skills — separate section + original wording",
      heading && check.ok,
      chips && chips.type === "skillChips"
        ? `chips=${chips.skills.length} [${chips.skills.slice(0, 5).join(", ")}]`
        : `no chips (fell back to original text), coverage=${(check.coverage * 100).toFixed(1)}%`
    );
  } else {
    fail("4. Must Have Skills", "No Must Have Skills sample in Master Sheet");
  }

  // 5 Good to Have Skills
  if (picks.goodHave) {
    const text = cellText(picks.goodHave[jobDescHeader]);
    const blocks = formatJobDescriptionBlocks(text);
    const chips = blocks.find(
      (b) => b.type === "skillChips" && b.variant === "good"
    );
    const heading = blocks.some(
      (b) => b.type === "heading" && b.text === "GOOD TO HAVE SKILLS"
    );
    const check = preservesContent(text, blocks);
    // Prefer a sample that confidently chips; otherwise original-text fallback is valid.
    const chipOk =
      !chips ||
      (chips.type === "skillChips" &&
        chips.skills.every((s) => text.toLowerCase().includes(s.toLowerCase())));
    assert(
      "5. Good to Have Skills — separate section + original wording",
      heading && check.ok && chipOk,
      chips && chips.type === "skillChips"
        ? `chips=${chips.skills.length} [${chips.skills.slice(0, 5).join(", ")}]`
        : `no chips (fell back to original text), coverage=${(check.coverage * 100).toFixed(1)}%`
    );
  } else {
    fail("5. Good to Have Skills", "No Good to Have Skills sample in Master Sheet");
  }

  // 6 Bullets
  if (picks.bullets) {
    const text = cellText(picks.bullets[jobDescHeader]);
    const blocks = formatJobDescriptionBlocks(text);
    const hasBullet = blocks.some((b) => b.type === "bullet");
    const check = preservesContent(text, blocks);
    assert(
      "6. Bullet points preserved/rendered",
      check.ok && (hasBullet || /[•·▪\-–—]/.test(text)),
      `bulletBlocks=${blocks.filter((b) => b.type === "bullet").length}`
    );
  } else {
    const synthetic = "Key Responsibilities\n• Own delivery\n• Review PRs\n- Mentor juniors";
    const blocks = formatJobDescriptionBlocks(synthetic);
    assert(
      "6. Bullet points (synthetic — none in sheet)",
      blocks.filter((b) => b.type === "bullet").length >= 2,
      `bullets=${blocks.filter((b) => b.type === "bullet").length}`
    );
  }

  // 7 Numbered
  if (picks.numbered) {
    const text = cellText(picks.numbered[jobDescHeader]);
    const blocks = formatJobDescriptionBlocks(text);
    const nums = blocks.filter((b) => b.type === "number");
    const check = preservesContent(text, blocks);
    assert(
      "7. Numbered sections",
      check.ok && (nums.length > 0 || /\d+[.)]/.test(text)),
      `numberBlocks=${nums.length}`
    );
  } else {
    const synthetic = "Responsibilities\n1. Design services\n2. Write tests\n3. Support releases";
    const blocks = formatJobDescriptionBlocks(synthetic);
    assert(
      "7. Numbered sections (synthetic — none in sheet)",
      blocks.filter((b) => b.type === "number").length >= 3,
      `numbers=${blocks.filter((b) => b.type === "number").length}`
    );
  }

  // 8 Empty
  {
    const blocks = formatJobDescriptionBlocks("");
    assert(
      "8. Empty Job Description — no invented content",
      blocks.length === 0,
      `blocks=${blocks.length}`
    );
    if (picks.empty) {
      const text = cellText(picks.empty[jobDescHeader]).trim();
      assert(
        "8b. Empty cell exists in Master Sheet",
        text.length === 0,
        "empty row located"
      );
    } else {
      pass("8b. Empty cell in sheet", "No empty JD row found (formatter still handles empty)");
    }
  }

  // 9 Special characters
  if (picks.special) {
    const text = cellText(picks.special[jobDescHeader]);
    const blocks = formatJobDescriptionBlocks(text);
    const check = preservesContent(text, blocks);
    assert(
      "9. Special characters preserved",
      check.ok,
      `coverage=${(check.coverage * 100).toFixed(1)}%, sample=${JSON.stringify(text.slice(0, 60))}`
    );
  } else {
    const synthetic = 'Skills: C++, C#, "Node.js" & React — 100% onsite @ HQ';
    const blocks = formatJobDescriptionBlocks(synthetic);
    const check = preservesContent(synthetic, blocks);
    assert(
      "9. Special characters (synthetic)",
      check.ok && blocksContainOriginalSkills(blocks, ["C++", "C#", "Node.js"]),
      `coverage=${(check.coverage * 100).toFixed(1)}%`
    );
  }

  // 10 Very large
  if (picks.veryLarge) {
    const text = cellText(picks.veryLarge[jobDescHeader]);
    const blocks = formatJobDescriptionBlocks(text);
    const check = preservesContent(text, blocks);
    const renderedLen = blocks
      .map((b) =>
        b.type === "skillChips"
          ? b.skills.join(" ").length
          : b.type === "blank"
            ? 0
            : "text" in b
              ? b.text.length
              : 0
      )
      .reduce((a, b) => a + b, 0);
    assert(
      "10. Very large Job Description — not truncated by formatter",
      check.ok && renderedLen > 0,
      `sourceLen=${text.length}, renderedApprox=${renderedLen}, coverage=${(check.coverage * 100).toFixed(1)}%`
    );
  } else {
    fail("10. Very large Job Description", "No large JD sample found");
  }

  // Job Req ID association
  if (jobIdHeader && picks.mustHave) {
    const meta = extractJobDescriptionMeta(headers, picks.mustHave);
    const idMeta = meta.find((m) => /job\s*requisition\s*id/i.test(m.label));
    const expected = cellText(picks.mustHave[jobIdHeader]).trim();
    assert(
      "Job Requisition ID correctly associated with selected row",
      Boolean(idMeta && idMeta.value === expected && expected.length > 0),
      `meta=${idMeta?.value ?? "(none)"} expected=${expected}`
    );
  } else {
    fail(
      "Job Requisition ID association",
      "Missing Job Requisition ID column or sample row"
    );
  }

  // Skill chip confidence fallback
  {
    const unclear = "Must Have Skills : Strong communication and ownership mindset";
    // May or may not chip — either way original body must remain if no chips
    const items = parseSkillChipItems("Strong communication and ownership mindset");
    assert(
      "Unclear skill blob does not force false chips",
      items === null,
      items === null ? "returned null → show original text" : `unexpected chips=${items.join("|")}`
    );
    const blocks = formatJobDescriptionBlocks(unclear);
    const check = preservesContent(unclear, blocks);
    assert(
      "Unclear Must Have section still preserves wording",
      check.ok,
      `coverage=${(check.coverage * 100).toFixed(1)}%`
    );
  }

  // Architecture static checks (source)
  {
    const tableSrc = fs.readFileSync(
      path.join(
        process.cwd(),
        "src/components/dashboard/accenture/lateral/lateral-master-sheet-table.tsx"
      ),
      "utf8"
    );
    const cellSrc = fs.readFileSync(
      path.join(
        process.cwd(),
        "src/components/dashboard/accenture/lateral/job-description-cell.tsx"
      ),
      "utf8"
    );
    const modalSrc = fs.readFileSync(
      path.join(
        process.cwd(),
        "src/components/dashboard/accenture/lateral/job-description-modal.tsx"
      ),
      "utf8"
    );

    const modalMounts = (tableSrc.match(/<JobDescriptionModal/g) || []).length;
    assert(
      "Single JobDescriptionModal mount in table",
      modalMounts === 1,
      `mounts=${modalMounts}`
    );
    assert(
      "Cell does not import/render modal",
      !cellSrc.includes("JobDescriptionModal"),
      "cell is open-trigger only"
    );
    assert(
      "Modal uses Base UI modal dialog (ESC / outside / X)",
      modalSrc.includes("DialogPrimitive") &&
        modalSrc.includes("modal") &&
        modalSrc.includes("DialogPrimitive.Close") &&
        modalSrc.includes("DialogPrimitive.Backdrop"),
      "dialog primitives present"
    );
    assert(
      "Table preserves scroll on modal close",
      tableSrc.includes("savedTableScrollRef") &&
        tableSrc.includes("restoreTableScroll"),
      "scroll save/restore present"
    );
    assert(
      "Opening JD builds payload from selected row only",
      tableSrc.includes("openJobDescriptionForRow") &&
        tableSrc.includes("buildJobDescriptionPayload"),
      "dynamic row payload"
    );
    assert(
      "Modal keeps original JD available",
      modalSrc.includes("Original Job Description"),
      "original collapsible present"
    );
    assert(
      "Theme tokens used (no separate theme system)",
      modalSrc.includes("bg-card") &&
        modalSrc.includes("text-primary") &&
        modalSrc.includes("text-secondary"),
      "card/primary/secondary tokens"
    );
    assert(
      "Modal centered + scrollable body",
      modalSrc.includes("top-1/2") &&
        modalSrc.includes("left-1/2") &&
        modalSrc.includes("-translate-x-1/2") &&
        modalSrc.includes("max-h-[90vh]") &&
        modalSrc.includes("overflow-y-auto"),
      "center + scroll classes"
    );
    assert(
      "Light/dark backdrop tokens present",
      modalSrc.includes("dark:bg-black/55") && modalSrc.includes("bg-card"),
      "light card + dark backdrop"
    );
    assert(
      "Table cell truncates preview",
      cellSrc.includes("truncate"),
      "truncate class on cell button"
    );
    const openHandlerSlice = tableSrc.slice(
      tableSrc.indexOf("openJobDescriptionForRow"),
      tableSrc.indexOf("handleJobDescriptionOpenChange") + 500
    );
    assert(
      "Filters/pagination props untouched by modal open/close",
      !/onPageChange\(|onPageSizeChange\(|setPage|setFilters/.test(
        openHandlerSlice
      ),
      "modal handlers do not mutate page/filters"
    );
  }

  // Sample multiple real rows end-to-end
  {
    const sample = rows
      .filter((r) => cellText(r[jobDescHeader]).trim().length > 40)
      .slice(0, 8);
    let allOk = true;
    const notes: string[] = [];
    for (const row of sample) {
      const text = cellText(row[jobDescHeader]);
      const blocks = formatJobDescriptionBlocks(text);
      const check = preservesContent(text, blocks);
      const meta = extractJobDescriptionMeta(headers, row);
      const id = meta.find((m) => /job\s*requisition\s*id/i.test(m.label))?.value;
      if (!check.ok) {
        allOk = false;
        notes.push(`FAIL coverage=${check.coverage.toFixed(2)} id=${id ?? "?"}`);
      } else {
        notes.push(`ok id=${id ?? "?"} len=${text.length}`);
      }
    }
    assert(
      `Batch: ${sample.length} Master Sheet rows preserve content + meta`,
      allOk && sample.length > 0,
      notes.join(" | ")
    );
  }

  console.log("\n=== Results ===\n");
  let failed = 0;
  for (const r of results) {
    const mark = r.pass ? "PASS" : "FAIL";
    if (!r.pass) failed += 1;
    console.log(`${mark}  ${r.name}`);
    console.log(`      ${r.detail}\n`);
  }
  console.log(
    `Summary: ${results.length - failed}/${results.length} passed, ${failed} failed`
  );
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
