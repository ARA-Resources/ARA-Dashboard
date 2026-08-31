import {
  CONSULTING_FILTER_DEFAULTS,
  createBaseConsultingFilters,
} from "../../constants/consulting.js";
import type { ExcelOpeningsResult, ExcelReaderOptions } from "../../types/excel.js";
import type { OpeningsFilters } from "../../types/filters.js";
import type { DynamicFilterSchema } from "./discover-filters.js";
import {
  applyColumnFilters,
  applySortAndTopN,
  hasActiveColumnFilters,
} from "./apply-filters.js";
import { discoverFilterFields } from "./discover-filters.js";
import { readConsultingSheet } from "./consulting-reader.js";

function resolveFilters(filters?: Partial<OpeningsFilters>): OpeningsFilters {
  const base = createBaseConsultingFilters();
  if (!filters) return base;
  return {
    columnFilters: filters.columnFilters ?? base.columnFilters,
    sortBy: filters.sortBy === undefined ? base.sortBy : filters.sortBy,
    sortDirection: filters.sortDirection ?? base.sortDirection,
    topN: filters.topN === undefined ? base.topN : filters.topN,
  };
}

function resolveDefaultsFromSchema(
  schema: DynamicFilterSchema,
  resultHeaders: string[] = []
): OpeningsFilters {
  const columnFilters: Record<string, string[]> = {};

  const statusField = schema.fields.find((field) =>
    /job\s*status/i.test(field.column)
  );
  if (statusField) {
    const matched = pickExactValues(
      statusField.values,
      CONSULTING_FILTER_DEFAULTS.preferredStatusValues
    );
    if (matched.length > 0) {
      columnFilters[statusField.column] = matched;
    }
  }

  const postedField = schema.fields.find((field) => /^posted$/i.test(field.column));
  if (postedField) {
    const matched = pickExactValues(
      postedField.values,
      CONSULTING_FILTER_DEFAULTS.preferredPostedValues
    );
    if (matched.length > 0) {
      columnFilters[postedField.column] = matched;
    }
  }

  let sortBy: string | null = null;
  const sortHeaders =
    resultHeaders.length > 0 ? resultHeaders : ["Grand Total"];
  for (const pattern of CONSULTING_FILTER_DEFAULTS.sortByPatterns) {
    const hit = sortHeaders.find((header) => pattern.test(header));
    if (hit) {
      sortBy = hit;
      break;
    }
  }

  return {
    columnFilters,
    sortBy,
    sortDirection: CONSULTING_FILTER_DEFAULTS.sortDirection,
    topN: CONSULTING_FILTER_DEFAULTS.topN,
  };
}

function pickExactValues(allValues: string[], preferred: string[]) {
  const matched: string[] = [];
  const seen = new Set<string>();
  for (const wanted of preferred) {
    const hit = allValues.find(
      (value) => value.toLowerCase() === wanted.toLowerCase()
    );
    const chosen = hit ?? wanted;
    const key = chosen.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    matched.push(chosen);
  }
  return matched;
}

export async function readConsultingTopOpenings(
  filters?: Partial<OpeningsFilters>,
  options?: ExcelReaderOptions
): Promise<ExcelOpeningsResult> {
  const resolved = resolveFilters(filters);
  const full = await readConsultingSheet(options);
  const filtered = applyColumnFilters(full.rows, resolved.columnFilters);
  const filteredDetailCount = filtered.length;

  let headers = full.headers;
  let rows = filtered;
  let sheetName = full.sheetName;
  const baseMeta = full.meta;
  const sourceFile = full.sourceFile;
  const sourceLabel = full.sourceLabel;

  if (!resolved.sortBy) {
    const defaults = resolveDefaultsFromSchema(
      {
        businessUnitId: "consulting",
        sheetName,
        sourceFile,
        fields: discoverFilterFields(headers, rows),
      },
      headers
    );
    if (defaults.sortBy) resolved.sortBy = defaults.sortBy;
  }

  const ranked = applySortAndTopN(headers, rows, resolved).map((row, index) => ({
    ...row,
    id: String(row.id ?? `consulting-top-${index + 1}`),
  }));

  return {
    businessUnitId: "consulting",
    sheetName,
    sourceFile,
    sourceLabel,
    headers,
    rows: ranked,
    appliedFilters: resolved,
    meta: {
      ...baseMeta,
      name: sheetName,
      rowCount: ranked.length,
      columnCount: headers.length,
      totalRows: rows.length,
      filteredDetailCount,
      topN: resolved.topN ?? undefined,
      hasColumnFilters: hasActiveColumnFilters(resolved.columnFilters),
    },
  };
}
