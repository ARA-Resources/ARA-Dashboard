/**
 * ONE-TIME initial import: Candidate Master Data (.xlsx) → PostgreSQL
 * `candidate_master` (migration 012).
 *
 * Usage:
 *   npx tsx scripts/import-candidate-master-to-postgres.ts [--dry-run]
 *   npm run db:import-candidate-master
 *
 * Optional env:
 *   ARA_CANDIDATE_MASTER_BACKFILL_PATH — absolute path to the source .xlsx
 *
 * Fully standalone: reads only "ATCI Candidate Master Data.xlsx" (sheet
 * "ATCI"), writes only to `candidate_master`. Does not import/touch/share
 * any utility code with the lateral_master or executive_master pipelines.
 *
 * Scope:
 *  - 14 columns kept: every source column except "SNo", stopping at (and
 *    including) "Remarks - Status". Everything after that (Resubmission
 *    Date onward) is dropped.
 *  - Sr. No. is NOT stored — the UI computes it client-side from row
 *    position.
 *  - Job Requisition ID is imported as the literal "-" for every row (the
 *    source column is 100% blank).
 *  - Every other blank cell — including every cell of a fully blank source
 *    row — is imported as the literal "-", not SQL NULL. This is an
 *    intentional, explicit choice for this table.
 *  - date_of_upload / submitted_date are stored as free TEXT, not
 *    DATE. Genuine Excel date-serial/date cells are reformatted to
 *    DD/MM/YYYY text. A short, explicit list of known-bad source values is
 *    corrected to a literal override value (see DATE_OF_UPLOAD_OVERRIDES /
 *    SUBMITTED_DATE_TRACKER_OVERRIDES below) — every other malformed value
 *    is preserved verbatim as text, not guessed at.
 *  - Contact Number (and any other column where Excel auto-typed a long
 *    digit string as a number, e.g. scientific notation on screen) is
 *    converted back to a plain decimal digit string from the underlying
 *    numeric value — never the scientific-notation display string.
 *  - Aborts if `candidate_master` already has rows (no overwrite).
 */

import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import postgres from "postgres";
import type { CandidateMasterSheetDbColumn } from "../src/services/persistence/candidate-master-sheet-columns";

/**
 * This script's own snapshot of the original legacy workbook's header
 * spellings — deliberately NOT imported from candidate-master-sheet-columns.ts,
 * whose `CANDIDATE_MASTER_EXCEL_HEADERS`/`_COLUMN_MAP` are the live
 * dashboard's display shape and will keep evolving (see that file's C1
 * doc comment). This script already ran once against prod and is frozen
 * (aborts if `candidate_master` is non-empty, below); decoupling from the
 * live map means a future dashboard column redesign can never change this
 * historical script's typecheck or (hypothetical re-run) behavior.
 */
const LEGACY_IMPORT_COLUMN_ALIASES: ReadonlyArray<{
  dbColumn: CandidateMasterSheetDbColumn;
  importAliases: readonly string[];
}> = [
  { dbColumn: "cid", importAliases: ["CID"] },
  { dbColumn: "name", importAliases: ["Name"] },
  { dbColumn: "gender", importAliases: ["Diversity"] },
  { dbColumn: "contact_number", importAliases: ["Contact Number"] },
  { dbColumn: "date_of_upload", importAliases: ["Date of Upload"] },
  { dbColumn: "submitter", importAliases: ["Recruiter"] },
  {
    dbColumn: "customer",
    importAliases: ["ATCI - Vertical", "ATCI-Vertical", "ATCI Vertical"],
  },
  { dbColumn: "job_requisition_id", importAliases: ["Job Requisition ID"] },
  { dbColumn: "primary_skills", importAliases: ["Role Name/Primary Skill"] },
  {
    dbColumn: "job_management_level",
    importAliases: [
      "Management Level /Career Level",
      "Management Level/Career Level",
    ],
  },
  { dbColumn: "market", importAliases: ["Market"] },
  {
    dbColumn: "submitted_date",
    importAliases: [
      "Submitted Date - Tracker (dd/mm/yyyy)",
      "Submitted Date - Tracker",
    ],
  },
  { dbColumn: "status", importAliases: ["Status (Recruiter)"] },
  { dbColumn: "submission_comments", importAliases: ["Remarks - Status"] },
];

