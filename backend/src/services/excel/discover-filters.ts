import type { ExcelCellValue, ExcelDataRow } from "../../types/excel.js";
import { polishExcelDisplayValue } from "../../utils/excel-display.js";

export interface DynamicFilterField {
  column: string;
  values: string[];
  valueCount: number;
  kind: "categorical" | "numeric";
}

export interface DynamicFilterSchema {
  businessUnitId: string;
  sheetName: string;
  sourceFile: string;
  fields: DynamicFilterField[];
}

const MAX_UNIQUE_VALUES = 150;
const MIN_UNIQUE_VALUES = 2;

function asText(value: ExcelCellValue): string {
  if (value === null || value === undefined) return "";
  return String(value).replace(/\s+/g, " ").trim();
}

function collectColumnStats(header: string, rows: ExcelDataRow[]) {
  const counts = new Map<string, { label: string; count: number }>();
  let nonNull = 0;
  let numericCount = 0;

  for (const row of rows) {
    const raw = row[header];
    if (raw === null || raw === undefined || raw === "") continue;
    nonNull += 1;
    if (typeof raw === "number") numericCount += 1;
    const text = asText(raw);
    if (!text) continue;
    const label = polishExcelDisplayValue(text);
    const key = label.toLowerCase();
    const existing = counts.get(key);
    counts.set(key, {
      label: existing?.label ?? label,
      count: (existing?.count ?? 0) + 1,
    });
  }

  const values = [...counts.values()]
    .map((entry) => entry.label)
    .sort((a, b) => a.localeCompare(b));
  return { values, nonNull, numericCount, unique: values.length };
}

export function isFilterableColumn(header: string, rows: ExcelDataRow[]): boolean {
  if (!header || header === "id") return false;

  const { values, nonNull, numericCount, unique } = collectColumnStats(
    header,
    rows
  );

  if (nonNull === 0) return false;
  if (unique < MIN_UNIQUE_VALUES) return false;
  if (unique > MAX_UNIQUE_VALUES) return false;

  const uniqueness = unique / nonNull;
  if (uniqueness > 0.85 && unique > 30) return false;

  const avgLength =
    values.reduce((sum, value) => sum + value.length, 0) / Math.max(unique, 1);
  if (avgLength > 80 && unique > 20) return false;

  const numericRatio = numericCount / nonNull;
  if (numericRatio > 0.9 && unique > 40) return false;

  return true;
}

export function discoverFilterFields(
  headers: string[],
  rows: ExcelDataRow[]
): DynamicFilterField[] {
  const fields: DynamicFilterField[] = [];

  for (const header of headers) {
    if (!isFilterableColumn(header, rows)) continue;

    const { nonNull, numericCount, unique } = collectColumnStats(header, rows);
    const numericRatio = nonNull === 0 ? 0 : numericCount / nonNull;
    const { values } = collectColumnStats(header, rows);

    fields.push({
      column: header,
      values,
      valueCount: unique,
      kind: numericRatio > 0.7 ? "numeric" : "categorical",
    });
  }

  return fields.sort(
    (a, b) => headers.indexOf(a.column) - headers.indexOf(b.column)
  );
}
