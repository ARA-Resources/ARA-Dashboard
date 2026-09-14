/**
 * Upsert the CURRENT contents of `ATCI Exec Master Data Updated.xlsx` into
 * PostgreSQL `executive_master`, keyed by `job_requisition_id`.
 *
 * Unlike scripts/import-executive-master-to-postgres.ts (ONE-TIME insert,
 * aborts if the table already has rows), this script is meant to be re-run
 * whenever the xlsx is refreshed: existing JRs are updated in place, new JRs
 * are inserted. It never deletes rows and never flips a JR to Closed for
 * being absent from the file — that "absent = Closed" behavior belongs to
 * the live Gmail pipeline (executive-master-reconcile-postgres.ts), which
 * this script does not touch or duplicate.
 *
 * Usage:
 *   npx tsx scripts/upsert-executive-master-from-excel.ts [--dry-run]
 *   npm run db:upsert-executive-master -- --dry-run
 *
 * Optional env:
 *   ARA_EXECUTIVE_MASTER_UPSERT_PATH — absolute path to the source .xlsx
 *
 * Reuses the exact same header mapping (EXECUTIVE_MASTER_COLUMN_MAP.importAliases)
 * and cell/row transforms as scripts/import-executive-master-to-postgres.ts:
 * reads the "Master Sheet" tab as delivered, forces `date` to NULL (source has
 * no Date data), drops the source "Active Pipeline" column, uses the cached
 * VLOOKUP result for Priority, trims all text. That script's internals are not
 * exported, so this logic is duplicated here rather than imported — see that
 * file as the source of truth this mirrors.
 *
 * Deliberate differences from that script:
 *  - UPSERT (INSERT ... ON CONFLICT DO UPDATE) instead of a hard abort when
 *    the table already has rows.
 *  - Per-row validation failures are SKIPPED + logged, not a whole-run abort
 *    (job_status not in New/Reopen/Active/Closed, posted not in Yes/-,
 *    missing Job Requisition ID, non-"ATCI-" JR, or a duplicate JR within
 *    the file — for a duplicate, the LAST occurrence in the sheet wins and
 *    earlier ones are skipped).
 *  - On conflict (an existing JR), `date` and `last_seen_at` are
 *    deliberately left untouched — those columns are owned by the live
 *    Gmail pipeline, and blindly overwriting them here would erase its
 *    work. `date` is still forced to NULL, and `last_seen_at` to NULL, but
 *    ONLY for brand-new inserts (mirrors the original script).
 *  - `posted` is read from the sheet and still validated (Yes/-), but is
 *    NEVER written to the database — not on insert, not on update. That
 *    column stays fully owned by the Gmail reconcile pipeline ("Phase E6
 *    owns that column" per executive-master-reconcile-postgres.ts); this
 *    script only reads it to decide whether a row is otherwise valid.
 */

import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import postgres from "postgres";
import {
  EXECUTIVE_MASTER_COLUMN_MAP,
  type ExecutiveMasterSheetDbColumn,
} from "../src/services/persistence/executive-master-sheet-columns";
import { normalizeExecutivePriority } from "../src/services/executive-processing/executive-priority-normalize";
import { EXECUTIVE_ALLOWED_JOB_STATUSES } from "../src/services/executive-processing/executive-job-status-rules";
import {
  formatLateralPgTimestampIst as formatPgTimestampIst,
  normalizeHeader,
  normalizeOptionalText,
} from "../src/services/lateral-processing/lateral-master-pg-backfill";

const SHEET_NAME = "Master Sheet";
const NBSP_RE = / /g;
const ALLOWED_POSTED = ["Yes", "-"] as const;
const JR_PATTERN = /^ATCI-[A-Za-z0-9-]+$/;
const DIFF_SAMPLE_SIZE = 5;
const SKIP_LOG_LIMIT = 40;