const SHEET_NAME = "ATCI";
const NBSP_RE = / /g;

/**
 * Explicit row-level corrections for known-bad "Date of Upload" values,
 * keyed by source Excel row number (row 1 = header). Every other value in
 * this column is either a genuine date (reformatted to DD/MM/YYYY) or, if
 * unparseable and not listed here, preserved verbatim as text.
 */
const DATE_OF_UPLOAD_OVERRIDES: Record<number, string> = {
  8317: "11/07/2026",
  8318: "11/07/2026",
  8319: "11/07/2026",
  8320: "11/07/2026",
  8321: "11/07/2026",
  8322: "11/07/2026",
  8323: "11/07/2026",
  8324: "11/07/2026",
  8325: "11/07/2026",
  8326: "12/06/2026",
  8482: "21/07/2026",
  9825: "11/08/2026",
  9826: "11/08/2026",
  10316: "21/08/2026",
};

/**
 * Explicit row-level corrections for known-bad "Submitted Date - Tracker"
 * values. Row 3154 ("C") is deliberately NOT listed — it must be preserved
 * as the literal text "C", not corrected or guessed at.
 */
const SUBMITTED_DATE_TRACKER_OVERRIDES: Record<number, string> = {
  245: "15/07/2025",
  1359: "24/09/2025",
  1388: "29/09/2025",
  1624: "13/10/2025",
  1893: "29/10/2025",
  1927: "29/10/2025",
  3471: "29/01/2026",
};

const CANDIDATE_PATHS = [
  process.env.ARA_CANDIDATE_MASTER_BACKFILL_PATH?.trim() || "",
  path.join(process.cwd(), "data", "excel", "ATCI Candidate Master Data.xlsx"),
].filter(Boolean);

async function loadEnvLocal() {
  const envLocalPath = path.join(process.cwd(), ".env.local");
  try {
    const content = await fs.readFile(envLocalPath, "utf8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 1) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      if (key && !(key in process.env)) process.env[key] = val;
    }
  } catch {
    // optional
  }
}

function resolveSourcePath():
  | { ok: true; path: string }
  | { ok: false; searched: string[] } {
  const searched: string[] = [];
  for (const candidate of CANDIDATE_PATHS) {
    const resolved = path.resolve(candidate);
    searched.push(resolved);
    if (existsSync(resolved)) return { ok: true, path: resolved };
  }
  return { ok: false, searched };
}

function getDb() {
  const url = process.env.POSTGRES_URL?.trim();
  if (!url) {
    throw new Error(
      "POSTGRES_URL is not set. Provide it in the environment or .env.local."
    );
  }
  return postgres(url, {
    max: 1,
    connect_timeout: 15,
    idle_timeout: 20,
    prepare: false,
    ssl: url.includes("localhost") || url.includes("127.0.0.1") ? false : "require",
  });
}

/** Like ExcelJS's raw CellValue, but keeps Date instances as Date (callers decide formatting). */
function cellToPrimitiveKeepDate(value: ExcelJS.CellValue): unknown {
  if (value === null || value === undefined) return null;
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (value instanceof Date) return value;
  if (typeof value === "object") {
    const anyVal = value as {
      text?: string;
      result?: unknown;
      richText?: Array<{ text?: string }>;
      error?: string;
    };
    if (Array.isArray(anyVal.richText)) {
      return anyVal.richText.map((part) => part.text ?? "").join("");
    }
    if (anyVal.error !== undefined) return String(anyVal.error);
    if (anyVal.result !== undefined && anyVal.result !== null) {
      const r = anyVal.result;
      if (
        typeof r === "string" ||
        typeof r === "number" ||
        typeof r === "boolean" ||
        r instanceof Date
      ) {
        return r;
      }
      return String(r);
    }
    if (typeof anyVal.text === "string") return anyVal.text;
    return null;
  }
  return String(value);
}

