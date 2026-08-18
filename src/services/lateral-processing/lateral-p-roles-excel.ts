import { readTopOpenings } from "@/services/excel/reader";
import type {
  PRolesEngine,
  PRolesEngineInput,
  PRolesResult,
} from "@/services/lateral-processing/lateral-p-roles-engine";

function asNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Adapter around the existing dashboard behavior.
 * This is kept as default to preserve production behavior while native mode
 * is validated in parallel.
 */
export async function generateExcelCompatiblePRoles(
  input: PRolesEngineInput
): Promise<PRolesResult> {
  void input.masterRows;
  const columnFilters: Record<string, string[]> = {};
  if ((input.filters?.jobStatus ?? []).length > 0) {
    columnFilters["Job Status"] = [...(input.filters?.jobStatus ?? [])];
  }
  if ((input.filters?.posted ?? []).length > 0) {
    columnFilters["Posted"] = [...(input.filters?.posted ?? [])];
  }
  if ((input.filters?.marketMap ?? []).length > 0) {
    columnFilters["Market Map"] = [...(input.filters?.marketMap ?? [])];
  }

  const legacy = await readTopOpenings(
    "lateral",
    {
      columnFilters,
      sortBy: null,
      sortDirection: "desc",
      topN: null,
    },
    { bypassCache: true }
  );

  const columns = legacy.headers.filter(
    (header) =>
      header !== "Primary Skills" &&
      header !== "Skill Categorization" &&
      header !== "Grand Total"
  );
  const rows = legacy.rows.map((row) => {
    const byJml: Record<string, number> = {};
    for (const column of columns) {
      byJml[column] = asNumber(row[column]);
    }
    return {
      primarySkills: String(row["Primary Skills"] ?? "—"),
      skillCategorization: String(row["Skill Categorization"] ?? "—"),
      byJml,
      grandTotal: asNumber(row["Grand Total"]),
    };
  });

  return {
    rows,
    columns,
    filters: {
      jobStatus: [...(input.filters?.jobStatus ?? [])],
      posted: [...(input.filters?.posted ?? [])],
      marketMap: [...(input.filters?.marketMap ?? [])],
    },
    totals: {
      totalJobs: rows.reduce((sum, row) => sum + row.grandTotal, 0),
    },
    metadata: {
      source: "master-sheet",
      generatedAt: new Date().toISOString(),
      jmlOrder: columns,
      unknownJmlValues: columns.filter((column) => !/^\d+/.test(column)),
      engine: "excel",
    },
  };
}

export const ExcelPRolesEngine: PRolesEngine = {
  kind: "excel",
  async generate(input: PRolesEngineInput): Promise<PRolesResult> {
    return generateExcelCompatiblePRoles(input);
  },
};
