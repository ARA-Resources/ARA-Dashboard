import ExcelJS from "exceljs";
import type { ExcelCellValue, ExcelDataRow } from "@/types/excel";

function cellValue(value: ExcelCellValue): string | number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return value;
  const text = String(value);
  return text.length ? text : null;
}

function colLetter(index1Based: number): string {
  let n = index1Based;
  let s = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/**
 * Build an .xlsx workbook: row 1 = headers, remaining rows = data, AutoFilter on.
 */
export async function buildMasterSheetXlsxBuffer(options: {
  sheetName?: string;
  headers: string[];
  rows: ExcelDataRow[];
}): Promise<Buffer> {
  const headers = options.headers.filter(Boolean);
  if (headers.length === 0) {
    throw new Error("Cannot export Master Sheet without headers.");
  }

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "ARA Dashboard";
  workbook.created = new Date();

  const sheetName = (options.sheetName || "Master Sheet").slice(0, 31);
  const worksheet = workbook.addWorksheet(sheetName);

  worksheet.addRow(headers);
  const headerRow = worksheet.getRow(1);
  headerRow.font = { bold: true, color: { argb: "FFFFFFFF" } };
  headerRow.fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FF2563EB" },
  };
  headerRow.alignment = { vertical: "middle", wrapText: true };
  headerRow.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF2563EB" },
    };
  });

  for (const row of options.rows) {
    worksheet.addRow(headers.map((header) => cellValue(row[header] ?? null)));
  }

  const lastCol = colLetter(headers.length);
  const lastRow = Math.max(1, options.rows.length + 1);
  worksheet.autoFilter = {
    from: "A1",
    to: `${lastCol}${lastRow}`,
  };
  worksheet.views = [{ state: "frozen", ySplit: 1 }];

  for (let i = 1; i <= headers.length; i += 1) {
    const column = worksheet.getColumn(i);
    const header = headers[i - 1] || "";
    const sample = options.rows.slice(0, 50).map((row) =>
      String(row[header] ?? "")
    );
    const maxLen = Math.max(
      header.length,
      ...sample.map((value) => value.length)
    );
    column.width = Math.min(48, Math.max(12, maxLen + 2));
  }

  const arrayBuffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}