interface ExtractedSheet {
  headers: string[];
  /** 0-based index into `rows` → Excel row number (header is row 1, so rows[0] is Excel row 2). */
  rows: { excelRow: number; cells: unknown[] }[];
}

async function extractAtciSheet(sourcePath: string): Promise<ExtractedSheet> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(sourcePath);
  const sheet =
    workbook.worksheets.find(
      (item) => item.name.trim().toLowerCase() === SHEET_NAME.toLowerCase()
    ) ?? null;
  if (!sheet) {
    const available = workbook.worksheets.map((item) => item.name).join(", ");
    throw new Error(`Sheet "${SHEET_NAME}" not found. Available: ${available || "(none)"}`);
  }

  const colCount = Math.max(sheet.columnCount || 0, 19);
  let headers: string[] = [];
  const rows: { excelRow: number; cells: unknown[] }[] = [];

  sheet.eachRow({ includeEmpty: true }, (row) => {
    const values: unknown[] = [];
    for (let col = 1; col <= colCount; col += 1) {
      values.push(cellToPrimitiveKeepDate(row.getCell(col).value));
    }
    if (row.number === 1) {
      headers = values.map((cell) =>
        cell === null || cell === undefined ? "" : String(cell).replace(NBSP_RE, " ").trim()
      );
    } else {
      rows.push({ excelRow: row.number, cells: values });
    }
  });

  if (headers.length === 0) throw new Error("ATCI sheet has no header row.");
  return { headers, rows };
}

function normalizeHeaderLocal(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

interface HeaderMapping {
  index: Partial<Record<CandidateMasterSheetDbColumn, number>>;
  matchedHeader: Partial<Record<CandidateMasterSheetDbColumn, string>>;
}

function mapHeaders(sourceHeaders: string[]):
  | { ok: true; mapping: HeaderMapping }
  | { ok: false; message: string } {
  const headers = sourceHeaders.map((h) => String(h ?? "").trim());
  const index: HeaderMapping["index"] = {};
  const matchedHeader: HeaderMapping["matchedHeader"] = {};
  const claimed = new Set<number>();
  const missing: CandidateMasterSheetDbColumn[] = [];
  const ambiguous: string[] = [];

  for (const entry of LEGACY_IMPORT_COLUMN_ALIASES) {
    const aliases = entry.importAliases;
    const matches: Array<{ i: number; header: string }> = [];

    for (const alias of aliases) {
      headers.forEach((header, i) => {
        if (header === alias) matches.push({ i, header });
      });
    }
    if (matches.length === 0) {
      for (const alias of aliases) {
        const lower = alias.toLowerCase();
        headers.forEach((header, i) => {
          if (header.toLowerCase() === lower) matches.push({ i, header });
        });
      }
    }
    if (matches.length === 0) {
      for (const alias of aliases) {
        const norm = normalizeHeaderLocal(alias);
        headers.forEach((header, i) => {
          if (normalizeHeaderLocal(header) === norm) matches.push({ i, header });
        });
      }
    }

    const unique = new Map<number, string>();
    for (const m of matches) unique.set(m.i, m.header);

    if (unique.size === 0) {
      missing.push(entry.dbColumn);
      continue;
    }
    if (unique.size > 1) {
      ambiguous.push(`${entry.dbColumn} → [${[...unique.values()].join(" | ")}]`);
      continue;
    }
    const [[i, header]] = unique.entries();
    if (claimed.has(i)) {
      ambiguous.push(`${entry.dbColumn} → column ${i + 1} already claimed`);
      continue;
    }
    claimed.add(i);
    index[entry.dbColumn] = i;
    matchedHeader[entry.dbColumn] = header;
  }

  if (missing.length > 0 || ambiguous.length > 0) {
    return {
      ok: false,
      message: [
        "Candidate Master header mapping failed. Import stopped.",
        missing.length ? `Missing: ${missing.join(", ")}` : "",
        ambiguous.length ? `Ambiguous: ${ambiguous.join("; ")}` : "",
        `Source headers: ${headers.filter(Boolean).join(" | ")}`,
      ]
        .filter(Boolean)
        .join("\n"),
    };
  }

  return { ok: true, mapping: { index, matchedHeader } };
}

function cellIsEmpty(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === "string" && v.trim() === "");
}

