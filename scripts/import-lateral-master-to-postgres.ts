/**
 * ONE-TIME initial backfill: Excel Master Sheet → PostgreSQL lateral_master.
 *
 * Usage:
 *   npx tsx scripts/import-lateral-master-to-postgres.ts
 *   npm run db:import-lateral-master
 *
 * Optional env:
 *   ARA_LATERAL_MASTER_BACKFILL_PATH  — absolute path to the .xlsm workbook
 *
 * Does NOT modify Gmail / Drive / Run All / Job Status engine / Posted logic /
 * P-Roles / Dashboard. Does NOT UPSERT existing Master rows.
 */

import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import postgres from "postgres";
import {
  LATERAL_MASTER_SHEET_NAME,
  analyzeExistingMasterProtection,
  countDistribution,
  formatLateralPgDateDdMmYyyy,
  formatLateralPgTimestampIst,
  mapMasterSheetHeaders,
  validateAndBuildBackfillRows,
  type LateralMasterBackfillReport,
  type LateralMasterBackfillRow,
} from "../src/services/lateral-processing/lateral-master-pg-backfill";

const execFileAsync = promisify(execFile);

const CANDIDATE_WORKBOOK_PATHS = [
  process.env.ARA_LATERAL_MASTER_BACKFILL_PATH?.trim() || "",
  process.env.ARA_LATERAL_EXCEL_PATH?.trim() || "",
  String.raw`c:\Users\RODGE\Dropbox\Restricted Access\ATCI Control Sheets\ATCI Lateral\ATCI Lateral DS AI MasterSheet Final 2026.xlsm`,
  path.join(
    process.cwd(),
    "..",
    "Copy of ATCI Lateral DS AI MasterSheet Final 2026.xlsm"
  ),
  path.join(process.cwd(), "data", "excel", "lateral-mastersheet.xlsm"),
].filter(Boolean);

async function loadEnvLocal() {
  const envLocalPath = path.join(process.cwd(), ".env.local");
  try {
    const envContent = await fs.readFile(envLocalPath, "utf8");
    for (const line of envContent.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx < 1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
      if (key && !(key in process.env)) process.env[key] = val;
    }
  } catch {
    // optional
  }
}

export function resolveBackfillWorkbookPath(
  candidates: string[] = CANDIDATE_WORKBOOK_PATHS
): { ok: true; path: string } | { ok: false; searched: string[] } {
  const searched: string[] = [];
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    searched.push(resolved);
    if (existsSync(resolved)) {
      return { ok: true, path: resolved };
    }
  }
  return { ok: false, searched };
}

interface ExtractedSheet {
  sheetName: string;
  headers: string[];
  rows: unknown[][];
}

/**
 * Read ONLY Master Sheet via openpyxl (xlsm-safe). Dates → YYYY-MM-DD strings.
 */
