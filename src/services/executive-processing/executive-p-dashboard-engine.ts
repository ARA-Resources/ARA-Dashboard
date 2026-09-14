import { EXECUTIVE_MASTER_EXCEL_HEADERS } from "@/services/persistence/executive-master-sheet-columns";
import type { ExcelCellValue, ExcelDataRow } from "@/types/excel";

/**
 * Minimal row shape the P - Dashboard engine reads, keyed by the Master
 * Sheet's own display header names (the same names
 * `executive-master-sheet-columns.ts` / `EXECUTIVE_MASTER_EXCEL_HEADERS`
 * use) — not the legacy XLSM source-header spelling this engine used before
 * the Lateral-pattern rebuild ("Primary skills", "Market", "Level", "Skill
 * category"). The one live producer is `toExecutivePDashboardInputRow()` in
 * `read-executive-master.ts`, which maps `executive_master` rows directly to
 * this shape — there is no XLSM caller left (confirmed before this rebuild).
 */
export interface ExecutivePDashboardInputRow {
  id?: string;
  "Primary Skills"?: ExcelCellValue;
  "Market Map"?: ExcelCellValue;
  "Job Management Level"?: ExcelCellValue;
  "Skill Categorization"?: ExcelCellValue;
  "Job Status"?: ExcelCellValue;
  Posted?: ExcelCellValue;
  Priority?: ExcelCellValue;
}

/**
 * Executive P - Dashboard — rebuilt to match Lateral's P-Roles pivot pattern.
 *
 * Row grouping: Primary Skills + Skill Categorization (2 dimensions, was 5 —
 * Market Map / Primary Location / Location Flex dropped from grouping; that
 * data stays visible/filterable on the Master Sheet page). Market Map stays
 * a *filter* dimension even though it's no longer a *grouping* dimension —
 * same relationship Lateral's own pivot has with Market Map.
 * Columns: Job Management Level, restricted to Executive's own 3 tiers
 * (5-Associate Director / 6-Senior Manager / 7-Manager) — never was
 * Lateral's 5-tier scale.
 * Values: Count of Job Requisition ID per Primary Skills × Skill
 * Categorization × Level combination, after filters (Job Status, Posted,
 * Market Map, Priority, Skill Categorization — the same 5 real filter
 * dimensions Lateral's own pivot respects) are applied.
 * Grand Total row/column: computed by the shared `OpeningsDataTable`
 * component from the plain group rows this module returns — no synthetic
 * "Grand Total" row is emitted here, mirroring
 * `lateral-p-roles-engine.ts`'s `pRolesResultToRows` exactly.
 */

export const EXECUTIVE_P_DASHBOARD_SHEET_NAME = "P - Dashboard";

/** Columns exposed on the old (pre-rebuild) 3-field toolbar schema — kept only for that legacy function until Stage 5 cleanup. */
export const EXECUTIVE_P_DASHBOARD_FILTER_COLUMNS = [
  "Priority",
  "Job Status",
  "Posted",
] as const;

export const EXECUTIVE_P_DASHBOARD_ROW_COLUMNS = [
  "Primary Skills",
  "Skill Categorization",
] as const;

export const EXECUTIVE_P_DASHBOARD_LEVEL_COLUMNS = [
  "5-Associate Director",
  "6-Senior Manager",
  "7-Manager",
] as const;

export type ExecutivePDashboardLevelColumn =
  (typeof EXECUTIVE_P_DASHBOARD_LEVEL_COLUMNS)[number];

export const EXECUTIVE_P_DASHBOARD_BLANK_LABEL = "(blank)";

export interface ExecutivePDashboardFilterSelection {
  priority: string[];
  jobStatus: string[];
  posted: string[];
  marketMap: string[];
  skillCategorization: string[];
}

export interface ExecutivePDashboardGroupRow {
  "Primary Skills": string;
  "Skill Categorization": string;
  "5-Associate Director": number;
  "6-Senior Manager": number;
  "7-Manager": number;
  detailCount: number;
}

export interface ExecutivePDashboardTotals {
  "5-Associate Director": number;
  "6-Senior Manager": number;
  "7-Manager": number;
  filteredDetailCount: number;
  canonicalTotal: number;
}

function asText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/ /g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeGroupToken(value: unknown): string {
  const text = asText(value);
  if (!text) return EXECUTIVE_P_DASHBOARD_BLANK_LABEL;
  return text.toLowerCase();
}

function displayGroupToken(value: unknown): string {
  const text = asText(value);
  if (!text) return EXECUTIVE_P_DASHBOARD_BLANK_LABEL;
  return text;
}