/** Stored columns we actually import (Date is forced NULL, so excluded here). */
const IMPORT_DB_COLUMNS: ExecutiveMasterSheetDbColumn[] = [
  "job_requisition_id",
  "market_map",
  "primary_skills",
  "primary_location",
  "job_management_level",
  "must_have_skills",
  "location_flex",
  "skill_categorization",
  "job_description",
  "job_status",
  "posted",
  "priority",
];

/**
 * Descriptive columns touched on UPDATE (conflict). date/last_seen_at
 * excluded (Gmail pipeline owns them). posted is ALSO excluded — parsed and
 * validated from the sheet below, but never written here at all (insert or
 * update); it stays fully owned by executive-master-reconcile-postgres.ts.
 */
const UPDATE_SET_COLUMNS = [
  "market_map",
  "primary_skills",
  "primary_location",
  "job_management_level",
  "must_have_skills",
  "location_flex",
  "skill_categorization",
  "job_description",
  "job_status",
  "priority",
] as const;

const CANDIDATE_PATHS = [
  process.env.ARA_EXECUTIVE_MASTER_UPSERT_PATH?.trim() || "",
  path.join(process.cwd(), "data", "excel", "ATCI Exec Master Data Updated.xlsx"),
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
      const val = trimmed
        .slice(eq + 1)
        .trim()
        .replace(/^["']|["']$/g, "");
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
    ssl:
      url.includes("localhost") || url.includes("127.0.0.1") ? false : "require",
  });
}

interface ExtractedSheet {
  headers: string[];
  rows: unknown[][];
}

function cellToPrimitive(value: ExcelJS.CellValue): unknown {
  if (value === null || value === undefined) return null;
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    const anyVal = value as {
      text?: string;
      result?: unknown;
      richText?: Array<{ text?: string }>;
      formula?: string;
    };
    if (Array.isArray(anyVal.richText)) {
      return anyVal.richText.map((part) => part.text ?? "").join("");
    }
    // Formula cell — use the cached result (Priority is a VLOOKUP formula).
    if (anyVal.result !== undefined && anyVal.result !== null) {
      const r = anyVal.result;
      if (
        typeof r === "string" ||
        typeof r === "number" ||
        typeof r === "boolean"
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

async function extractMasterSheet(sourcePath: string): Promise<ExtractedSheet> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(sourcePath);
  const sheet =
    workbook.worksheets.find(
      (item) => item.name.trim().toLowerCase() === SHEET_NAME.toLowerCase()
    ) ?? null;
  if (!sheet) {
    const available = workbook.worksheets.map((item) => item.name).join(", ");
    throw new Error(
      `Sheet "${SHEET_NAME}" not found. Available: ${available || "(none)"}`
    );
  }

  const matrix: unknown[][] = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const values: unknown[] = [];
    const count = Math.max(row.cellCount, sheet.columnCount || 0);
    for (let col = 1; col <= count; col += 1) {
      values.push(cellToPrimitive(row.getCell(col).value));
    }
    while (
      values.length > 0 &&
      (values[values.length - 1] === null || values[values.length - 1] === "")
    ) {
      values.pop();
    }
    if (values.some((v) => v !== null && String(v).trim() !== "")) {
      matrix.push(values);
    }
  });

  if (matrix.length === 0) throw new Error("Master Sheet has no rows.");

  const headers = matrix[0].map((cell) =>
    cell === null || cell === undefined
      ? ""
      : String(cell).replace(NBSP_RE, " ").trim()
  );
  return { headers, rows: matrix.slice(1) };
}

interface HeaderMapping {
  /** db column → 0-based source index */
  index: Partial<Record<ExecutiveMasterSheetDbColumn, number>>;
  matchedHeader: Partial<Record<ExecutiveMasterSheetDbColumn, string>>;
  ignoredHeaders: string[];
}