export async function extractMasterSheetRows(
  workbookPath: string,
  sheetName = LATERAL_MASTER_SHEET_NAME
): Promise<ExtractedSheet> {
  const outPath = path.join(
    os.tmpdir(),
    `lateral-master-backfill-${Date.now()}.json`
  );
  const script = `
import json, sys
from datetime import date, datetime
from openpyxl import load_workbook

workbook_path = sys.argv[1]
sheet_name = sys.argv[2]
out_path = sys.argv[3]

wb = load_workbook(workbook_path, read_only=True, data_only=True, keep_vba=False)
names = list(wb.sheetnames)
if sheet_name not in names:
    print(json.dumps({"ok": False, "error": f'Sheet "{sheet_name}" was not found.', "available": names}))
    wb.close()
    raise SystemExit(0)

ws = wb[sheet_name]
headers = []
rows = []
first = True
for row in ws.iter_rows(values_only=True):
    values = list(row)
    if first:
        headers = [("" if v is None else str(v).strip()) for v in values]
        # trim trailing empty headers
        while headers and headers[-1] == "":
            headers.pop()
        first = False
        continue
    # normalize cell values for JSON
    out = []
    for v in values[:len(headers)]:
        if v is None:
            out.append(None)
        elif isinstance(v, datetime):
            out.append(v.date().isoformat())
        elif isinstance(v, date):
            out.append(v.isoformat())
        elif isinstance(v, (int, float)) and not isinstance(v, bool):
            out.append(v)
        else:
            out.append(str(v))
    rows.append(out)

wb.close()
payload = {"ok": True, "sheetName": sheet_name, "headers": headers, "rows": rows}
with open(out_path, "w", encoding="utf-8") as f:
    json.dump(payload, f)
print(json.dumps({"ok": True, "outPath": out_path, "rowCount": len(rows), "headerCount": len(headers)}))
`.trim();

  const scriptPath = path.join(
    os.tmpdir(),
    `lateral-master-extract-${Date.now()}.py`
  );
  try {
    await fs.writeFile(scriptPath, script, "utf8");
    const { stdout } = await execFileAsync(
      "python",
      [scriptPath, workbookPath, sheetName, outPath],
      {
        windowsHide: true,
        timeout: 10 * 60 * 1000,
        maxBuffer: 64 * 1024 * 1024,
      }
    );
    const meta = JSON.parse((stdout || "").trim() || "{}") as {
      ok?: boolean;
      error?: string;
      available?: string[];
      outPath?: string;
    };
    if (!meta.ok) {
      const available = (meta.available || []).join(", ") || "(none)";
      throw new Error(
        `${meta.error || "Failed to read Master Sheet."} Available sheets: ${available}`
      );
    }
    const raw = JSON.parse(await fs.readFile(outPath, "utf8")) as {
      ok?: boolean;
      sheetName: string;
      headers: string[];
      rows: unknown[][];
      error?: string;
    };
    if (!raw.ok) {
      throw new Error(raw.error || "Master Sheet extract produced invalid JSON.");
    }
    return {
      sheetName: raw.sheetName,
      headers: raw.headers,
      rows: raw.rows,
    };
  } finally {
    await fs.unlink(scriptPath).catch(() => undefined);
    await fs.unlink(outPath).catch(() => undefined);
  }
}

function getDb() {
  const url = process.env.POSTGRES_URL?.trim();
  if (!url) {
    throw new Error(
      "POSTGRES_URL is not set. Set it in the environment or .env.local."
    );
  }
  return postgres(url, {
    max: 1,
    connect_timeout: 15,
    idle_timeout: 20,
    ssl:
      url.includes("localhost") || url.includes("127.0.0.1") ? false : "require",
  });
}

async function insertRowsInTransaction(
  sql: ReturnType<typeof postgres>,
  rows: LateralMasterBackfillRow[],
  importTimestamp: Date
): Promise<number> {
  const createdAt = importTimestamp;
  const updatedAt = importTimestamp;

  await sql.begin(async (tx) => {
    // Batch insert for performance; still one transaction.
    const BATCH = 500;
    for (let i = 0; i < rows.length; i += BATCH) {
      const batch = rows.slice(i, i + BATCH).map((r) => ({
        job_requisition_id: r.job_requisition_id,
        date: r.date,
        priority: r.priority,
        job_description: r.job_description,
        skill_categorization: r.skill_categorization,
        primary_skills: r.primary_skills,
        job_management_level: r.job_management_level,
        primary_location: r.primary_location,
        market_map: r.market_map,
        poc: r.poc,
        job_status: r.job_status,
        posted: r.posted,
        created_at: createdAt,
        updated_at: updatedAt,
        last_seen_at: null as null,
      }));
      await tx`INSERT INTO lateral_master ${tx(batch)}`;
    }
  });

  return rows.length;
}