function matchesMultiSelect(cell: unknown, selected: string[]): boolean {
  if (!selected.length) return true;
  const cellText = asText(cell);
  if (!cellText) return false;
  const cellKey = cellText.toLowerCase();
  return selected.some((value) => value.toLowerCase() === cellKey);
}

export function extractExecutivePDashboardFilters(
  columnFilters?: Record<string, string[]>
): ExecutivePDashboardFilterSelection {
  const filters = columnFilters ?? {};
  const pick = (column: string) =>
    (filters[column] ?? []).map((value) => String(value)).filter(Boolean);

  return {
    priority: pick("Priority"),
    jobStatus: pick("Job Status"),
    posted: pick("Posted"),
    marketMap: pick("Market Map"),
    skillCategorization: pick("Skill Categorization"),
  };
}

export function applyExecutivePDashboardFilters<
  T extends ExecutivePDashboardInputRow,
>(rows: T[], filters: ExecutivePDashboardFilterSelection): T[] {
  return rows.filter((row) => {
    if (!matchesMultiSelect(row.Priority, filters.priority)) return false;
    if (!matchesMultiSelect(row["Job Status"], filters.jobStatus)) return false;
    if (!matchesMultiSelect(row.Posted, filters.posted)) return false;
    if (!matchesMultiSelect(row["Market Map"], filters.marketMap)) return false;
    if (
      !matchesMultiSelect(
        row["Skill Categorization"],
        filters.skillCategorization
      )
    )
      return false;
    return true;
  });
}

function emptyTotals(filteredDetailCount = 0): ExecutivePDashboardTotals {
  return {
    "5-Associate Director": 0,
    "6-Senior Manager": 0,
    "7-Manager": 0,
    filteredDetailCount,
    canonicalTotal: 0,
  };
}

function compareHierarchy(
  a: ExecutivePDashboardGroupRow,
  b: ExecutivePDashboardGroupRow
): number {
  for (const column of EXECUTIVE_P_DASHBOARD_ROW_COLUMNS) {
    const left = a[column].toLowerCase();
    const right = b[column].toLowerCase();
    const cmp = left.localeCompare(right, undefined, { sensitivity: "base" });
    if (cmp !== 0) return cmp;
  }
  return 0;
}

/**
 * Legacy (pre-rebuild) 3-column option collector — still backs
 * `getExecutivePDashboardFilterSchema()` in the service until that function
 * is retired in Stage 5. The live "All Filters" panel uses
 * `executive-dashboard-filter-schema.ts` instead (Stage 3).
 */
export function collectExecutivePDashboardFilterOptions(
  rows: ExecutivePDashboardInputRow[]
): Record<(typeof EXECUTIVE_P_DASHBOARD_FILTER_COLUMNS)[number], string[]> {
  const buckets: Record<string, Map<string, string>> = {};
  for (const column of EXECUTIVE_P_DASHBOARD_FILTER_COLUMNS) {
    buckets[column] = new Map();
  }

  for (const row of rows) {
    for (const column of EXECUTIVE_P_DASHBOARD_FILTER_COLUMNS) {
      const text = asText((row as Record<string, unknown>)[column]);
      if (!text) continue;
      const key = text.toLowerCase();
      if (!buckets[column].has(key)) buckets[column].set(key, text);
    }
  }

  const orderStatus = ["Active", "Closed"];
  const orderPosted = ["Yes", "-"];

  function ordered(column: string, values: string[]): string[] {
    if (column === "Job Status") {
      const preferred = orderStatus.filter((v) =>
        values.some((x) => x.toLowerCase() === v.toLowerCase())
      );
      const rest = values
        .filter(
          (v) => !preferred.some((p) => p.toLowerCase() === v.toLowerCase())
        )
        .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
      return [...preferred, ...rest];
    }
    if (column === "Posted") {
      const preferred = orderPosted.filter((v) =>
        values.some((x) => x.toLowerCase() === v.toLowerCase())
      );
      const rest = values
        .filter(
          (v) => !preferred.some((p) => p.toLowerCase() === v.toLowerCase())
        )
        .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
      return [...preferred, ...rest];
    }
    return [...values].sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: "base" })
    );
  }

  return {
    Priority: ordered("Priority", [...buckets.Priority.values()]),
    "Job Status": ordered("Job Status", [...buckets["Job Status"].values()]),
    Posted: ordered("Posted", [...buckets.Posted.values()]),
  };
}

/**
 * Aggregate filtered Master Sheet rows into P-Dashboard groups.
 * Level counts use exact string match only — no dirty Level normalization.
 */
