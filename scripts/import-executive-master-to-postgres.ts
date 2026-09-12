/**
 * ONE-TIME initial import: Executive Master Sheet (.xlsx) → PostgreSQL
 * `executive_master` (migration 009).
 *
 * Usage:
 *   npx tsx scripts/import-executive-master-to-postgres.ts [--dry-run]
 *   npm run db:import-executive-master
 *
 * Optional env:
 *   ARA_EXECUTIVE_MASTER_BACKFILL_PATH — absolute path to the source .xlsx
 *
 * Scope (matches the reviewed plan):
 *  - Reads the "Master Sheet" tab of the file as delivered (do NOT re-save it in
 *    Excel first — Priority is an external-workbook VLOOKUP and would blank out).
 *  - 13 columns only. The source "Active Pipeline" column is NOT imported.
 *  - Date: imported as NULL for every row (source has no Date data). The future
 *    pipeline sets `date` the same way Lateral does (New insert / Closed→Reopen).
 *  - Priority: normalized to "Very High Priority" | "High Priority" |
 *    "Do Not Add Supply" | NULL via normalizeExecutivePriority().
 *  - All text fields trimmed. Market Map casing is NOT normalized.
 *  - job_status restricted to New|Reopen|Active|Closed; posted to Yes|-.
 *  - Aborts if `executive_master` already has rows (no overwrite).
 *
 * Does NOT touch Gmail / Drive / scheduler / the Executive Master Sheet page /
 * the dry-run reconcile engine.
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

const CANDIDATE_PATHS = [
  process.env.ARA_EXECUTIVE_MASTER_BACKFILL_PATH?.trim() || "",
  path.join(process.cwd(), "data", "excel", "ATCI Exec Master Data Updated.xlsx"),
  path.join(process.cwd(), "data", "excel", "executive-master-import.xlsx"),
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

  // "date" is intentionally imported as NULL, so it's not required from source.
  const requiredDbColumns = IMPORT_DB_COLUMNS;

  for (const dbColumn of requiredDbColumns) {
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
  date: null;
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

interface ValidationResult {
  ok: boolean;
  rows: BuiltRow[];
  totalDataRows: number;
  skippedEmptyRows: number;
  errors: string[];
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

function validateAndBuild(
  rawRows: unknown[][],
  mapping: HeaderMapping
): ValidationResult {
  const idx = mapping.index;
  const rows: BuiltRow[] = [];
  const errors: string[] = [];
  const seen = new Map<string, number[]>();
  let skippedEmptyRows = 0;

  const distributions = {
    jobStatus: {} as Record<string, number>,
    posted: {} as Record<string, number>,
    priority: {} as Record<string, number>,
    level: {} as Record<string, number>,
  };

  const cell = (row: unknown[], col: ExecutiveMasterSheetDbColumn) => {
    const i = idx[col];
    return i === undefined ? null : row[i];
  };

  for (let i = 0; i < rawRows.length; i += 1) {
    const excelRow = i + 2;
    const raw = rawRows[i] ?? [];
    if (raw.every((c) => cellIsEmpty(c))) {
      skippedEmptyRows += 1;
      continue;
    }

    const jr = normalizeOptionalText(cell(raw, "job_requisition_id"));
    if (!jr) {
      errors.push(`Row ${excelRow}: missing Job Requisition ID`);
      continue;
    }
    if (!JR_PATTERN.test(jr)) {
      errors.push(`Row ${excelRow}: Job Requisition ID "${jr}" is not ATCI-prefixed`);
    }
    seen.set(jr, [...(seen.get(jr) ?? []), excelRow]);

    const statusText = normalizeOptionalText(cell(raw, "job_status"));
    let job_status: string | null = null;
    if (statusText !== null) {
      if (
        !(EXECUTIVE_ALLOWED_JOB_STATUSES as readonly string[]).includes(
          statusText
        )
      ) {
        errors.push(`Row ${excelRow}: invalid Job Status "${statusText}"`);
      } else {
        job_status = statusText;
      }
    }

    const postedText = normalizeOptionalText(cell(raw, "posted"));
    let posted: string | null = null;
    if (postedText !== null) {
      if (!(ALLOWED_POSTED as readonly string[]).includes(postedText)) {
        errors.push(`Row ${excelRow}: invalid Posted "${postedText}"`);
      } else {
        posted = postedText;
      }
    }

    const priority = normalizeExecutivePriority(cell(raw, "priority"));
    const level = normalizeOptionalText(cell(raw, "job_management_level"));

    bump(distributions.jobStatus, job_status ?? "(null)");
    bump(distributions.posted, posted ?? "(null)");
    bump(distributions.priority, priority ?? "(null)");
    bump(distributions.level, level ?? "(null)");

    rows.push({
      job_requisition_id: jr,
      date: null,
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

  for (const [jr, at] of seen) {
    if (at.length > 1) {
      errors.push(`Duplicate Job Requisition ID "${jr}" @ rows ${at.join(", ")}`);
    }
  }

  return {
    ok: errors.length === 0,
    rows,
    totalDataRows: rawRows.length,
    skippedEmptyRows,
    errors,
    distributions,
  };
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
        "Set ARA_EXECUTIVE_MASTER_BACKFILL_PATH to the absolute .xlsx path.",
      ].join("\n")
    );
    process.exit(1);
  }

  const sourcePath = resolved.path;
  console.log(`[import-executive-master] Source: ${sourcePath}`);

  const extracted = await extractMasterSheet(sourcePath);
  const mapped = mapHeaders(extracted.headers);
  if (!mapped.ok) {
    console.error(mapped.message);
    process.exit(1);
  }

  console.log(
    `[import-executive-master] Header mapping OK. Ignored (not imported): ${
      mapped.mapping.ignoredHeaders.join(" | ") || "(none)"
    }`
  );

  const validated = validateAndBuild(extracted.rows, mapped.mapping);

  console.log("\n========== EXECUTIVE MASTER → POSTGRES IMPORT ==========");
  console.log(`Source data rows:   ${validated.totalDataRows}`);
  console.log(`Skipped empty rows: ${validated.skippedEmptyRows}`);
  console.log(`Valid rows:         ${validated.rows.length}`);
  console.log("\n-- Distributions --");
  console.log("Job Status:", validated.distributions.jobStatus);
  console.log("Posted:    ", validated.distributions.posted);
  console.log("Priority:  ", validated.distributions.priority);
  console.log("Level:     ", validated.distributions.level);

  if (!validated.ok) {
    console.error("\nValidation FAILED. Import stopped. First 40 issues:");
    for (const err of validated.errors.slice(0, 40)) console.error(`  - ${err}`);
    if (validated.errors.length > 40) {
      console.error(`  … +${validated.errors.length - 40} more`);
    }
    process.exit(1);
  }

  if (dryRun) {
    console.log(
      `\nDry run OK — would insert ${validated.rows.length} rows. No DB writes.`
    );
    for (const sample of validated.rows.slice(0, 3)) {
      console.log("Sample:", {
        jr: sample.job_requisition_id,
        market_map: sample.market_map,
        level: sample.job_management_level,
        status: sample.job_status,
        posted: sample.posted,
        priority: sample.priority,
      });
    }
    return;
  }

  const sql = getDb();
  try {
    const existing = Number(
      (
        await sql<{ c: string }[]>`SELECT COUNT(*)::text AS c FROM executive_master`
      )[0]?.c ?? "0"
    );
    if (existing > 0) {
      console.error(
        [
          "",
          `executive_master already has ${existing} row(s).`,
          "This one-time import does NOT overwrite existing rows. Import stopped.",
        ].join("\n")
      );
      process.exit(1);
    }

    await sql.begin(async (tx) => {
      const BATCH = 500;
      for (let i = 0; i < validated.rows.length; i += BATCH) {
        const batch = validated.rows.slice(i, i + BATCH).map((r) => ({
          job_requisition_id: r.job_requisition_id,
          date: null as null,
          market_map: r.market_map,
          primary_skills: r.primary_skills,
          primary_location: r.primary_location,
          job_management_level: r.job_management_level,
          must_have_skills: r.must_have_skills,
          location_flex: r.location_flex,
          skill_categorization: r.skill_categorization,
          job_description: r.job_description,
          job_status: r.job_status,
          posted: r.posted,
          priority: r.priority,
          created_at: importTimestamp,
          updated_at: importTimestamp,
          last_seen_at: null as null,
        }));
        await tx`INSERT INTO executive_master ${tx(batch)}`;
      }
    });

    const finalCount = Number(
      (
        await sql<{ c: string }[]>`SELECT COUNT(*)::text AS c FROM executive_master`
      )[0]?.c ?? "0"
    );

    const priorityRows = await sql<{ value: string | null; c: string }[]>`
      SELECT priority AS value, COUNT(*)::text AS c
      FROM executive_master GROUP BY priority ORDER BY priority NULLS FIRST
    `;

    console.log("\n-- Database --");
    console.log(`Inserted:               ${validated.rows.length}`);
    console.log(`Final executive_master: ${finalCount}`);
    console.log(
      `created_at / updated_at: ${formatPgTimestampIst(importTimestamp)}; last_seen_at = NULL`
    );
    console.log("Priority in DB:");
    for (const row of priorityRows) {
      console.log(`  ${row.value ?? "(null)"} → ${row.c}`);
    }
    console.log("=======================================================\n");

    if (finalCount !== validated.rows.length) {
      console.error(
        `WARNING: final count ${finalCount} != inserted ${validated.rows.length}`
      );
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