function mapHeaders(sourceHeaders: string[]):
  | { ok: true; mapping: HeaderMapping }
  | { ok: false; message: string } {
  const headers = sourceHeaders.map((h) => String(h ?? "").trim());
  const index: HeaderMapping["index"] = {};
  const matchedHeader: HeaderMapping["matchedHeader"] = {};
  const claimed = new Set<number>();
  const missing: ExecutiveMasterSheetDbColumn[] = [];
  const ambiguous: string[] = [];

  for (const dbColumn of IMPORT_DB_COLUMNS) {
    const entry = EXECUTIVE_MASTER_COLUMN_MAP.find(
      (m) => m.dbColumn === dbColumn
    );
    if (!entry) continue;
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
        const norm = normalizeHeader(alias);
        if (!norm) continue;
        headers.forEach((header, i) => {
          if (normalizeHeader(header) === norm) matches.push({ i, header });
        });
      }
    }

    const unique = new Map<number, string>();
    for (const m of matches) unique.set(m.i, m.header);

    if (unique.size === 0) {
      missing.push(dbColumn);
      continue;
    }
    if (unique.size > 1) {
      ambiguous.push(`${dbColumn} → [${[...unique.values()].join(" | ")}]`);
      continue;
    }
    const [[i, header]] = unique.entries();
    if (claimed.has(i)) {
      ambiguous.push(`${dbColumn} → column ${i + 1} already claimed`);
      continue;
    }
    claimed.add(i);
    index[dbColumn] = i;
    matchedHeader[dbColumn] = header;
  }

  if (missing.length > 0 || ambiguous.length > 0) {
    return {
      ok: false,
      message: [
        "Executive Master Sheet header mapping failed. Import stopped.",
        missing.length ? `Missing: ${missing.join(", ")}` : "",
        ambiguous.length ? `Ambiguous: ${ambiguous.join("; ")}` : "",
        `Source headers: ${headers.filter(Boolean).join(" | ")}`,
      ]
        .filter(Boolean)
        .join("\n"),
    };
  }

  const ignoredHeaders = headers.filter((h, i) => h && !claimed.has(i));
  return { ok: true, mapping: { index, matchedHeader, ignoredHeaders } };
}

interface BuiltRow {
  job_requisition_id: string;
  market_map: string | null;
  primary_skills: string | null;
  primary_location: string | null;
  job_management_level: string | null;
  must_have_skills: string | null;
  location_flex: string | null;
  skill_categorization: string | null;
  job_description: string | null;
  job_status: string | null;
  posted: string | null;
  priority: string | null;
}

function cellIsEmpty(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === "string" && v.trim() === "");
}

interface SkippedRow {
  excelRow: number;
  jobRequisitionId: string | null;
  reason: string;
}

interface ValidationResult {
  rows: BuiltRow[];
  totalDataRows: number;
  skippedEmptyRows: number;
  skipped: SkippedRow[];
  distributions: {
    jobStatus: Record<string, number>;
    posted: Record<string, number>;
    priority: Record<string, number>;
    level: Record<string, number>;
  };
}

function bump(map: Record<string, number>, key: string) {
  map[key] = (map[key] ?? 0) + 1;
}

