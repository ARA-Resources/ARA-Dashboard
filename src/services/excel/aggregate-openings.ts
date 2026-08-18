import type { ExcelDataRow, ExcelCellValue } from "@/types/excel";
import type { BusinessUnitId } from "@/types/business-unit";

function asText(value: ExcelCellValue): string {
  if (value === null || value === undefined) return "";
  return String(value).replace(/\s+/g, " ").trim();
}

function findHeader(headers: string[], patterns: RegExp[]) {
  for (const pattern of patterns) {
    const match = headers.find((header) => pattern.test(header.trim()));
    if (match) return match;
  }
  return undefined;
}

/**
 * Sort job level labels by leading level number:
 * 8-Associate Manager → 9-Team Lead → 10-Senior Analyst → 11-Analyst
 * (localeCompare would put 10/11 before 8/9)
 */
function sortLevelLabels(levels: string[]) {
  return [...levels].sort((a, b) => {
    const numA = Number.parseInt(a.match(/^\d+/)?.[0] ?? "", 10);
    const numB = Number.parseInt(b.match(/^\d+/)?.[0] ?? "", 10);
    const hasA = Number.isFinite(numA);
    const hasB = Number.isFinite(numB);

    if (hasA && hasB && numA !== numB) return numA - numB;
    if (hasA && !hasB) return -1;
    if (!hasA && hasB) return 1;
    return a.localeCompare(b);
  });
}

/**
 * Rebuild a pivot-style openings table from Master Sheet detail rows.
 * Column names are derived from the file values (levels), not hardcoded lists.
 */
export function aggregateOpeningsFromDetail(
  businessUnitId: BusinessUnitId,
  headers: string[],
  rows: ExcelDataRow[]
): { headers: string[]; rows: ExcelDataRow[] } {
  if (businessUnitId === "consulting") {
    return { headers, rows };
  }

  const skillHeader =
    findHeader(headers, [/^primary\s*skills?$/i]) ??
    findHeader(headers, [/primary\s*skill/i]);
  const categoryHeader =
    findHeader(headers, [/^skill\s*categor/i]) ??
    findHeader(headers, [/categor/i]);
  const levelHeader =
    findHeader(headers, [/^job\s*management\s*level$/i]) ??
    findHeader(headers, [/^level$/i]);
  const marketHeader = findHeader(headers, [/^market$/i, /market\s*map/i]);
  const locationHeader = findHeader(headers, [
    /^primary\s*location/i,
    /^location/i,
  ]);
  const flexHeader = findHeader(headers, [/location\s*flex/i]);

  if (!skillHeader || !levelHeader) {
    return { headers, rows };
  }

  const levelValues = new Set<string>();
  for (const row of rows) {
    const level = asText(row[levelHeader]);
    if (level) levelValues.add(level);
  }

  const levels = sortLevelLabels([...levelValues]);

  type Agg = {
    dimensions: Record<string, string>;
    counts: Record<string, number>;
    total: number;
  };

  const groups = new Map<string, Agg>();

  for (const row of rows) {
    const skill = asText(row[skillHeader]);
    if (!skill || /^grand\s*total$/i.test(skill)) continue;

    const level = asText(row[levelHeader]);
    const dimensions: Record<string, string> = {
      [skillHeader]: skill,
    };

    if (businessUnitId === "lateral" && categoryHeader) {
      dimensions[categoryHeader] = asText(row[categoryHeader]) || "—";
    }

    if (businessUnitId === "executive") {
      if (marketHeader) dimensions[marketHeader] = asText(row[marketHeader]) || "—";
      if (locationHeader)
        dimensions[locationHeader] = asText(row[locationHeader]) || "—";
      if (flexHeader) dimensions[flexHeader] = asText(row[flexHeader]) || "—";
      if (categoryHeader)
        dimensions[categoryHeader] = asText(row[categoryHeader]) || "—";
    }

    const key = JSON.stringify(dimensions);
    const existing = groups.get(key) ?? {
      dimensions,
      counts: {},
      total: 0,
    };

    if (level) {
      existing.counts[level] = (existing.counts[level] ?? 0) + 1;
    }
    existing.total += 1;
    groups.set(key, existing);
  }

  const dimensionHeaders =
    businessUnitId === "executive"
      ? [
          skillHeader,
          ...(marketHeader ? [marketHeader] : []),
          ...(locationHeader ? [locationHeader] : []),
          ...(flexHeader ? [flexHeader] : []),
          ...(categoryHeader ? [categoryHeader] : []),
        ]
      : [skillHeader, ...(categoryHeader ? [categoryHeader] : [])];

  const outputHeaders = [...dimensionHeaders, ...levels, "Grand Total"];

  const outputRows: ExcelDataRow[] = [...groups.values()].map((group, index) => {
    const row: ExcelDataRow = {
      id: `${businessUnitId}-agg-${index + 1}`,
    };

    for (const header of dimensionHeaders) {
      row[header] = group.dimensions[header] ?? null;
    }
    for (const level of levels) {
      row[level] = group.counts[level] ?? null;
    }
    row["Grand Total"] = group.total;
    return row;
  });

  return { headers: outputHeaders, rows: outputRows };
}
