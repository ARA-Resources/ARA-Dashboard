import type { BusinessUnitId } from "@/types/business-unit";
import type { OpeningsFilters } from "@/types/filters";
import type { DynamicFilterSchema } from "@/services/excel/discover-filters";

/**
 * Structural defaults only — column *names* always come from Excel schema.
 * Preferred *values* are matched case-insensitively against discovered options.
 */
export interface OpeningsFilterDefaults {
  /** Preferred result sort column patterns (matched against result headers) */
  sortByPatterns: RegExp[];
  sortDirection: OpeningsFilters["sortDirection"];
  topN: number | null;
  /** Preferred Job Status values */
  preferredStatusValues: string[];
  /** Preferred Posted values (Yes) */
  preferredPostedValues: string[];
}

export const DEFAULT_FILTER_CONFIG: Record<BusinessUnitId, OpeningsFilterDefaults> =
  {
    lateral: {
      sortByPatterns: [/^grand\s*total$/i, /total/i],
      sortDirection: "desc",
      topN: 10,
      preferredStatusValues: ["Active", "Reopen", "New"],
      preferredPostedValues: ["Yes"],
    },
    executive: {
      sortByPatterns: [],
      sortDirection: "asc",
      topN: null,
      preferredStatusValues: ["Active"],
      preferredPostedValues: [],
    },
    consulting: {
      sortByPatterns: [],
      sortDirection: "desc",
      topN: 10,
      preferredStatusValues: ["Active", "New"],
      preferredPostedValues: ["Yes"],
    },
  };

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

function findJobStatusField(schema: DynamicFilterSchema) {
  const byName = schema.fields.find((field) =>
    /job\s*status/i.test(field.column)
  );
  if (byName) return byName;

  // Prefer a status-like column that actually contains Active and/or New
  return (
    schema.fields.find((field) => {
      const values = field.values.map((value) => value.toLowerCase());
      const looksLikeStatus = /status/i.test(field.column);
      return (
        looksLikeStatus &&
        (values.includes("active") || values.includes("new"))
      );
    }) ?? null
  );
}

function findPostedField(schema: DynamicFilterSchema) {
  const byName = schema.fields.find((field) => /^posted$/i.test(field.column));
  if (byName) return byName;

  return (
    schema.fields.find((field) => {
      const values = field.values.map((value) => value.toLowerCase());
      return /posted/i.test(field.column) && values.some((v) => v === "yes");
    }) ?? null
  );
}

export function cloneOpeningsFilters(filters: OpeningsFilters): OpeningsFilters {
  const columnFilters: Record<string, string[]> = {};
  for (const [column, values] of Object.entries(filters.columnFilters)) {
    columnFilters[column] = [...values];
  }
  return {
    columnFilters,
    sortBy: filters.sortBy,
    sortDirection: filters.sortDirection,
    topN: filters.topN,
  };
}

export function createEmptyOpeningsFilters(): OpeningsFilters {
  return {
    columnFilters: {},
    sortBy: null,
    sortDirection: "desc",
    topN: null,
  };
}

export function createBaseOpeningsFilters(
  businessUnitId: BusinessUnitId
): OpeningsFilters {
  const config = DEFAULT_FILTER_CONFIG[businessUnitId];
  return {
    columnFilters: {},
    sortBy: null,
    sortDirection: config.sortDirection,
    topN: config.topN,
  };
}

/**
 * Resolve default column selections + sort from the live Excel schema / result headers.
 * Targets Job Status + Posted specifically so unrelated columns (e.g. "Opened on Oorwin")
 * are not polluted with Active/New defaults.
 */
export function resolveDefaultsFromSchema(
  businessUnitId: BusinessUnitId,
  schema: DynamicFilterSchema,
  resultHeaders: string[] = []
): OpeningsFilters {
  const config = DEFAULT_FILTER_CONFIG[businessUnitId];
  const columnFilters: Record<string, string[]> = {};

  const statusField = findJobStatusField(schema);
  if (statusField) {
    const matched = pickExactValues(
      statusField.values,
      config.preferredStatusValues
    );
    if (matched.length > 0) {
      columnFilters[statusField.column] = matched;
    }
  }

  const postedField = findPostedField(schema);
  if (postedField) {
    const matched = pickExactValues(
      postedField.values,
      config.preferredPostedValues
    );
    if (matched.length > 0) {
      columnFilters[postedField.column] = matched;
    }
  }

  let sortBy: string | null = null;
  const sortHeaders =
    resultHeaders.length > 0 ? resultHeaders : ["Grand Total"];
  for (const pattern of config.sortByPatterns) {
    const hit = sortHeaders.find((header) => pattern.test(header));
    if (hit) {
      sortBy = hit;
      break;
    }
  }

  return {
    columnFilters,
    sortBy,
    sortDirection: config.sortDirection,
    topN: config.topN,
  };
}

export function openingsFiltersEqual(
  a: OpeningsFilters,
  b: OpeningsFilters
): boolean {
  if (a.sortBy !== b.sortBy) return false;
  if (a.sortDirection !== b.sortDirection) return false;
  if (a.topN !== b.topN) return false;

  const aKeys = Object.keys(a.columnFilters).sort();
  const bKeys = Object.keys(b.columnFilters).sort();
  if (aKeys.length !== bKeys.length) return false;
  if (!aKeys.every((key, index) => key === bKeys[index])) return false;

  return aKeys.every((key) => {
    const left = [...(a.columnFilters[key] ?? [])].sort();
    const right = [...(b.columnFilters[key] ?? [])].sort();
    if (left.length !== right.length) return false;
    return left.every((value, index) => value === right[index]);
  });
}

/** @deprecated use createBaseOpeningsFilters + resolveDefaultsFromSchema */
export function getDefaultOpeningsFilters(
  businessUnitId: BusinessUnitId
): OpeningsFilters {
  return createBaseOpeningsFilters(businessUnitId);
}