function extractAndValidate(
  rawRows: unknown[][],
  mapping: HeaderMapping
): ValidationResult {
  const idx = mapping.index;
  const skipped: SkippedRow[] = [];
  let skippedEmptyRows = 0;

  const cell = (row: unknown[], col: ExecutiveMasterSheetDbColumn) => {
    const i = idx[col];
    return i === undefined ? null : row[i];
  };

  // Pass 1: parse each non-empty row into {excelRow, jr, raw}, skipping rows
  // with no usable Job Requisition ID. Track every excelRow seen per JR so
  // duplicates can be resolved (last occurrence in the sheet wins) before
  // building the final row set.
  const parsed: Array<{ excelRow: number; jr: string; raw: unknown[] }> = [];
  const rowsByJr = new Map<string, number[]>();

  for (let i = 0; i < rawRows.length; i += 1) {
    const excelRow = i + 2;
    const raw = rawRows[i] ?? [];
    if (raw.every((c) => cellIsEmpty(c))) {
      skippedEmptyRows += 1;
      continue;
    }

    const jr = normalizeOptionalText(cell(raw, "job_requisition_id"));
    if (!jr) {
      skipped.push({
        excelRow,
        jobRequisitionId: null,
        reason: "missing Job Requisition ID",
      });
      continue;
    }

    parsed.push({ excelRow, jr, raw });
    rowsByJr.set(jr, [...(rowsByJr.get(jr) ?? []), excelRow]);
  }

  const lastRowForJr = new Map<string, number>();
  for (const [jr, rows] of rowsByJr) {
    lastRowForJr.set(jr, rows[rows.length - 1]);
  }

  const rows: BuiltRow[] = [];
  const distributions = {
    jobStatus: {} as Record<string, number>,
    posted: {} as Record<string, number>,
    priority: {} as Record<string, number>,
    level: {} as Record<string, number>,
  };

  for (const { excelRow, jr, raw } of parsed) {
    const occurrences = rowsByJr.get(jr) ?? [];
    if (occurrences.length > 1 && lastRowForJr.get(jr) !== excelRow) {
      skipped.push({
        excelRow,
        jobRequisitionId: jr,
        reason: `duplicate Job Requisition ID — superseded by row ${lastRowForJr.get(jr)}`,
      });
      continue;
    }

    if (!JR_PATTERN.test(jr)) {
      skipped.push({
        excelRow,
        jobRequisitionId: jr,
        reason: `Job Requisition ID "${jr}" is not ATCI-prefixed`,
      });
      continue;
    }

    const statusText = normalizeOptionalText(cell(raw, "job_status"));
    if (
      statusText !== null &&
      !(EXECUTIVE_ALLOWED_JOB_STATUSES as readonly string[]).includes(
        statusText
      )
    ) {
      skipped.push({
        excelRow,
        jobRequisitionId: jr,
        reason: `invalid Job Status "${statusText}"`,
      });
      continue;
    }
    const job_status = statusText;

    const postedText = normalizeOptionalText(cell(raw, "posted"));
    if (
      postedText !== null &&
      !(ALLOWED_POSTED as readonly string[]).includes(postedText)
    ) {
      skipped.push({
        excelRow,
        jobRequisitionId: jr,
        reason: `invalid Posted "${postedText}"`,
      });
      continue;
    }
    const posted = postedText;

    const priority = normalizeExecutivePriority(cell(raw, "priority"));
    const level = normalizeOptionalText(cell(raw, "job_management_level"));

    bump(distributions.jobStatus, job_status ?? "(null)");
    bump(distributions.posted, posted ?? "(null)");
    bump(distributions.priority, priority ?? "(null)");
    bump(distributions.level, level ?? "(null)");

    rows.push({
      job_requisition_id: jr,
      market_map: normalizeOptionalText(cell(raw, "market_map")),
      primary_skills: normalizeOptionalText(cell(raw, "primary_skills")),
      primary_location: normalizeOptionalText(cell(raw, "primary_location")),
      job_management_level: level,
      must_have_skills: normalizeOptionalText(cell(raw, "must_have_skills")),
      location_flex: normalizeOptionalText(cell(raw, "location_flex")),
      skill_categorization: normalizeOptionalText(
        cell(raw, "skill_categorization")
      ),
      job_description: normalizeOptionalText(cell(raw, "job_description")),
      job_status,
      posted,
      priority,
    });
  }

  return {
    rows,
    totalDataRows: rawRows.length,
    skippedEmptyRows,
    skipped,
    distributions,
  };
}

