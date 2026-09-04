import "server-only";

import { readLateralDataProcessingSetup } from "@/services/lateral-processing/setup-store";
import {
  applyLateralMasterFilters,
  discoverLateralMasterFilters,
  LATERAL_MASTER_HEADER_ROW,
  LATERAL_MASTER_SHEET_NAME,
  orderJobStatusValues,
  paginateRows,
  type LateralMasterFilterField,
  type LateralMasterFilterSchema,
  type LateralMasterPageSize,
  type LateralMasterSheetPageResult,
  type LateralMasterSheetQuery,
} from "@/services/excel/lateral-master-sheet";
import { readLateralMasterSheetFromDriveXlsm } from "@/services/excel/read-lateral-master-from-drive-xlsm";
import { buildMasterSheetXlsxBuffer } from "@/services/excel/build-master-sheet-xlsx";
import { readSheetFromFileForLateralMaster } from "@/services/excel/reader";
import {
  LATERAL_MASTER_EXCEL_HEADERS,
  LATERAL_MASTER_PG_SOURCE_FILE,
  LATERAL_MASTER_PG_SOURCE_LABEL,
} from "@/services/persistence/lateral-master-sheet-columns";
import {
  countLateralMasterRows,
  listLateralMasterAsExcelRows,
  listLateralMasterDistinctValues,
  queryLateralMasterAsExcelPage,
  type LateralMasterFilterValueColumn,
  type LateralMasterQueryFilters,
} from "@/services/persistence/read-lateral-master";
import type { ExcelDataRow, ExcelReadResult, ExcelReaderOptions } from "@/types/excel";