function numberCellToText(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return String(Math.round(value));
}

/** Generic text column: number → plain digit string, string → trimmed, blank → "-". */
function genericCellToText(raw: unknown): string {
  if (cellIsEmpty(raw)) return "-";
  if (typeof raw === "number") {
    return Number.isFinite(raw) ? numberCellToText(raw) : "-";
  }
  if (raw instanceof Date) {
    // Shouldn't occur in a non-date column, but stay safe rather than throw.
    return raw.toISOString();
  }
  const text = String(raw).replace(NBSP_RE, " ").trim();
  return text === "" ? "-" : text;
}

function formatDateUTC(d: Date): string {
  const day = String(d.getUTCDate()).padStart(2, "0");
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const year = d.getUTCFullYear();
  return `${day}/${month}/${year}`;
}

function excelSerialToDate(serial: number): Date {
  return new Date(Date.UTC(1899, 11, 30) + serial * 86400000);
}

interface DateCellResult {
  text: string;
  /** true if the raw cell held a numeric-typed value (serial/garbage number), for reporting. */
  wasNumeric: boolean;
  overrideApplied: boolean;
}

function dateCellToText(
  overrides: Record<number, string>,
  excelRow: number,
  raw: unknown
): DateCellResult {
  const override = overrides[excelRow];
  if (override !== undefined) {
    return { text: override, wasNumeric: typeof raw === "number", overrideApplied: true };
  }

  if (cellIsEmpty(raw)) return { text: "-", wasNumeric: false, overrideApplied: false };

  if (raw instanceof Date) {
    if (Number.isNaN(raw.getTime())) return { text: "-", wasNumeric: false, overrideApplied: false };
    return { text: formatDateUTC(raw), wasNumeric: false, overrideApplied: false };
  }

  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) return { text: "-", wasNumeric: true, overrideApplied: false };
    const d = excelSerialToDate(raw);
    if (Number.isNaN(d.getTime())) return { text: "-", wasNumeric: true, overrideApplied: false };
    return { text: formatDateUTC(d), wasNumeric: true, overrideApplied: false };
  }

  const text = String(raw).replace(NBSP_RE, " ").trim();
  return { text: text === "" ? "-" : text, wasNumeric: false, overrideApplied: false };
}

interface BuiltRow {
  excelRow: number;
  cid: string;
  name: string;
  gender: string;
  contact_number: string;
  date_of_upload: string;
  submitter: string;
  customer: string;
  job_requisition_id: string;
  primary_skills: string;
  job_management_level: string;
  market: string;
  submitted_date: string;
  status: string;
  submission_comments: string;
}

interface ValidationResult {
  rows: BuiltRow[];
  totalDataRows: number;
  fullyBlankRows: number;
  contactNumberNumericCells: number;
  dateOfUploadOverridesApplied: number;
  submittedDateTrackerOverridesApplied: number;
}