export function buildExecutivePDashboardFromRows(
  rows: ExecutivePDashboardInputRow[],
  filters: ExecutivePDashboardFilterSelection
): {
  groups: ExecutivePDashboardGroupRow[];
  totals: ExecutivePDashboardTotals;
} {
  const filtered = applyExecutivePDashboardFilters(rows, filters);

  type Acc = {
    display: {
      "Primary Skills": string;
      "Skill Categorization": string;
    };
    "5-Associate Director": number;
    "6-Senior Manager": number;
    "7-Manager": number;
    detailCount: number;
  };

  const groups = new Map<string, Acc>();

  for (const row of filtered) {
    const display = {
      "Primary Skills": displayGroupToken(row["Primary Skills"]),
      "Skill Categorization": displayGroupToken(row["Skill Categorization"]),
    };
    const key = EXECUTIVE_P_DASHBOARD_ROW_COLUMNS.map((column) =>
      normalizeGroupToken(row[column])
    ).join(" ");

    let acc = groups.get(key);
    if (!acc) {
      acc = {
        display,
        "5-Associate Director": 0,
        "6-Senior Manager": 0,
        "7-Manager": 0,
        detailCount: 0,
      };
      groups.set(key, acc);
    }

    acc.detailCount += 1;
    const level = asText(row["Job Management Level"]);
    if (level === "5-Associate Director") acc["5-Associate Director"] += 1;
    else if (level === "6-Senior Manager") acc["6-Senior Manager"] += 1;
    else if (level === "7-Manager") acc["7-Manager"] += 1;
  }

  const groupRows: ExecutivePDashboardGroupRow[] = [...groups.values()].map(
    (acc) => ({
      ...acc.display,
      "5-Associate Director": acc["5-Associate Director"],
      "6-Senior Manager": acc["6-Senior Manager"],
      "7-Manager": acc["7-Manager"],
      detailCount: acc.detailCount,
    })
  );

  groupRows.sort(compareHierarchy);

  const totals = emptyTotals(filtered.length);
  for (const group of groupRows) {
    totals["5-Associate Director"] += group["5-Associate Director"];
    totals["6-Senior Manager"] += group["6-Senior Manager"];
    totals["7-Manager"] += group["7-Manager"];
  }
  totals.canonicalTotal =
    totals["5-Associate Director"] +
    totals["6-Senior Manager"] +
    totals["7-Manager"];

  return { groups: groupRows, totals };
}

/**
 * Convert aggregated groups to the openings-table shape. No synthetic Grand
 * Total row — `OpeningsDataTable` computes and renders that itself, the same
 * way it does for Lateral's P-Roles pivot.
 */
export function groupsToExecutivePDashboardTableRows(
  groups: ExecutivePDashboardGroupRow[]
): { headers: string[]; rows: ExcelDataRow[] } {
  const headers = [
    ...EXECUTIVE_P_DASHBOARD_ROW_COLUMNS,
    ...EXECUTIVE_P_DASHBOARD_LEVEL_COLUMNS,
  ];

  const rows: ExcelDataRow[] = groups.map((group, index) => ({
    id: `executive-p-dashboard-${index + 1}`,
    "Primary Skills": group["Primary Skills"],
    "Skill Categorization": group["Skill Categorization"],
    "5-Associate Director": group["5-Associate Director"] || null,
    "6-Senior Manager": group["6-Senior Manager"] || null,
    "7-Manager": group["7-Manager"] || null,
  }));

  return { headers: [...headers], rows };
}

/**
 * Validates against `EXECUTIVE_MASTER_EXCEL_HEADERS` (the live Postgres
 * `executive_master` display-header contract) — NOT
 * `EXECUTIVE_MASTER_LIVE_COLUMNS` (the old XLSM contract this engine used
 * before the Lateral-pattern rebuild, still spelled "Market" / "Primary
 * skills" / "Level" / "Skill category"). Checking against the old constant
 * here would always throw now that this engine's row shape uses the
 * Postgres display spelling instead.
 */
export function assertExecutivePDashboardContract(): void {
  const required = [
    "Priority",
    "Job Status",
    "Posted",
    "Market Map",
    ...EXECUTIVE_P_DASHBOARD_ROW_COLUMNS,
    "Job Management Level",
  ];
  for (const column of required) {
    if (
      !EXECUTIVE_MASTER_EXCEL_HEADERS.includes(
        column as (typeof EXECUTIVE_MASTER_EXCEL_HEADERS)[number]
      )
    ) {
      throw new Error(
        `Executive P-Dashboard requires Master Sheet column "${column}".`
      );
    }
  }
}