function printReport(report: LateralMasterBackfillReport) {
  console.log("\n========== LATERAL MASTER → POSTGRES BACKFILL REPORT ==========");
  console.log(`Status: ${report.status}`);
  console.log(`Message: ${report.message}`);
  console.log(
    `Import timestamp (created_at / updated_at): ${formatLateralPgTimestampIst(report.importTimestamp)}`
  );
  console.log("\n-- Source --");
  console.log(`Workbook: ${report.source.workbookFilename}`);
  console.log(`Path: ${report.source.workbookPath}`);
  console.log(`Sheet: ${report.source.sheetName}`);
  console.log(`Headers: ${report.source.detectedHeaders.join(" | ")}`);
  console.log(
    `Ignored (not imported): ${report.source.ignoredHeaders.join(" | ") || "(none)"}`
  );
  console.log("\n-- Rows --");
  console.log(`Total Excel data rows: ${report.rows.totalExcelDataRows}`);
  console.log(`Skipped empty rows: ${report.rows.skippedEmptyRows}`);
  console.log(`Valid rows: ${report.rows.validRows}`);
  console.log(`Invalid rows: ${report.rows.invalidRows}`);
  console.log(`Duplicate JR IDs: ${report.rows.duplicateJrCount}`);
  console.log(`Missing JR: ${report.rows.missingJrCount}`);
  console.log(`Invalid Job Status: ${report.rows.invalidJobStatusCount}`);
  console.log(`Invalid Posted: ${report.rows.invalidPostedCount}`);
  console.log(`Invalid dates: ${report.rows.invalidDateCount}`);
  if (report.distributions) {
    console.log("\n-- Distributions --");
    console.log("Job Status:", report.distributions.jobStatus);
    console.log("Posted:", report.distributions.posted);
  }
  console.log("\n-- Database --");
  console.log(`Existing before: ${report.database.existingCountBefore}`);
  console.log(`Overlapping IDs: ${report.database.overlappingIds}`);
  console.log(`New IDs: ${report.database.newIds}`);
  console.log(`Inserted: ${report.database.rowsInserted}`);
  console.log(`Skipped: ${report.database.rowsSkipped}`);
  console.log(`Failed: ${report.database.rowsFailed}`);
  console.log(`Final lateral_master count: ${report.database.finalCount}`);
  console.log("===============================================================\n");
}