function validateAndBuild(
  rawRows: ExtractedSheet["rows"],
  mapping: HeaderMapping
): ValidationResult {
  const idx = mapping.index;
  const rows: BuiltRow[] = [];
  let fullyBlankRows = 0;
  let contactNumberNumericCells = 0;
  let dateOfUploadOverridesApplied = 0;
  let submittedDateTrackerOverridesApplied = 0;

  const cell = (cells: unknown[], col: CandidateMasterSheetDbColumn) => {
    const i = idx[col];
    return i === undefined ? null : cells[i];
  };

  for (const { excelRow, cells } of rawRows) {
    if (cells.every((c) => cellIsEmpty(c))) fullyBlankRows += 1;

    const contactRaw = cell(cells, "contact_number");
    if (typeof contactRaw === "number") contactNumberNumericCells += 1;

    const dateOfUpload = dateCellToText(
      DATE_OF_UPLOAD_OVERRIDES,
      excelRow,
      cell(cells, "date_of_upload")
    );
    if (dateOfUpload.overrideApplied) dateOfUploadOverridesApplied += 1;

    const submittedDateTracker = dateCellToText(
      SUBMITTED_DATE_TRACKER_OVERRIDES,
      excelRow,
      cell(cells, "submitted_date")
    );
    if (submittedDateTracker.overrideApplied) submittedDateTrackerOverridesApplied += 1;

    rows.push({
      excelRow,
      cid: genericCellToText(cell(cells, "cid")),
      name: genericCellToText(cell(cells, "name")),
      gender: genericCellToText(cell(cells, "gender")),
      contact_number: genericCellToText(contactRaw),
      date_of_upload: dateOfUpload.text,
      submitter: genericCellToText(cell(cells, "submitter")),
      customer: genericCellToText(cell(cells, "customer")),
      job_requisition_id: "-",
      primary_skills: genericCellToText(cell(cells, "primary_skills")),
      job_management_level: genericCellToText(cell(cells, "job_management_level")),
      market: genericCellToText(cell(cells, "market")),
      submitted_date: submittedDateTracker.text,
      status: genericCellToText(cell(cells, "status")),
      submission_comments: genericCellToText(cell(cells, "submission_comments")),
    });
  }

  return {
    rows,
    totalDataRows: rawRows.length,
    fullyBlankRows,
    contactNumberNumericCells,
    dateOfUploadOverridesApplied,
    submittedDateTrackerOverridesApplied,
  };
}

/** Spot-checks printed in every run (dry-run and real) so the row-level corrections are always visible. */
const SPOT_CHECKS: Array<{ excelRow: number; column: keyof BuiltRow; expected: string }> = [
  ...Object.entries(DATE_OF_UPLOAD_OVERRIDES).map(([row, expected]) => ({
    excelRow: Number(row),
    column: "date_of_upload" as const,
    expected,
  })),
  ...Object.entries(SUBMITTED_DATE_TRACKER_OVERRIDES).map(([row, expected]) => ({
    excelRow: Number(row),
    column: "submitted_date" as const,
    expected,
  })),
  { excelRow: 3154, column: "submitted_date", expected: "C" },
];

function printSpotChecks(rows: BuiltRow[]) {
  const byExcelRow = new Map(rows.map((r) => [r.excelRow, r]));
  console.log("\n-- Row-level date correction spot-checks --");
  let failures = 0;
  for (const check of SPOT_CHECKS) {
    const row = byExcelRow.get(check.excelRow);
    const actual = row ? String(row[check.column]) : "(row not found)";
    const pass = actual === check.expected;
    if (!pass) failures += 1;
    console.log(
      `  row ${check.excelRow} [${check.column}]: expected "${check.expected}" → actual "${actual}" ${pass ? "PASS" : "FAIL"}`
    );
  }
  if (failures > 0) {
    console.error(`\n${failures} spot-check(s) FAILED. Import stopped.`);
    process.exit(1);
  }
}