function sourceUrlFromMeta(filePath?: string): string | undefined {
  if (!filePath) return undefined;
  if (/^https?:\/\//i.test(filePath)) return filePath;
  return undefined;
}

async function resolveMasterSheetName(): Promise<string> {
  try {
    const setup = await readLateralDataProcessingSetup();
    if (setup?.masterSheet?.trim()) return setup.masterSheet.trim();
  } catch {
    // fall through to default
  }
  return LATERAL_MASTER_SHEET_NAME;
}

/**
 * Master Sheet data source for the /lateral dashboard.
 * Default: postgres (VPS `lateral_master`). Set ARA_LATERAL_MASTER_SOURCE=drive
 * to fall back to the Drive XLSM pipeline reader (does not change import).
 */
export function resolveLateralMasterSheetSource(): "postgres" | "drive" {
  const raw = (process.env.ARA_LATERAL_MASTER_SOURCE ?? "postgres")
    .trim()
    .toLowerCase();
  return raw === "drive" ? "drive" : "postgres";
}

async function readLateralMasterSheetFromPostgres(): Promise<ExcelReadResult> {
  const sheetName = await resolveMasterSheetName();
  const payload = await listLateralMasterAsExcelRows();
  const rows: ExcelDataRow[] = payload.rows.map((row, index) => {
    const jr = String(row["Job Requisition ID"] ?? "").trim();
    return {
      id: jr ? `pg-master-${jr}` : `pg-master-row-${index + 1}`,
      ...row,
    };
  });

  return {
    businessUnitId: "lateral",
    sheetName,
    sourceFile: LATERAL_MASTER_PG_SOURCE_FILE,
    sourceLabel: LATERAL_MASTER_PG_SOURCE_LABEL,
    headers: payload.headers,
    rows,
    meta: {
      name: sheetName,
      rowCount: rows.length,
      columnCount: payload.headers.length,
      headerRow: LATERAL_MASTER_HEADER_ROW,
      filePath: LATERAL_MASTER_PG_SOURCE_LABEL,
      totalRows: rows.length,
    },
  };
}

/**
 * Company → Accenture → Lateral → Master Sheet.
 * Default reads PostgreSQL `lateral_master`. Drive XLSM remains available when
 * ARA_LATERAL_MASTER_SOURCE=drive (pipeline / other features unchanged).
 */
export async function readLateralMasterSheet(
  options?: ExcelReaderOptions
): Promise<ExcelReadResult> {
  if (resolveLateralMasterSheetSource() === "postgres") {
    return readLateralMasterSheetFromPostgres();
  }

  const sheetName = options?.sheetName?.trim() || (await resolveMasterSheetName());
  const headerRow = options?.headerRow ?? LATERAL_MASTER_HEADER_ROW;

  try {
    return await readLateralMasterSheetFromDriveXlsm({
      sheetName,
      headerRow,
      readerOptions: options,
    });
  } catch (error) {
    console.warn(
      "[excel] Lateral Master Sheet Drive XLSM read failed; falling back to Dataset Manager workbook.",
      error instanceof Error ? error.message : error
    );
  }

  return readSheetFromFileForLateralMaster(sheetName, headerRow, options);
}

/** Excel header → PG distinct-value column for Master Sheet filter schema. */
const MASTER_SHEET_DISTINCT_FILTERS: ReadonlyArray<{
  excelHeader: (typeof LATERAL_MASTER_EXCEL_HEADERS)[number];
  pg: LateralMasterFilterValueColumn;
  control: "multi-select" | "searchable-multi-select";
}> = [
  { excelHeader: "Priority", pg: "priority", control: "multi-select" },
  {
    excelHeader: "Skill Categorization",
    pg: "skill_categorization",
    control: "multi-select",
  },
  {
    excelHeader: "Primary Skills",
    pg: "primary_skills",
    control: "searchable-multi-select",
  },
  {
    excelHeader: "Job Management Level",
    pg: "job_management_level",
    control: "multi-select",
  },
  {
    excelHeader: "Primary Location/Office lOcate",
    pg: "primary_location",
    control: "searchable-multi-select",
  },
  { excelHeader: "Market Map", pg: "market_map", control: "multi-select" },
  { excelHeader: "POC", pg: "poc", control: "searchable-multi-select" },
  { excelHeader: "Job Status", pg: "job_status", control: "multi-select" },
  { excelHeader: "Posted", pg: "posted", control: "multi-select" },
];

function normalizeHeaderKey(header: string): string {
  return header.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Map Master Sheet UI filters → PostgreSQL query filters.
 */
export function mapMasterSheetQueryToPgFilters(
  query: Pick<
    LateralMasterSheetQuery,
    "columnFilters" | "textFilters" | "dateFilters" | "search"
  >
): LateralMasterQueryFilters {
  const filters: LateralMasterQueryFilters = {};
  const byHeader = new Map<string, string[]>();

  for (const [header, values] of Object.entries(query.columnFilters ?? {})) {
    if (!values?.length) continue;
    byHeader.set(normalizeHeaderKey(header), values);
  }

  const take = (header: string): string[] | undefined => {
    const values = byHeader.get(normalizeHeaderKey(header));
    return values?.length ? values : undefined;
  };

  filters.priority = take("Priority");
  filters.skillCategorization = take("Skill Categorization");
  filters.primarySkills = take("Primary Skills");
  filters.jobManagementLevel = take("Job Management Level");
  filters.primaryLocation =
    take("Primary Location/Office lOcate") ??
    take("Primary Location/Office Locate");
  filters.marketMap = take("Market Map");
  filters.poc = take("POC");
  filters.jobStatus = take("Job Status");
  filters.posted = take("Posted");

  for (const [header, needle] of Object.entries(query.textFilters ?? {})) {
    if (!needle?.trim()) continue;
    const key = normalizeHeaderKey(header);
    if (key.includes("job description") || key === "description") {
      filters.jobDescriptionContains = needle;
    } else if (key.includes("job requisition")) {
      filters.jobRequisitionIdContains = needle;
    }
  }

  const search = String(query.search ?? "").trim();
  if (search) {
    filters.globalSearch = search;
  }

  const dateRange =
    query.dateFilters?.Date ??
    query.dateFilters?.["date"] ??
    Object.values(query.dateFilters ?? {}).find((r) => r?.from || r?.to);
  if (dateRange?.from) filters.dateFrom = dateRange.from.trim();
  if (dateRange?.to) filters.dateTo = dateRange.to.trim();

  return filters;
}

async function getLateralMasterFilterSchemaFromPostgres(): Promise<LateralMasterFilterSchema> {
  const sheetName = await resolveMasterSheetName();
  const { getLateralMasterLastRunBanner } = await import(
    "@/services/persistence/lateral-master-last-run"
  );
  const lastRun = await getLateralMasterLastRunBanner().catch(() => null);

  const fields: LateralMasterFilterField[] = [
    { column: "Date", control: "date", values: [], valueCount: 0 },
    {
      column: "Job Requisition ID",
      control: "text",
      values: [],
      valueCount: 0,
    },
    {
      column: "Job Description",
      control: "text",
      values: [],
      valueCount: 0,
    },
  ];

  const distinctResults = await Promise.all(
    MASTER_SHEET_DISTINCT_FILTERS.map(async (mapping) => {
      const values = await listLateralMasterDistinctValues(mapping.pg);
      return { mapping, values };
    })
  );

  for (const { mapping, values } of distinctResults) {
    if (values.length === 0) continue;
    // Skip extreme-cardinality free-text-ish columns (same heuristic as discover).
    if (
      mapping.control === "searchable-multi-select" &&
      values.length > 400
    ) {
      continue;
    }
    let ordered = values;
    if (mapping.pg === "job_status") {
      ordered = orderJobStatusValues(values);
    }
    fields.push({
      column: mapping.excelHeader,
      control: mapping.control,
      values: ordered,
      valueCount: ordered.length,
    });
  }

  // Stable order matching Excel headers
  const order = new Map(
    LATERAL_MASTER_EXCEL_HEADERS.map((h, i) => [normalizeHeaderKey(h), i])
  );
  fields.sort(
    (a, b) =>
      (order.get(normalizeHeaderKey(a.column)) ?? 999) -
      (order.get(normalizeHeaderKey(b.column)) ?? 999)
  );

  // Prefer canonical Job Status order when present
  for (const field of fields) {
    if (/job\s*status/i.test(field.column)) {
      field.values = orderJobStatusValues(field.values);
    }
  }

  return {
    sheetName,
    sourceFile: LATERAL_MASTER_PG_SOURCE_FILE,
    sourceUrl: undefined,
    headers: [...LATERAL_MASTER_EXCEL_HEADERS],
    fields,
    lastRun,
  };
}

export async function getLateralMasterFilterSchema(
  options?: ExcelReaderOptions
): Promise<LateralMasterFilterSchema> {
  if (resolveLateralMasterSheetSource() === "postgres") {
    return getLateralMasterFilterSchemaFromPostgres();
  }

  const sheet = await readLateralMasterSheet(options);
  const { getLateralMasterLastRunBanner } = await import(
    "@/services/persistence/lateral-master-last-run"
  );
  const lastRun = await getLateralMasterLastRunBanner().catch(() => null);
  return {
    sheetName: sheet.sheetName,
    sourceFile: sheet.sourceFile,
    sourceUrl: sourceUrlFromMeta(sheet.meta.filePath),
    headers: sheet.headers,
    fields: discoverLateralMasterFilters(sheet.headers, sheet.rows),
    lastRun,
  };
}

export async function queryLateralMasterSheet(
  query: LateralMasterSheetQuery,
  options?: ExcelReaderOptions
): Promise<LateralMasterSheetPageResult> {
  if (resolveLateralMasterSheetSource() === "postgres") {
    const sheetName = await resolveMasterSheetName();
    const filters = mapMasterSheetQueryToPgFilters(query);
    const [page, totalUnfiltered] = await Promise.all([
      queryLateralMasterAsExcelPage({
        filters,
        page: query.page,
        pageSize: query.pageSize,
        sortBy: "date",
        sortDirection: "desc",
      }),
      countLateralMasterRows(),
    ]);

    const rows: ExcelDataRow[] = page.rows.map((row, index) => {
      const jr = String(row["Job Requisition ID"] ?? "").trim();
      return {
        id: jr ? `pg-master-${jr}` : `pg-master-row-${index + 1}`,
        ...row,
      };
    });

    return {
      businessUnitId: "lateral",
      sheetName,
      sourceFile: LATERAL_MASTER_PG_SOURCE_FILE,
      sourceUrl: undefined,
      headers: page.headers,
      rows,
      total: page.total,
      page: page.page,
      pageSize: page.pageSize as LateralMasterPageSize,
      pageCount: page.pageCount,
      meta: {
        name: sheetName,
        rowCount: rows.length,
        columnCount: page.headers.length,
        headerRow: LATERAL_MASTER_HEADER_ROW,
        filePath: LATERAL_MASTER_PG_SOURCE_LABEL,
        totalRows: totalUnfiltered,
      },
    };
  }

  const sheet = await readLateralMasterSheet(options);
  const filtered = applyLateralMasterFilters(sheet.rows, query);
  const page = paginateRows(filtered, query.page, query.pageSize);

  return {
    businessUnitId: "lateral",
    sheetName: sheet.sheetName,
    sourceFile: sheet.sourceFile,
    sourceUrl: sourceUrlFromMeta(sheet.meta.filePath),
    headers: sheet.headers,
    rows: page.rows,
    total: page.total,
    page: page.page,
    pageSize: page.pageSize as LateralMasterPageSize,
    pageCount: page.pageCount,
    meta: sheet.meta,
  };
}

/**
 * Export the entire Master Sheet as .xlsx (row 1 = headers, AutoFilter on).
 * Dashboard UI filters are ignored so Excel gets the full table.
 */
export async function exportLateralMasterSheetXlsx(
  options?: ExcelReaderOptions
): Promise<{
  buffer: Buffer;
  fileName: string;
  rowCount: number;
  sheetName: string;
}> {
  const sheet = await readLateralMasterSheet(options);

  const buffer = await buildMasterSheetXlsxBuffer({
    sheetName: sheet.sheetName || LATERAL_MASTER_SHEET_NAME,
    headers: sheet.headers,
    rows: sheet.rows,
  });

  const stamp = new Date().toISOString().slice(0, 10);
  const fileName = `Lateral-Master-Sheet-${stamp}.xlsx`;

  return {
    buffer,
    fileName,
    rowCount: sheet.rows.length,
    sheetName: sheet.sheetName || LATERAL_MASTER_SHEET_NAME,
  };
}