export async function runLateralMasterPostgresBackfill(options?: {
  workbookPath?: string;
  dryRun?: boolean;
}): Promise<LateralMasterBackfillReport> {
  await loadEnvLocal();

  const importTimestamp = new Date();
  const importIso = importTimestamp.toISOString();

  const resolved = options?.workbookPath
    ? existsSync(options.workbookPath)
      ? { ok: true as const, path: path.resolve(options.workbookPath) }
      : {
          ok: false as const,
          searched: [path.resolve(options.workbookPath)],
        }
    : resolveBackfillWorkbookPath();

  if (!resolved.ok) {
    const report: LateralMasterBackfillReport = {
      source: {
        workbookPath: "",
        workbookFilename: "",
        sheetName: LATERAL_MASTER_SHEET_NAME,
        detectedHeaders: [],
        ignoredHeaders: [],
      },
      rows: {
        totalExcelDataRows: 0,
        skippedEmptyRows: 0,
        validRows: 0,
        invalidRows: 0,
        duplicateJrCount: 0,
        missingJrCount: 0,
        invalidJobStatusCount: 0,
        invalidPostedCount: 0,
        invalidDateCount: 0,
      },
      database: {
        existingCountBefore: 0,
        overlappingIds: 0,
        newIds: 0,
        rowsInserted: 0,
        rowsSkipped: 0,
        rowsFailed: 0,
        finalCount: null,
      },
      importTimestamp: importIso,
      status: "aborted",
      message: [
        "Source workbook could not be located. Import stopped.",
        "Searched:",
        ...resolved.searched.map((p) => `  - ${p}`),
        "Set ARA_LATERAL_MASTER_BACKFILL_PATH to the absolute .xlsm path.",
      ].join("\n"),
    };
    printReport(report);
    return report;
  }

  const workbookPath = resolved.path;
  const workbookFilename = path.basename(workbookPath);

  let extracted: ExtractedSheet;
  try {
    extracted = await extractMasterSheetRows(workbookPath);
  } catch (err) {
    const report: LateralMasterBackfillReport = {
      source: {
        workbookPath,
        workbookFilename,
        sheetName: LATERAL_MASTER_SHEET_NAME,
        detectedHeaders: [],
        ignoredHeaders: [],
      },
      rows: {
        totalExcelDataRows: 0,
        skippedEmptyRows: 0,
        validRows: 0,
        invalidRows: 0,
        duplicateJrCount: 0,
        missingJrCount: 0,
        invalidJobStatusCount: 0,
        invalidPostedCount: 0,
        invalidDateCount: 0,
      },
      database: {
        existingCountBefore: 0,
        overlappingIds: 0,
        newIds: 0,
        rowsInserted: 0,
        rowsSkipped: 0,
        rowsFailed: 0,
        finalCount: null,
      },
      importTimestamp: importIso,
      status: "failed",
      message: err instanceof Error ? err.message : String(err),
    };
    printReport(report);
    return report;
  }

  const mapping = mapMasterSheetHeaders(extracted.headers);
  if (!mapping.ok) {
    const report: LateralMasterBackfillReport = {
      source: {
        workbookPath,
        workbookFilename,
        sheetName: extracted.sheetName,
        detectedHeaders: extracted.headers,
        ignoredHeaders: [],
      },
      rows: {
        totalExcelDataRows: extracted.rows.length,
        skippedEmptyRows: 0,
        validRows: 0,
        invalidRows: extracted.rows.length,
        duplicateJrCount: 0,
        missingJrCount: 0,
        invalidJobStatusCount: 0,
        invalidPostedCount: 0,
        invalidDateCount: 0,
      },
      database: {
        existingCountBefore: 0,
        overlappingIds: 0,
        newIds: 0,
        rowsInserted: 0,
        rowsSkipped: 0,
        rowsFailed: 0,
        finalCount: null,
      },
      importTimestamp: importIso,
      status: "aborted",
      message: mapping.message,
    };
    printReport(report);
    return report;
  }

  const validated = validateAndBuildBackfillRows({
    headers: extracted.headers,
    rawRows: extracted.rows,
    mapping,
  });

  if (!validated.ok) {
    const report: LateralMasterBackfillReport = {
      source: {
        workbookPath,
        workbookFilename,
        sheetName: extracted.sheetName,
        detectedHeaders: extracted.headers,
        ignoredHeaders: mapping.ignoredHeaders,
      },
      rows: {
        totalExcelDataRows: validated.totalExcelDataRows,
        skippedEmptyRows: validated.skippedEmptyRows,
        validRows: 0,
        invalidRows:
          validated.missingJrRows.length +
          validated.duplicateJrs.reduce(
            (n, d) => n + d.excelRowNumbers.length,
            0
          ) +
          validated.invalidJobStatuses.length +
          validated.invalidPosted.length +
          validated.invalidDates.length,
        duplicateJrCount: validated.duplicateJrs.length,
        missingJrCount: validated.missingJrRows.length,
        invalidJobStatusCount: validated.invalidJobStatuses.length,
        invalidPostedCount: validated.invalidPosted.length,
        invalidDateCount: validated.invalidDates.length,
      },
      database: {
        existingCountBefore: 0,
        overlappingIds: 0,
        newIds: 0,
        rowsInserted: 0,
        rowsSkipped: 0,
        rowsFailed: 0,
        finalCount: null,
      },
      importTimestamp: importIso,
      status: "aborted",
      message: validated.message,
    };
    printReport(report);
    return report;
  }

  const sql = getDb();
  try {
    const existingRows = await sql<{ job_requisition_id: string }[]>`
      SELECT job_requisition_id FROM lateral_master
    `;
    const existingIds = existingRows.map((r) => r.job_requisition_id);
    const protection = analyzeExistingMasterProtection({
      sourceIds: validated.rows.map((r) => r.job_requisition_id),
      existingIds,
    });

    if (protection.overlappingIds.length > 0 || protection.existingCount > 0) {
      const finalCount = Number(
        (
          await sql<{ c: string }[]>`SELECT COUNT(*)::text AS c FROM lateral_master`
        )[0]?.c ?? "0"
      );
      const report: LateralMasterBackfillReport = {
        source: {
          workbookPath,
          workbookFilename,
          sheetName: extracted.sheetName,
          detectedHeaders: extracted.headers,
          ignoredHeaders: mapping.ignoredHeaders,
        },
        rows: {
          totalExcelDataRows: validated.totalExcelDataRows,
          skippedEmptyRows: validated.skippedEmptyRows,
          validRows: validated.rows.length,
          invalidRows: 0,
          duplicateJrCount: 0,
          missingJrCount: 0,
          invalidJobStatusCount: 0,
          invalidPostedCount: 0,
          invalidDateCount: 0,
        },
        distributions: {
          jobStatus: countDistribution(validated.rows, "job_status"),
          posted: countDistribution(validated.rows, "posted"),
        },
        database: {
          existingCountBefore: protection.existingCount,
          overlappingIds: protection.overlappingIds.length,
          newIds: protection.newIds.length,
          rowsInserted: 0,
          rowsSkipped: validated.rows.length,
          rowsFailed: 0,
          finalCount,
        },
        importTimestamp: importIso,
        status: "aborted",
        message: [
          "PostgreSQL lateral_master is not empty (or overlapping Job Requisition IDs exist).",
          "This one-time backfill does NOT overwrite existing Master records.",
          `Existing rows: ${protection.existingCount}`,
          `Overlapping IDs: ${protection.overlappingIds.length}`,
          `New IDs in source: ${protection.newIds.length}`,
          `Source rows: ${protection.sourceIds}`,
          protection.overlappingIds.length
            ? `Sample overlapping: ${protection.overlappingIds.slice(0, 10).join(", ")}`
            : "",
        ]
          .filter(Boolean)
          .join("\n"),
      };
      printReport(report);
      return report;
    }

    if (options?.dryRun) {
      const report: LateralMasterBackfillReport = {
        source: {
          workbookPath,
          workbookFilename,
          sheetName: extracted.sheetName,
          detectedHeaders: extracted.headers,
          ignoredHeaders: mapping.ignoredHeaders,
        },
        rows: {
          totalExcelDataRows: validated.totalExcelDataRows,
          skippedEmptyRows: validated.skippedEmptyRows,
          validRows: validated.rows.length,
          invalidRows: 0,
          duplicateJrCount: 0,
          missingJrCount: 0,
          invalidJobStatusCount: 0,
          invalidPostedCount: 0,
          invalidDateCount: 0,
        },
        distributions: {
          jobStatus: countDistribution(validated.rows, "job_status"),
          posted: countDistribution(validated.rows, "posted"),
        },
        database: {
          existingCountBefore: 0,
          overlappingIds: 0,
          newIds: validated.rows.length,
          rowsInserted: 0,
          rowsSkipped: validated.rows.length,
          rowsFailed: 0,
          finalCount: 0,
        },
        importTimestamp: importIso,
        status: "success",
        message: `Dry run OK — would insert ${validated.rows.length} rows. No database writes performed.`,
      };
      printReport(report);
      // sample
      for (const sample of validated.rows.slice(0, 3)) {
        console.log("Sample:", {
          jr: sample.job_requisition_id,
          date: formatLateralPgDateDdMmYyyy(sample.date),
          status: sample.job_status,
          posted: sample.posted,
        });
      }
      return report;
    }

    let inserted = 0;
    try {
      inserted = await insertRowsInTransaction(
        sql,
        validated.rows,
        importTimestamp
      );
    } catch (err) {
      const finalCount = Number(
        (
          await sql<{ c: string }[]>`SELECT COUNT(*)::text AS c FROM lateral_master`
        )[0]?.c ?? "0"
      );
      const report: LateralMasterBackfillReport = {
        source: {
          workbookPath,
          workbookFilename,
          sheetName: extracted.sheetName,
          detectedHeaders: extracted.headers,
          ignoredHeaders: mapping.ignoredHeaders,
        },
        rows: {
          totalExcelDataRows: validated.totalExcelDataRows,
          skippedEmptyRows: validated.skippedEmptyRows,
          validRows: validated.rows.length,
          invalidRows: 0,
          duplicateJrCount: 0,
          missingJrCount: 0,
          invalidJobStatusCount: 0,
          invalidPostedCount: 0,
          invalidDateCount: 0,
        },
        distributions: {
          jobStatus: countDistribution(validated.rows, "job_status"),
          posted: countDistribution(validated.rows, "posted"),
        },
        database: {
          existingCountBefore: 0,
          overlappingIds: 0,
          newIds: validated.rows.length,
          rowsInserted: 0,
          rowsSkipped: 0,
          rowsFailed: validated.rows.length,
          finalCount,
        },
        importTimestamp: importIso,
        status: "failed",
        message:
          err instanceof Error
            ? `Insert failed and was rolled back: ${err.message}`
            : "Insert failed and was rolled back.",
      };
      printReport(report);
      return report;
    }

    const finalCount = Number(
      (
        await sql<{ c: string }[]>`SELECT COUNT(*)::text AS c FROM lateral_master`
      )[0]?.c ?? "0"
    );

    // Sample validation vs Excel
    const samples = validated.rows.slice(0, 5);
    for (const sample of samples) {
      const dbRow = await sql`
        SELECT job_requisition_id, date::text AS date, job_status, posted, last_seen_at
        FROM lateral_master
        WHERE job_requisition_id = ${sample.job_requisition_id}
      `;
      console.log("Sample check:", {
        excel: {
          jr: sample.job_requisition_id,
          date: sample.date,
          dateDisplay: formatLateralPgDateDdMmYyyy(sample.date),
          status: sample.job_status,
          posted: sample.posted,
        },
        postgres: dbRow[0] ?? null,
        createdAtDisplay: formatLateralPgTimestampIst(importTimestamp),
        updatedAtDisplay: formatLateralPgTimestampIst(importTimestamp),
      });
    }

    const report: LateralMasterBackfillReport = {
      source: {
        workbookPath,
        workbookFilename,
        sheetName: extracted.sheetName,
        detectedHeaders: extracted.headers,
        ignoredHeaders: mapping.ignoredHeaders,
      },
      rows: {
        totalExcelDataRows: validated.totalExcelDataRows,
        skippedEmptyRows: validated.skippedEmptyRows,
        validRows: validated.rows.length,
        invalidRows: 0,
        duplicateJrCount: 0,
        missingJrCount: 0,
        invalidJobStatusCount: 0,
        invalidPostedCount: 0,
        invalidDateCount: 0,
      },
      distributions: {
        jobStatus: countDistribution(validated.rows, "job_status"),
        posted: countDistribution(validated.rows, "posted"),
      },
      database: {
        existingCountBefore: 0,
        overlappingIds: 0,
        newIds: validated.rows.length,
        rowsInserted: inserted,
        rowsSkipped: 0,
        rowsFailed: 0,
        finalCount,
      },
      importTimestamp: importIso,
      status: "success",
      message: [
        `Inserted ${inserted} Master rows into lateral_master.`,
        `Excel data rows: ${validated.totalExcelDataRows}; PG final count: ${finalCount}.`,
        `last_seen_at left NULL; created_at/updated_at = ${formatLateralPgTimestampIst(importTimestamp)}.`,
      ].join(" "),
    };
    printReport(report);
    return report;
  } finally {
    await sql.end();
  }
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const report = await runLateralMasterPostgresBackfill({ dryRun });
  if (report.status !== "success") {
    process.exitCode = 1;
  }
}

const isDirectRun =
  process.argv[1] &&
  path.resolve(process.argv[1]).includes("import-lateral-master-to-postgres");

if (isDirectRun) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
