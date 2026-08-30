/**
 * ATCI DS → PostgreSQL lateral_staging import.
 *
 * Flow:
 *  1. Read ATCI DS (exact sheet) via existing source workbook reader
 *  2. Intelligent column mapping
 *  3. Validate COMPLETE dataset (duplicates = STOP, matching JR comparison)
 *  4. Only then: BEGIN → TRUNCATE staging → INSERT → COMMIT
 *
 * Does NOT touch lateral_master, Job Status, Posted, P-Roles, or Dashboard.
 */

import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type postgres from "postgres";
import {
  formatLateralPgDateDdMmYyyy,
  formatLateralPgTimestampIst,
  normalizeOptionalText,
  parseExcelDateToIso,
} from "@/services/lateral-processing/lateral-master-pg-backfill";
import {
  mapAtciDsToStagingFields,
  type StagingFieldMapping,
  type StagingMappingResult,
  type StagingTargetField,
} from "@/services/lateral-processing/lateral-staging-intelligent-mapping";
import {
  ATCI_DS_WORKSHEET_NOT_FOUND,
  processLateralSourceWorkbook,
  type LateralSourceWorkbookRead,
} from "@/services/lateral-processing/lateral-source-workbook";
import { DEFAULT_LATERAL_SOURCE_WORKSHEET } from "@/types/lateral-processing-setup";

const execFileAsync = promisify(execFile);

export interface StagingImportRow {
  excelRowNumber: number;
  date: string | null; // YYYY-MM-DD
  job_requisition_id: string;
  priority: string | null;
  job_description: string | null;
  skill_categorization: string | null;
  primary_skills: string | null;
  job_management_level: string | null;
  primary_location: string | null;
  market_map: string | null;
  poc: string | null;
}

export interface StagingDuplicateReport {
  jobRequisitionId: string;
  excelRowNumbers: number[];
}

export interface StagingValidationSuccess {
  ok: true;
  rows: StagingImportRow[];
  totalSourceRows: number;
  skippedEmptyRows: number;
  mappings: StagingFieldMapping[];
  ignoredSourceHeaders: string[];
  processingDateIso: string;
}

export interface StagingValidationFailure {
  ok: false;
  message: string;
  totalSourceRows: number;
  skippedEmptyRows: number;
  missingJrRows: number[];
  duplicateJrs: StagingDuplicateReport[];
  invalidDates: Array<{ excelRowNumber: number; value: string }>;
  mapping?: StagingMappingResult;
}

export type StagingValidationResult =
  | StagingValidationSuccess
  | StagingValidationFailure;

export interface LateralStagingImportReport {
  status: "success" | "aborted" | "failed";
  message: string;
  ranAtDisplay: string;
  processingDateIso: string;
  processingDateDisplay: string;
  source: {
    workbookPath: string;
    workbookFilename: string;
    worksheetName: string;
    detectedHeaders: string[];
    ignoredHeaders: string[];
    availableWorksheets: string[];
  };
  mapping: Array<{
    field: StagingTargetField;
    sourceHeader: string | null;
    confidence: string;
    reason: string;
  }>;
  rows: {
    totalSourceRows: number;
    logicalDataRows: number;
    skippedEmptyRows: number;
    ignoredBlankFormattingRows: number | null;
    validRows: number;
    invalidRows: number;
    duplicateJrCount: number;
    missingJrCount: number;
    invalidDateCount: number;
  };
  database: {
    stagingCountBefore: number | null;
    stagingCountAfter: number | null;
    rowsInserted: number;
    masterCountBefore: number | null;
    masterCountAfter: number | null;
    masterUnchanged: boolean | null;
  };
}

/**
 * Runtime processing date for staging when ATCI DS has no Date column.
 * Uses the local calendar date of execution — never workbook filename dates.
 */
