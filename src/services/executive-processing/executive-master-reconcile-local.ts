/**
 * Local XLSM dry-run helpers (no server-only) — usable from CLI scripts.
 * Never writes Master Sheet.
 */

import ExcelJS from "exceljs";
import fs from "node:fs/promises";
import { EXECUTIVE_NEW_SHEET_NAME } from "@/services/dataset/executive-dataset-mapping";
import { resolveReadableExcelPath } from "@/services/excel/readable-workbook";
import {
  assertConfiguredExecutiveExcelPath,
  getBundledExecutiveExcelPath,
  getExecutiveExcelPath,
} from "@/lib/config/runtime";
import { parseWorksheet } from "@/services/excel/parse-sheet";
import {
  EXECUTIVE_MASTER_HEADER_ROW,
  EXECUTIVE_MASTER_SHEET_NAME,
  projectExecutiveMasterLiveColumns,
  type ExecutiveMasterSheetRow,
} from "@/services/excel/executive-master-sheet";
import { EXECUTIVE_POSTED_SHEET_NAME } from "@/services/executive-processing/executive-posted-rules";
import {
  runExecutiveMasterReconcileDryRun,
  type ExecutiveNewSheetRow,
  type ExecutivePostedSheetRow,
  type ExecutiveReconcileDryRunResult,
} from "@/services/executive-processing/executive-master-reconcile-engine";

export async function resolveExecutiveWorkbookReadablePath(): Promise<string> {
  assertConfiguredExecutiveExcelPath();
  const local = getExecutiveExcelPath();
  if (local) {
    return resolveReadableExcelPath(local);
  }
  return resolveReadableExcelPath(getBundledExecutiveExcelPath());
}

async function loadWorkbook(): Promise<ExcelJS.Workbook> {
  const readable = await resolveExecutiveWorkbookReadablePath();
  await fs.access(readable);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(readable);
  return workbook;
}

function requireSheet(workbook: ExcelJS.Workbook, name: string) {
  const sheet =
    workbook.worksheets.find(
      (item) => item.name.trim().toLowerCase() === name.trim().toLowerCase()
    ) ?? null;
  if (!sheet) {
    throw new Error(
      `Sheet "${name}" not found. Available: ${workbook.worksheets
        .map((s) => s.name)
        .join(", ")}`
    );
  }
  return sheet;
}

export async function readExecutivePostedSheetRowsFromWorkbook(
  workbook?: ExcelJS.Workbook
): Promise<ExecutivePostedSheetRow[]> {
  const wb = workbook ?? (await loadWorkbook());
  const sheet = requireSheet(wb, EXECUTIVE_POSTED_SHEET_NAME);

  const rows: ExecutivePostedSheetRow[] = [];
  const maxRow = sheet.rowCount || 1;
  for (let r = 2; r <= maxRow; r += 1) {
    const row = sheet.getRow(r);
    const postingText = row.getCell(1).value;
    const jobRequisitionId = row.getCell(2).value;
    const a =
      postingText === null || postingText === undefined
        ? ""
        : String(postingText);
    const b =
      jobRequisitionId === null || jobRequisitionId === undefined
        ? ""
        : String(jobRequisitionId);
    if (!a.trim() && !b.trim()) continue;
    rows.push({ postingText: a, jobRequisitionId: b });
  }
  return rows;
}

function readNewSheetRowsFromWorkbook(
  workbook: ExcelJS.Workbook
): ExecutiveNewSheetRow[] {
  const newSheet = requireSheet(workbook, EXECUTIVE_NEW_SHEET_NAME);
  const headerRow = newSheet.getRow(1);
  const headers: string[] = [];
  headerRow.eachCell({ includeEmpty: true }, (cell, col) => {
    headers[col - 1] =
      cell.value === null || cell.value === undefined
        ? ""
        : String(cell.value).trim();
  });

  const newSheetRows: ExecutiveNewSheetRow[] = [];
  const maxRow = newSheet.rowCount || 1;
  for (let r = 2; r <= maxRow; r += 1) {
    const row = newSheet.getRow(r);
    const record: ExecutiveNewSheetRow = { id: `local-new-${r}` };
    let hasAny = false;
    for (let c = 0; c < headers.length; c += 1) {
      const header = headers[c];
      if (!header) continue;
      const value = row.getCell(c + 1).value;
      if (value !== null && value !== undefined && String(value).trim() !== "") {
        hasAny = true;
      }
      record[header] =
        value === null || value === undefined
          ? null
          : typeof value === "object"
            ? String(value)
            : value;
    }
    if (hasAny) newSheetRows.push(record);
  }
  return newSheetRows;
}

function readMasterRowsFromWorkbook(
  workbook: ExcelJS.Workbook
): { sheetName: string; rows: ExecutiveMasterSheetRow[] } {
  const sheet = requireSheet(workbook, EXECUTIVE_MASTER_SHEET_NAME);
  const parsed = parseWorksheet(sheet, {
    headerRow: EXECUTIVE_MASTER_HEADER_ROW,
  });
  const projected = projectExecutiveMasterLiveColumns(
    parsed.headers,
    parsed.rows.map((row, index) => ({
      id: `executive-local-master-${index + 1}`,
      ...row,
    }))
  );
  return { sheetName: parsed.sheetName, rows: projected.rows };
}

export async function runExecutiveMasterReconcileDryRunFromLocalWorkbook(): Promise<
  ExecutiveReconcileDryRunResult & {
    sources: {
      newSheet: string;
      masterSheet: string;
      postedSheet: string;
      workbookKind: "local-xlsm";
    };
  }
> {
  const workbook = await loadWorkbook();
  const newSheetRows = readNewSheetRowsFromWorkbook(workbook);
  const master = readMasterRowsFromWorkbook(workbook);
  const postedSheetRows = await readExecutivePostedSheetRowsFromWorkbook(
    workbook
  );

  const result = runExecutiveMasterReconcileDryRun({
    masterRows: master.rows,
    newSheetRows,
    postedSheetRows,
  });

  return {
    ...result,
    notes: [
      ...result.notes,
      "Source mode: local XLSM New Sheet (not Google Spreadsheet).",
    ],
    sources: {
      newSheet: EXECUTIVE_NEW_SHEET_NAME,
      masterSheet: master.sheetName,
      postedSheet: EXECUTIVE_POSTED_SHEET_NAME,
      workbookKind: "local-xlsm",
    },
  };
}
