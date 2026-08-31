import {
  EXECUTIVE_MASTER_LIVE_COLUMNS,
  type ExecutiveMasterSheetRow,
} from "./executive-master-sheet.js";
import type { ExcelDataRow } from "../../types/excel.js";

export const EXECUTIVE_P_DASHBOARD_SHEET_NAME = "P - Dashboard";

export const EXECUTIVE_P_DASHBOARD_FILTER_COLUMNS = [
  "Team Member 1",
  "Priority",
  "Job Status",
  "Posted",
] as const;

export const EXECUTIVE_P_DASHBOARD_ROW_COLUMNS = [
  "Primary skills",
  "Market",
  "Primary Location",
  "Location Flex",
  "Skill category",
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
  teamMember1: string[];
  priority: string[];
  jobStatus: string[];
  posted: string[];
}

export interface ExecutivePDashboardGroupRow {
  "Primary skills": string;
  Market: string;
  "Primary Location": string;
  "Location Flex": string;
  "Skill category": string;
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
    .replace(/\u00a0/g, " ")
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
    teamMember1: pick("Team Member 1"),
    priority: pick("Priority"),
    jobStatus: pick("Job Status"),
    posted: pick("Posted"),
  };
}

export function applyExecutivePDashboardFilters(
  rows: ExecutiveMasterSheetRow[],
  filters: ExecutivePDashboardFilterSelection
): ExecutiveMasterSheetRow[] {
  return rows.filter((row) => {
    if (!matchesMultiSelect(row["Team Member 1"], filters.teamMember1)) {
      return false;
    }
    if (!matchesMultiSelect(row.Priority, filters.priority)) return false;
    if (!matchesMultiSelect(row["Job Status"], filters.jobStatus)) return false;
    if (!matchesMultiSelect(row.Posted, filters.posted)) return false;
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

export function collectExecutivePDashboardFilterOptions(
  rows: ExecutiveMasterSheetRow[]
): Record<(typeof EXECUTIVE_P_DASHBOARD_FILTER_COLUMNS)[number], string[]> {
  const buckets: Record<string, Map<string, string>> = {};
  for (const column of EXECUTIVE_P_DASHBOARD_FILTER_COLUMNS) {
    buckets[column] = new Map();
  }

  for (const row of rows) {
    for (const column of EXECUTIVE_P_DASHBOARD_FILTER_COLUMNS) {
      const text = asText(row[column]);
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
    "Team Member 1": ordered(
      "Team Member 1",
      [...buckets["Team Member 1"].values()]
    ),
    Priority: ordered("Priority", [...buckets.Priority.values()]),
    "Job Status": ordered("Job Status", [...buckets["Job Status"].values()]),
    Posted: ordered("Posted", [...buckets.Posted.values()]),
  };
}

export function buildExecutivePDashboardFromRows(
  rows: ExecutiveMasterSheetRow[],
  filters: ExecutivePDashboardFilterSelection
): {
  groups: ExecutivePDashboardGroupRow[];
  totals: ExecutivePDashboardTotals;
} {
  const filtered = applyExecutivePDashboardFilters(rows, filters);

  type Acc = {
    display: {
      "Primary skills": string;
      Market: string;
      "Primary Location": string;
      "Location Flex": string;
      "Skill category": string;
    };
    "5-Associate Director": number;
    "6-Senior Manager": number;
    "7-Manager": number;
    detailCount: number;
  };

  const groups = new Map<string, Acc>();

  for (const row of filtered) {
    const display = {
      "Primary skills": displayGroupToken(row["Primary skills"]),
      Market: displayGroupToken(row.Market),
      "Primary Location": displayGroupToken(row["Primary Location"]),
      "Location Flex": displayGroupToken(row["Location Flex"]),
      "Skill category": displayGroupToken(row["Skill category"]),
    };
    const key = EXECUTIVE_P_DASHBOARD_ROW_COLUMNS.map((column) =>
      normalizeGroupToken(row[column])
    ).join("\u0000");

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
    const level = asText(row.Level);
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

export function groupsToExecutivePDashboardTableRows(
  groups: ExecutivePDashboardGroupRow[],
  totals: ExecutivePDashboardTotals
): { headers: string[]; rows: ExcelDataRow[] } {
  const headers = [
    ...EXECUTIVE_P_DASHBOARD_ROW_COLUMNS,
    ...EXECUTIVE_P_DASHBOARD_LEVEL_COLUMNS,
  ];

  const rows: ExcelDataRow[] = groups.map((group, index) => ({
    id: `executive-p-dashboard-${index + 1}`,
    "Primary skills": group["Primary skills"],
    Market: group.Market,
    "Primary Location": group["Primary Location"],
    "Location Flex": group["Location Flex"],
    "Skill category": group["Skill category"],
    "5-Associate Director": group["5-Associate Director"] || null,
    "6-Senior Manager": group["6-Senior Manager"] || null,
    "7-Manager": group["7-Manager"] || null,
  }));

  rows.push({
    id: "executive-p-dashboard-grand-total",
    "Primary skills": "Grand Total",
    Market: null,
    "Primary Location": null,
    "Location Flex": null,
    "Skill category": null,
    "5-Associate Director": totals["5-Associate Director"],
    "6-Senior Manager": totals["6-Senior Manager"],
    "7-Manager": totals["7-Manager"],
  });

  return { headers: [...headers], rows };
}

export function assertExecutivePDashboardContract(): void {
  const required = [
    ...EXECUTIVE_P_DASHBOARD_FILTER_COLUMNS,
    ...EXECUTIVE_P_DASHBOARD_ROW_COLUMNS,
    "Level",
  ];
  for (const column of required) {
    if (
      !EXECUTIVE_MASTER_LIVE_COLUMNS.includes(
        column as (typeof EXECUTIVE_MASTER_LIVE_COLUMNS)[number]
      )
    ) {
      throw new Error(
        `Executive P-Dashboard requires Master Sheet column "${column}".`
      );
    }
  }
}