export function getRuntimeProcessingDateIso(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** A logical ATCI DS data row has at least one non-empty cell in the header span. */
export function isMeaningfulAtciDsDataRow(cells: unknown[]): boolean {
  return cells.some((c) => String(c ?? "").replace(/\u00a0/g, " ").trim() !== "");
}

/**
 * Count blank/formatting rows after the header that are not logical data.
 * Uses openpyxl iteration (not max_row as a record count).
 */
export async function countBlankFormattingRowsAfterHeader(options: {
  workbookPath: string;
  worksheetName: string;
}): Promise<number | null> {
  const scriptPath = path.join(
    os.tmpdir(),
    `lateral-staging-blank-count-${Date.now()}.py`
  );
  const script = `
import json, sys
from openpyxl import load_workbook
path, sheet = sys.argv[1], sys.argv[2]
wb = load_workbook(path, read_only=True, data_only=True, keep_vba=False)
if sheet not in wb.sheetnames:
    print(json.dumps({"ok": False}))
    wb.close()
    raise SystemExit(0)
ws = wb[sheet]
header_done = False
blank = 0
for row in ws.iter_rows(values_only=True):
    values = [("" if c is None else str(c).strip()) for c in row]
    if not header_done:
        if any(values):
            header_done = True
        continue
    if not any(values):
        blank += 1
wb.close()
print(json.dumps({"ok": True, "blank": blank}))
`.trim();
  try {
    await fs.writeFile(scriptPath, script, "utf8");
    const { stdout } = await execFileAsync(
      "python",
      [scriptPath, options.workbookPath, options.worksheetName],
      { windowsHide: true, timeout: 180_000, maxBuffer: 8 * 1024 * 1024 }
    );
    const parsed = JSON.parse((stdout || "").trim() || "{}") as {
      ok?: boolean;
      blank?: number;
    };
    return parsed.ok ? Number(parsed.blank ?? 0) : null;
  } catch {
    return null;
  } finally {
    await fs.unlink(scriptPath).catch(() => undefined);
  }
}

/**
 * Validate mapped ATCI DS rows. Does not touch the database.
 * Duplicate JR IDs → failure (preserves existing JR comparison STOP behavior).
 */
export function validateAtciDsRowsForStaging(options: {
  headers: string[];
  dataRows: string[][];
  mapping: Extract<StagingMappingResult, { ok: true }>;
  processingDateIso?: string;
  firstDataRowNumber?: number;
}): StagingValidationResult {
  const processingDateIso = options.processingDateIso || getRuntimeProcessingDateIso();
  const firstDataRowNumber = options.firstDataRowNumber ?? 2;
  const fieldIndex = Object.fromEntries(
    options.mapping.mappings.map((m) => [m.field, m])
  ) as Record<StagingTargetField, StagingFieldMapping>;

  const rows: StagingImportRow[] = [];
  const missingJrRows: number[] = [];
  const invalidDates: Array<{ excelRowNumber: number; value: string }> = [];
  const seen = new Map<string, number[]>();
  let skippedEmptyRows = 0;

  const dateMapping = fieldIndex.date;

  for (let i = 0; i < options.dataRows.length; i += 1) {
    const excelRowNumber = firstDataRowNumber + i;
    const cells = options.dataRows[i] ?? [];
    if (!isMeaningfulAtciDsDataRow(cells)) {
      skippedEmptyRows += 1;
      continue;
    }

    const jrMap = fieldIndex.job_requisition_id;
    const jrRaw = cells[jrMap.sourceColIndex] ?? "";
    const jr = String(jrRaw).replace(/\u00a0/g, " ").trim();
    if (!jr) {
      missingJrRows.push(excelRowNumber);
      continue;
    }

    let dateIso: string | null = processingDateIso;
    if (dateMapping.confidence !== "generated" && dateMapping.sourceColIndex >= 0) {
      const rawDate = cells[dateMapping.sourceColIndex];
      const parsed = parseExcelDateToIso(rawDate);
      if (!parsed.ok) {
        invalidDates.push({
          excelRowNumber,
          value: parsed.raw,
        });
        continue;
      }
      // Empty date in a mapped Date column → use processing date (stable)
      dateIso = parsed.iso ?? processingDateIso;
    }

    const list = seen.get(jr) ?? [];
    list.push(excelRowNumber);
    seen.set(jr, list);

    const textField = (field: StagingTargetField): string | null => {
      const m = fieldIndex[field];
      if (!m || m.sourceColIndex < 0) return null;
      return normalizeOptionalText(cells[m.sourceColIndex]);
    };

    rows.push({
      excelRowNumber,
      date: dateIso,
      job_requisition_id: jr,
      priority: textField("priority"),
      job_description: textField("job_description"),
      skill_categorization: textField("skill_categorization"),
      primary_skills: textField("primary_skills"),
      job_management_level: textField("job_management_level"),
      primary_location: textField("primary_location"),
      market_map: textField("market_map"),
      poc: textField("poc"),
    });
  }

  const duplicateJrs: StagingDuplicateReport[] = [];
  for (const [jobRequisitionId, excelRowNumbers] of seen) {
    if (excelRowNumbers.length > 1) {
      duplicateJrs.push({ jobRequisitionId, excelRowNumbers });
    }
  }

  const totalSourceRows = options.dataRows.length;
  if (
    missingJrRows.length > 0 ||
    duplicateJrs.length > 0 ||
    invalidDates.length > 0
  ) {
    const parts = [
      "ATCI DS staging validation failed. lateral_staging was NOT modified.",
    ];
    if (duplicateJrs.length > 0) {
      parts.push(
        `Duplicate Job Requisition ID(s): ${duplicateJrs
          .slice(0, 20)
          .map(
            (d) =>
              `${d.jobRequisitionId} @ rows ${d.excelRowNumbers.join(", ")}`
          )
          .join("; ")}${duplicateJrs.length > 20 ? ` (+${duplicateJrs.length - 20} more)` : ""}`
      );
    }
    if (missingJrRows.length > 0) {
      parts.push(
        `Missing Job Requisition ID on Excel row(s): ${missingJrRows
          .slice(0, 30)
          .join(", ")}`
      );
    }
    if (invalidDates.length > 0) {
      parts.push(
        `Invalid Date: ${invalidDates
          .slice(0, 20)
          .map((d) => `row ${d.excelRowNumber} "${d.value}"`)
          .join("; ")}`
      );
    }
    return {
      ok: false,
      message: parts.join("\n"),
      totalSourceRows,
      skippedEmptyRows,
      missingJrRows,
      duplicateJrs,
      invalidDates,
    };
  }

  return {
    ok: true,
    rows,
    totalSourceRows,
    skippedEmptyRows,
    mappings: options.mapping.mappings,
    ignoredSourceHeaders: options.mapping.ignoredSourceHeaders,
    processingDateIso,
  };
}

export async function replaceLateralStaging(
  sql: ReturnType<typeof postgres>,
  rows: StagingImportRow[]
): Promise<number> {
  await sql.begin(async (tx) => {
    await tx`TRUNCATE TABLE lateral_staging RESTART IDENTITY`;
    const BATCH = 500;
    for (let i = 0; i < rows.length; i += BATCH) {
      const batch = rows.slice(i, i + BATCH).map((r) => ({
        date: r.date,
        job_requisition_id: r.job_requisition_id,
        priority: r.priority,
        job_description: r.job_description,
        skill_categorization: r.skill_categorization,
        primary_skills: r.primary_skills,
        job_management_level: r.job_management_level,
        primary_location: r.primary_location,
        market_map: r.market_map,
        poc: r.poc,
      }));
      if (batch.length === 0) continue;
      await tx`INSERT INTO lateral_staging ${tx(batch)}`;
    }
  });
  return rows.length;
}

function emptyReport(
  partial: Partial<LateralStagingImportReport> &
    Pick<LateralStagingImportReport, "status" | "message">
): LateralStagingImportReport {
  const processingDateIso =
    partial.processingDateIso || getRuntimeProcessingDateIso();
  return {
    ranAtDisplay: formatLateralPgTimestampIst(new Date()),
    source: {
      workbookPath: "",
      workbookFilename: "",
      worksheetName: DEFAULT_LATERAL_SOURCE_WORKSHEET,
      detectedHeaders: [],
      ignoredHeaders: [],
      availableWorksheets: [],
    },
    mapping: [],
    rows: {
      totalSourceRows: 0,
      logicalDataRows: 0,
      skippedEmptyRows: 0,
      ignoredBlankFormattingRows: null,
      validRows: 0,
      invalidRows: 0,
      duplicateJrCount: 0,
      missingJrCount: 0,
      invalidDateCount: 0,
    },
    database: {
      stagingCountBefore: null,
      stagingCountAfter: null,
      rowsInserted: 0,
      masterCountBefore: null,
      masterCountAfter: null,
      masterUnchanged: null,
    },
    ...partial,
    // Override after spread so processing date is always set (and not duplicated pre-spread).
    processingDateIso,
    processingDateDisplay: formatLateralPgDateDdMmYyyy(processingDateIso),
  };
}

export function printStagingImportReport(report: LateralStagingImportReport) {
  console.log("\n========== ATCI DS → LATERAL_STAGING IMPORT REPORT ==========");
  console.log(`Status: ${report.status}`);
  console.log(`Message: ${report.message}`);
  console.log(`Ran at: ${report.ranAtDisplay}`);
  console.log(`Processing date: ${report.processingDateDisplay}`);
  console.log("\n-- Source --");
  console.log(`Workbook: ${report.source.workbookFilename}`);
  console.log(`Path: ${report.source.workbookPath}`);
  console.log(`Worksheet: ${report.source.worksheetName}`);
  console.log(
    `Available worksheets: ${report.source.availableWorksheets.join(", ") || "(unknown)"}`
  );
  console.log(`Headers: ${report.source.detectedHeaders.join(" | ")}`);
  console.log(
    `Ignored headers: ${report.source.ignoredHeaders.join(" | ") || "(none)"}`
  );
  console.log("\n-- Mapping --");
  for (const m of report.mapping) {
    console.log(
      `  ${m.field} ← ${m.sourceHeader ?? "(generated)"} [${m.confidence}] ${m.reason}`
    );
  }
  console.log("\n-- Rows --");
  console.log(`Logical data rows: ${report.rows.logicalDataRows}`);
  console.log(`Total source rows read: ${report.rows.totalSourceRows}`);
  console.log(`Skipped empty (in reader payload): ${report.rows.skippedEmptyRows}`);
  console.log(
    `Ignored blank/formatting rows (worksheet): ${report.rows.ignoredBlankFormattingRows ?? "(n/a)"}`
  );
  console.log(`Valid: ${report.rows.validRows}`);
  console.log(`Invalid: ${report.rows.invalidRows}`);
  console.log(`Duplicate JRs: ${report.rows.duplicateJrCount}`);
  console.log(`Missing JR: ${report.rows.missingJrCount}`);
  console.log(`Invalid dates: ${report.rows.invalidDateCount}`);
  console.log("\n-- Database --");
  console.log(`Staging before: ${report.database.stagingCountBefore}`);
  console.log(`Staging after: ${report.database.stagingCountAfter}`);
  console.log(`Inserted: ${report.database.rowsInserted}`);
  console.log(`Master before: ${report.database.masterCountBefore}`);
  console.log(`Master after: ${report.database.masterCountAfter}`);
  console.log(`Master unchanged: ${report.database.masterUnchanged}`);
  console.log("==============================================================\n");
}

/**
 * Full staging import from a local ATCI DS workbook path.
 * Validates completely before TRUNCATE/INSERT.
 */
export async function importAtciDsWorkbookToStaging(options: {
  sql: ReturnType<typeof postgres>;
  workbookPath: string;
  worksheetName?: string;
  dryRun?: boolean;
  /** Optional override for tests — production must omit this. */
  processingDateIso?: string;
}): Promise<LateralStagingImportReport> {
  const ranAt = new Date();
  const ranAtDisplay = formatLateralPgTimestampIst(ranAt);
  const processingDateIso =
    options.processingDateIso || getRuntimeProcessingDateIso(ranAt);
  const processingDateDisplay = formatLateralPgDateDdMmYyyy(processingDateIso);
  const worksheetName =
    options.worksheetName?.trim() || DEFAULT_LATERAL_SOURCE_WORKSHEET;

  let source: LateralSourceWorkbookRead;
  try {
    source = await processLateralSourceWorkbook({
      localPath: options.workbookPath,
      worksheetName,
      workbookFileName: path.basename(options.workbookPath),
    });
  } catch (err) {
    const message =
      err instanceof Error
        ? err.message
        : "Failed to read source workbook.";
    const report = emptyReport({
      status: "failed",
      message:
        message === ATCI_DS_WORKSHEET_NOT_FOUND
          ? ATCI_DS_WORKSHEET_NOT_FOUND
          : message,
      ranAtDisplay,
      processingDateIso,
      source: {
        workbookPath: options.workbookPath,
        workbookFilename: path.basename(options.workbookPath),
        worksheetName,
        detectedHeaders: [],
        ignoredHeaders: [],
        availableWorksheets: [],
      },
    });
    printStagingImportReport(report);
    return report;
  }

  const ignoredBlankFormattingRows = await countBlankFormattingRowsAfterHeader({
    workbookPath: options.workbookPath,
    worksheetName: source.worksheetName,
  });

  const mapping = mapAtciDsToStagingFields({
    sourceHeaders: source.headers,
    dataRows: source.dataRows,
  });

  const sourceMeta = {
    workbookPath: source.workbookPath,
    workbookFilename: source.workbookFileName,
    worksheetName: source.worksheetName,
    detectedHeaders: source.headers,
    ignoredHeaders: [] as string[],
    availableWorksheets: source.availableWorksheets,
  };

  if (!mapping.ok) {
    const report = emptyReport({
      status: "aborted",
      message: mapping.message,
      ranAtDisplay,
      processingDateIso,
      source: sourceMeta,
      rows: {
        totalSourceRows: source.rowCount,
        logicalDataRows: source.rowCount,
        skippedEmptyRows: 0,
        ignoredBlankFormattingRows,
        validRows: 0,
        invalidRows: source.rowCount,
        duplicateJrCount: 0,
        missingJrCount: 0,
        invalidDateCount: 0,
      },
    });
    printStagingImportReport(report);
    return report;
  }

  sourceMeta.ignoredHeaders = mapping.ignoredSourceHeaders;

  const validated = validateAtciDsRowsForStaging({
    headers: source.headers,
    dataRows: source.dataRows,
    mapping,
    firstDataRowNumber: source.headerRowNumber + 1,
    processingDateIso,
  });

  if (!validated.ok) {
    const report = emptyReport({
      status: "aborted",
      message: validated.message,
      ranAtDisplay,
      processingDateIso,
      source: sourceMeta,
      mapping: mapping.mappings.map((m) => ({
        field: m.field,
        sourceHeader: m.sourceHeader,
        confidence: m.confidence,
        reason: m.reason,
      })),
      rows: {
        totalSourceRows: validated.totalSourceRows,
        logicalDataRows:
          validated.totalSourceRows - validated.skippedEmptyRows,
        skippedEmptyRows: validated.skippedEmptyRows,
        ignoredBlankFormattingRows,
        validRows: 0,
        invalidRows:
          validated.missingJrRows.length +
          validated.duplicateJrs.reduce(
            (n, d) => n + d.excelRowNumbers.length,
            0
          ) +
          validated.invalidDates.length,
        duplicateJrCount: validated.duplicateJrs.length,
        missingJrCount: validated.missingJrRows.length,
        invalidDateCount: validated.invalidDates.length,
      },
    });
    printStagingImportReport(report);
    return report;
  }

  const masterBefore = Number(
    (
      await options.sql<{ c: string }[]>`
        SELECT COUNT(*)::text AS c FROM lateral_master
      `
    )[0]?.c ?? "0"
  );
  const stagingBefore = Number(
    (
      await options.sql<{ c: string }[]>`
        SELECT COUNT(*)::text AS c FROM lateral_staging
      `
    )[0]?.c ?? "0"
  );

  const mappingReport = validated.mappings.map((m) => ({
    field: m.field,
    sourceHeader: m.sourceHeader,
    confidence: m.confidence,
    reason: m.reason,
  }));

  const rowStats = {
    totalSourceRows: validated.totalSourceRows,
    logicalDataRows: validated.rows.length,
    skippedEmptyRows: validated.skippedEmptyRows,
    ignoredBlankFormattingRows,
    validRows: validated.rows.length,
    invalidRows: 0,
    duplicateJrCount: 0,
    missingJrCount: 0,
    invalidDateCount: 0,
  };

  if (options.dryRun) {
    const report: LateralStagingImportReport = {
      status: "success",
      message: `Dry run OK — would replace staging with ${validated.rows.length} rows (processing date ${processingDateDisplay}).`,
      ranAtDisplay,
      processingDateIso,
      processingDateDisplay,
      source: sourceMeta,
      mapping: mappingReport,
      rows: rowStats,
      database: {
        stagingCountBefore: stagingBefore,
        stagingCountAfter: stagingBefore,
        rowsInserted: 0,
        masterCountBefore: masterBefore,
        masterCountAfter: masterBefore,
        masterUnchanged: true,
      },
    };
    printStagingImportReport(report);
    return report;
  }

  let inserted = 0;
  try {
    inserted = await replaceLateralStaging(options.sql, validated.rows);
  } catch (err) {
    const stagingAfterFail = Number(
      (
        await options.sql<{ c: string }[]>`
          SELECT COUNT(*)::text AS c FROM lateral_staging
        `
      )[0]?.c ?? "0"
    );
    const masterAfterFail = Number(
      (
        await options.sql<{ c: string }[]>`
          SELECT COUNT(*)::text AS c FROM lateral_master
        `
      )[0]?.c ?? "0"
    );
    const report: LateralStagingImportReport = {
      status: "failed",
      message:
        err instanceof Error
          ? `Staging insert failed and was rolled back: ${err.message}`
          : "Staging insert failed and was rolled back.",
      ranAtDisplay,
      processingDateIso,
      processingDateDisplay,
      source: sourceMeta,
      mapping: mappingReport,
      rows: rowStats,
      database: {
        stagingCountBefore: stagingBefore,
        stagingCountAfter: stagingAfterFail,
        rowsInserted: 0,
        masterCountBefore: masterBefore,
        masterCountAfter: masterAfterFail,
        masterUnchanged: masterBefore === masterAfterFail,
      },
    };
    printStagingImportReport(report);
    return report;
  }

  const stagingAfter = Number(
    (
      await options.sql<{ c: string }[]>`
        SELECT COUNT(*)::text AS c FROM lateral_staging
      `
    )[0]?.c ?? "0"
  );
  const masterAfter = Number(
    (
      await options.sql<{ c: string }[]>`
        SELECT COUNT(*)::text AS c FROM lateral_master
      `
    )[0]?.c ?? "0"
  );

  const report: LateralStagingImportReport = {
    status: "success",
    message: [
      `Replaced lateral_staging with ${inserted} rows.`,
      `Processing date ${processingDateDisplay}.`,
      `Master unchanged (${masterBefore} → ${masterAfter}).`,
    ].join(" "),
    ranAtDisplay,
    processingDateIso,
    processingDateDisplay,
    source: sourceMeta,
    mapping: mappingReport,
    rows: rowStats,
    database: {
      stagingCountBefore: stagingBefore,
      stagingCountAfter: stagingAfter,
      rowsInserted: inserted,
      masterCountBefore: masterBefore,
      masterCountAfter: masterAfter,
      masterUnchanged: masterBefore === masterAfter,
    },
  };
  printStagingImportReport(report);
  return report;
}
