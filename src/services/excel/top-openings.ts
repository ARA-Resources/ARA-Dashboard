/**
 * Rank and select Top N openings from dynamically parsed Excel rows.
 * Uses file headers — no hardcoded column names required.
 */
export type ExcelRow = Record<string, string | number | null>;

function priorityScore(value: string | number | null): number {
  if (value === null) return 0;
  const text = String(value).trim().toUpperCase();
  if (text === "P1" || text === "HIGH" || text === "1") return 300;
  if (text === "P2" || text === "MEDIUM" || text === "2") return 200;
  if (text === "P3" || text === "LOW" || text === "3") return 100;
  const match = text.match(/^P(\d+)$/);
  if (match) return Math.max(0, 400 - Number(match[1]) * 50);
  return 0;
}

function findTotalHeader(headers: string[]): string | null {
  const exact = headers.find((header) =>
    /^(grand\s*total|total|openings|count)$/i.test(header.trim())
  );
  if (exact) return exact;

  const fuzzy = headers.find((header) =>
    /grand\s*total|openings/i.test(header)
  );
  return fuzzy ?? null;
}

function isLikelyDimensionHeader(header: string) {
  return /skill|market|location|categor|flex|primary|requisition|job|posted|priority|map|name|id/i.test(
    header
  );
}

function scoreRow(row: ExcelRow, headers: string[], totalHeader: string | null) {
  if (totalHeader) {
    const value = row[totalHeader];
    if (typeof value === "number") return value;
    if (typeof value === "string" && value.trim() && !Number.isNaN(Number(value))) {
      return Number(value);
    }
  }

  const numericSum = headers.reduce((sum, header) => {
    if (header === "id") return sum;
    if (isLikelyDimensionHeader(header)) return sum;
    const value = row[header];
    if (typeof value === "number") return sum + value;
    if (typeof value === "string" && value.trim() && !Number.isNaN(Number(value))) {
      return sum + Number(value);
    }
    return sum;
  }, 0);

  if (numericSum > 0) return numericSum;

  const priorityHeader = headers.find((header) => /priority/i.test(header));
  if (priorityHeader) {
    return priorityScore(row[priorityHeader]);
  }

  return 0;
}

export function selectTopOpenings(
  headers: string[],
  rows: ExcelRow[],
  limit = 10
): ExcelRow[] {
  if (rows.length <= limit) return rows;

  const totalHeader = findTotalHeader(headers);
  const ranked = rows
    .map((row, index) => ({
      row,
      index,
      score: scoreRow(row, headers, totalHeader),
    }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.index - b.index;
    });

  return ranked.slice(0, limit).map((item) => item.row);
}