async function main() {
  await loadEnvLocal();
  const dryRun = process.argv.includes("--dry-run");
  const importTimestamp = new Date();

  const resolved = resolveSourcePath();
  if (!resolved.ok) {
    console.error(
      [
        "Source workbook not found. Import stopped.",
        "Searched:",
        ...resolved.searched.map((p) => `  - ${p}`),
        "Set ARA_CANDIDATE_MASTER_BACKFILL_PATH to the absolute .xlsx path.",
      ].join("\n")
    );
    process.exit(1);
  }

  const sourcePath = resolved.path;
  console.log(`[import-candidate-master] Source: ${sourcePath}`);

  const extracted = await extractAtciSheet(sourcePath);
  const mapped = mapHeaders(extracted.headers);
  if (!mapped.ok) {
    console.error(mapped.message);
    process.exit(1);
  }
  console.log(
    `[import-candidate-master] Header mapping OK. Matched: ${Object.values(
      mapped.mapping.matchedHeader
    ).join(" | ")}`
  );

  const validated = validateAndBuild(extracted.rows, mapped.mapping);

  console.log("\n========== CANDIDATE MASTER → POSTGRES IMPORT ==========");
  console.log(`Source data rows:                      ${validated.totalDataRows}`);
  console.log(`Fully blank rows (imported as "-" row): ${validated.fullyBlankRows}`);
  console.log(`Contact Number numeric-cell reformats:  ${validated.contactNumberNumericCells}`);
  console.log(`Date of Upload row-overrides applied:   ${validated.dateOfUploadOverridesApplied} / ${Object.keys(DATE_OF_UPLOAD_OVERRIDES).length}`);
  console.log(`Submitted Date Tracker overrides applied: ${validated.submittedDateTrackerOverridesApplied} / ${Object.keys(SUBMITTED_DATE_TRACKER_OVERRIDES).length}`);

  printSpotChecks(validated.rows);

  if (dryRun) {
    console.log(`\nDry run OK — would insert ${validated.rows.length} rows. No DB writes.`);
    for (const sample of validated.rows.slice(0, 3)) {
      console.log("Sample:", {
        excelRow: sample.excelRow,
        cid: sample.cid,
        name: sample.name,
        contact_number: sample.contact_number,
        date_of_upload: sample.date_of_upload,
        job_requisition_id: sample.job_requisition_id,
      });
    }
    console.log("=======================================================\n");
    return;
  }

  const sql = getDb();
  try {
    const existing = Number(
      (await sql<{ c: string }[]>`SELECT COUNT(*)::text AS c FROM candidate_master`)[0]?.c ?? "0"
    );
    if (existing > 0) {
      console.error(
        [
          "",
          `candidate_master already has ${existing} row(s).`,
          "This one-time import does NOT overwrite existing rows. Import stopped.",
        ].join("\n")
      );
      process.exit(1);
    }

    await sql.begin(async (tx) => {
      const BATCH = 500;
      for (let i = 0; i < validated.rows.length; i += BATCH) {
        const batch = validated.rows.slice(i, i + BATCH).map((r) => ({
          cid: r.cid,
          name: r.name,
          gender: r.gender,
          contact_number: r.contact_number,
          date_of_upload: r.date_of_upload,
          submitter: r.submitter,
          customer: r.customer,
          job_requisition_id: r.job_requisition_id,
          primary_skills: r.primary_skills,
          job_management_level: r.job_management_level,
          market: r.market,
          submitted_date: r.submitted_date,
          status: r.status,
          submission_comments: r.submission_comments,
          created_at: importTimestamp,
          updated_at: importTimestamp,
        }));
        await tx`INSERT INTO candidate_master ${tx(batch)}`;
      }
    });

    const finalCount = Number(
      (await sql<{ c: string }[]>`SELECT COUNT(*)::text AS c FROM candidate_master`)[0]?.c ?? "0"
    );

    console.log("\n-- Database --");
    console.log(`Inserted:              ${validated.rows.length}`);
    console.log(`Final candidate_master: ${finalCount}`);
    console.log("=======================================================\n");

    if (finalCount !== validated.rows.length) {
      console.error(`WARNING: final count ${finalCount} != inserted ${validated.rows.length}`);
      process.exitCode = 1;
    }
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