function printSkipSummary(skipped: SkippedRow[]) {
  if (skipped.length === 0) {
    console.log("Skipped rows:      0");
    return;
  }
  console.log(`Skipped rows:      ${skipped.length}`);
  const byReason = new Map<string, number>();
  for (const s of skipped) {
    const key = s.reason.replace(/"[^"]*"/g, '"…"');
    byReason.set(key, (byReason.get(key) ?? 0) + 1);
  }
  console.log("  By reason:");
  for (const [reason, count] of byReason) {
    console.log(`    ${count.toString().padStart(4)}  ${reason}`);
  }
  console.log("  Detail (first " + Math.min(SKIP_LOG_LIMIT, skipped.length) + "):");
  for (const s of skipped.slice(0, SKIP_LOG_LIMIT)) {
    console.log(
      `    - Row ${s.excelRow} (${s.jobRequisitionId ?? "no JR"}): ${s.reason}`
    );
  }
  if (skipped.length > SKIP_LOG_LIMIT) {
    console.log(`    … +${skipped.length - SKIP_LOG_LIMIT} more`);
  }
}

async function main() {
  await loadEnvLocal();
  const dryRun = process.argv.includes("--dry-run");
  const runTimestamp = new Date();

  const resolved = resolveSourcePath();
  if (!resolved.ok) {
    console.error(
      [
        "Source workbook not found. Upsert stopped.",
        "Searched:",
        ...resolved.searched.map((p) => `  - ${p}`),
        "Set ARA_EXECUTIVE_MASTER_UPSERT_PATH to the absolute .xlsx path.",
      ].join("\n")
    );
    process.exit(1);
  }

  const sourcePath = resolved.path;
  console.log(`[upsert-executive-master] Source: ${sourcePath}`);
  console.log(`[upsert-executive-master] Mode: ${dryRun ? "DRY RUN (no writes)" : "LIVE WRITE"}`);

  const extracted = await extractMasterSheet(sourcePath);
  const mapped = mapHeaders(extracted.headers);
  if (!mapped.ok) {
    console.error(mapped.message);
    process.exit(1);
  }

  console.log(
    `[upsert-executive-master] Header mapping OK. Ignored (not imported): ${
      mapped.mapping.ignoredHeaders.join(" | ") || "(none)"
    }`
  );

  const validated = extractAndValidate(extracted.rows, mapped.mapping);

  console.log("\n========== EXECUTIVE MASTER ← EXCEL UPSERT ==========");
  console.log(`Source data rows:   ${validated.totalDataRows}`);
  console.log(`Skipped empty rows: ${validated.skippedEmptyRows}`);
  console.log(`Valid rows:         ${validated.rows.length}`);
  printSkipSummary(validated.skipped);
  console.log("\n-- Distributions (valid rows only) --");
  console.log("Job Status:", validated.distributions.jobStatus);
  console.log("Posted:    ", validated.distributions.posted);
  console.log("Priority:  ", validated.distributions.priority);
  console.log("Level:     ", validated.distributions.level);

  if (validated.rows.length === 0) {
    console.log("\nNo valid rows to write. Nothing to do.");
    return;
  }

  const sql = getDb();
  try {
    const existingRows = await sql<
      Record<(typeof UPDATE_SET_COLUMNS)[number] | "job_requisition_id", string | null>[]
    >`
      SELECT job_requisition_id, ${sql(UPDATE_SET_COLUMNS as unknown as string[])}
      FROM executive_master
    `;
    const existingByJr = new Map(
      existingRows.map((r) => [r.job_requisition_id as string, r])
    );

    const toInsert = validated.rows.filter(
      (r) => !existingByJr.has(r.job_requisition_id)
    );
    const toUpdate = validated.rows.filter((r) =>
      existingByJr.has(r.job_requisition_id)
    );

    const updateDiffs = toUpdate.map((row) => {
      const existing = existingByJr.get(row.job_requisition_id)!;
      const changes: string[] = [];
      for (const col of UPDATE_SET_COLUMNS) {
        const before = existing[col] ?? null;
        const after = (row as Record<string, string | null>)[col] ?? null;
        if (before !== after) {
          changes.push(`    ${col}: ${JSON.stringify(before)} → ${JSON.stringify(after)}`);
        }
      }
      return { row, changes };
    });
    const changedUpdates = updateDiffs.filter((d) => d.changes.length > 0);

    console.log("\n-- Plan --");
    console.log(`Would insert: ${toInsert.length}`);
    console.log(
      `Would update: ${toUpdate.length} (${changedUpdates.length} with actual field changes, ${toUpdate.length - changedUpdates.length} no-op)`
    );
    console.log(`Would skip:   ${validated.skipped.length}`);
    console.log(
      `date / last_seen_at / posted are never written by this script (owned by the Gmail pipeline).`
    );

    if (dryRun && changedUpdates.length > 0) {
      console.log(
        `\n-- Sample diffs (first ${Math.min(DIFF_SAMPLE_SIZE, changedUpdates.length)} of ${changedUpdates.length} rows with real changes) --`
      );
      for (const { row, changes } of changedUpdates.slice(0, DIFF_SAMPLE_SIZE)) {
        console.log(`  ${row.job_requisition_id}:`);
        console.log(changes.join("\n"));
      }
    }

    if (dryRun) {
      console.log("\nDry run complete. No database writes were made.");
      return;
    }

    await sql.begin(async (tx) => {
      const BATCH = 500;
      for (let i = 0; i < validated.rows.length; i += BATCH) {
        const chunk = validated.rows.slice(i, i + BATCH);
        const values = chunk.map((r) => [
          r.job_requisition_id,
          r.market_map,
          r.primary_skills,
          r.primary_location,
          r.job_management_level,
          r.must_have_skills,
          r.location_flex,
          r.skill_categorization,
          r.job_description,
          r.job_status,
          r.priority,
          null, // date — forced NULL, only applied on INSERT
          runTimestamp.toISOString(), // created_at — only applied on INSERT
          runTimestamp.toISOString(), // updated_at — applied on INSERT and UPDATE
          null, // last_seen_at — forced NULL, only applied on INSERT
        ]);

        await tx`
          INSERT INTO executive_master (
            job_requisition_id,
            market_map,
            primary_skills,
            primary_location,
            job_management_level,
            must_have_skills,
            location_flex,
            skill_categorization,
            job_description,
            job_status,
            priority,
            date,
            created_at,
            updated_at,
            last_seen_at
          )
          SELECT
            v.job_requisition_id,
            v.market_map,
            v.primary_skills,
            v.primary_location,
            v.job_management_level,
            v.must_have_skills,
            v.location_flex,
            v.skill_categorization,
            v.job_description,
            v.job_status,
            v.priority,
            v.date::date,
            v.created_at::timestamptz,
            v.updated_at::timestamptz,
            v.last_seen_at::timestamptz
          FROM (VALUES ${tx(values as never)}) AS v(
            job_requisition_id,
            market_map,
            primary_skills,
            primary_location,
            job_management_level,
            must_have_skills,
            location_flex,
            skill_categorization,
            job_description,
            job_status,
            priority,
            date,
            created_at,
            updated_at,
            last_seen_at
          )
          ON CONFLICT (job_requisition_id) DO UPDATE SET
            market_map = EXCLUDED.market_map,
            primary_skills = EXCLUDED.primary_skills,
            primary_location = EXCLUDED.primary_location,
            job_management_level = EXCLUDED.job_management_level,
            must_have_skills = EXCLUDED.must_have_skills,
            location_flex = EXCLUDED.location_flex,
            skill_categorization = EXCLUDED.skill_categorization,
            job_description = EXCLUDED.job_description,
            job_status = EXCLUDED.job_status,
            priority = EXCLUDED.priority,
            updated_at = EXCLUDED.updated_at
        `;
      }
    });

    const finalCount = Number(
      (
        await sql<{ c: string }[]>`SELECT COUNT(*)::text AS c FROM executive_master`
      )[0]?.c ?? "0"
    );

    console.log("\n-- Database --");
    console.log(`Inserted: ${toInsert.length}`);
    console.log(`Updated:  ${toUpdate.length}`);
    console.log(`Skipped:  ${validated.skipped.length}`);
    console.log(`Final executive_master row count: ${finalCount}`);
    console.log(`Run timestamp: ${formatPgTimestampIst(runTimestamp)}`);
    console.log("=======================================================\n");
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
