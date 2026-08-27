import ExcelJS from "exceljs";
import {
  EXECUTIVE_BASE_DS_SHEET_NAME,
  validateExecutiveBaseDsHeaders,
  type ExecutiveCellValue,
} from "@/services/dataset/executive-dataset-mapping";

export interface ExecutiveBaseDsReadResult {
  sheetName: string;
  headers: string[];
  rows: ExecutiveCellValue[][];
  rowCount: number;
  jobRequisitionIdCount: number;
}

function cellToValue(cell: ExcelJS.Cell): ExecutiveCellValue {
  const value = cell.value;
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return value.toISOString();
  }
  if (typeof value === "object") {
    // ExcelJS rich text / formula / hyperlink
    const anyVal = value as {
      text?: string;
      result?: unknown;
      richText?: Array<{ text?: string }>;
      hyperlink?: string;
    };
    if (Array.isArray(anyVal.richText)) {
      return anyVal.richText.map((part) => part.text ?? "").join("");
    }
    if (anyVal.result !== undefined && anyVal.result !== null) {
      if (
        typeof anyVal.result === "string" ||
        typeof anyVal.result === "number" ||
        typeof anyVal.result === "boolean"
      ) {
        return anyVal.result;
      }
      return String(anyVal.result);
    }
    if (typeof anyVal.text === "string") return anyVal.text;
  }
  return String(value);
}

/**
 * Read Base DS only from an Executive DS .xlsx buffer.
 * Does not modify the workbook.
 */
export async function readExecutiveBaseDsFromBuffer(
  buffer: Buffer
): Promise<ExecutiveBaseDsReadResult> {
  if (!buffer?.length) {
    throw new Error("Executive DS workbook buffer is empty.");
  }

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(
    Buffer.from(buffer) as unknown as Parameters<ExcelJS.Xlsx["load"]>[0]
  );

  const sheet =
    workbook.worksheets.find(
      (item) =>
        item.name.trim().toLowerCase() ===
        EXECUTIVE_BASE_DS_SHEET_NAME.toLowerCase()
    ) ?? null;

  if (!sheet) {
    const available = workbook.worksheets.map((item) => item.name).join(", ");
    throw new Error(
      `Base DS sheet not found. Available sheets: ${available || "(none)"}`
    );
  }

  const matrix: ExecutiveCellValue[][] = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const values: ExecutiveCellValue[] = [];
    const count = Math.max(row.cellCount, sheet.columnCount || 0);
    for (let col = 1; col <= count; col += 1) {
      values.push(cellToValue(row.getCell(col)));
    }
    // Trim trailing empties
    while (values.length > 0 && (values[values.length - 1] === null || values[values.length - 1] === "")) {
      values.pop();
    }
    if (values.some((v) => v !== null && String(v).trim() !== "")) {
      matrix.push(values);
    }
  });

  if (matrix.length === 0) {
    throw new Error("Base DS has no header row.");
  }

  const headers = matrix[0].map((cell) =>
    cell === null || cell === undefined ? "" : String(cell).replace(/\u00a0/g, " ").trim()
  );
  const headerCheck = validateExecutiveBaseDsHeaders(headers);
  if (!headerCheck.ok) {
    throw new Error(
      `Base DS is missing required headers: ${headerCheck.missing.join(", ")}`
    );
  }

  const dataRows = matrix.slice(1);
  if (dataRows.length === 0) {
    throw new Error("Base DS has no data rows.");
  }

  const jrIndex = headers.findIndex(
    (header) => header.toLowerCase() === "job requisition id"
  );
  let jobRequisitionIdCount = 0;
  for (const row of dataRows) {
    const value = jrIndex >= 0 ? row[jrIndex] : null;
    if (value !== null && value !== undefined && String(value).trim() !== "") {
      jobRequisitionIdCount += 1;
    }
  }
  if (jobRequisitionIdCount === 0) {
    throw new Error("Base DS has no Job Requisition ID values.");
  }

  // Normalize row widths to header length
  const rows = dataRows.map((row) => {
    const next = [...row];
    while (next.length < headers.length) next.push(null);
    return next.slice(0, headers.length);
  });

  return {
    sheetName: sheet.name,
    headers,
    rows,
    rowCount: rows.length,
    jobRequisitionIdCount,
  };
}
