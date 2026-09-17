/**
 * Verify Base DS -> New Sheet column translation (no network, no I/O).
 */
import {
  EXECUTIVE_NEW_SHEET_HEADERS,
  mapExecutiveRowToNewSheetRow,
  mapExecutiveRowsToNewSheetRows,
} from "../src/services/executive-processing/executive-new-sheet-mapping";
import type { ExecutiveMappedRow } from "../src/services/executive-processing/executive-base-ds-mapping";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

// --- Header contract matches the confirmed, re-fetched current 11-column New Sheet ---
assert(EXECUTIVE_NEW_SHEET_HEADERS.length === 11, "must be exactly 11 columns");
assert(
  JSON.stringify(EXECUTIVE_NEW_SHEET_HEADERS) ===
    JSON.stringify([
      "Job Requisition ID",
      "Market",
      "Primary Skill",
      "Primary Location",
      "Level",
      "Must Have skills",
      "Location Flex",
      "Skill category",
      "Job Description",
      "Priority",
      "Posted",
    ]),
  "header order/names must match the confirmed current New Sheet exactly"
);

function fullRow(overrides: Partial<ExecutiveMappedRow["values"]> = {}): ExecutiveMappedRow {
  return {
    jobRequisitionId: "ATCI-9999999-S9999999",
    values: {
      market_map: "Data & AI",
      primary_skills: "Java",
      job_management_level: "7-Manager",
      skill_categorization: "Core",
      primary_location: "Bengaluru",
      must_have_skills: "Spring Boot",
      location_flex: "No Flex",
      job_description: "Build things",
      priority: "High",
      ...overrides,
    },
  };
}

// --- Full row translates in correct order, Posted always null ---
{
  const row = mapExecutiveRowToNewSheetRow(fullRow());
  assert(row.length === 11, "output row must have 11 cells");
  assert(row[0] === "ATCI-9999999-S9999999", "col0 Job Requisition ID");
  assert(row[1] === "Data & AI", "col1 Market <- market_map");
  assert(row[2] === "Java", "col2 Primary Skill <- primary_skills");
  assert(row[3] === "Bengaluru", "col3 Primary Location <- primary_location");
  assert(row[4] === "7-Manager", "col4 Level <- job_management_level");
  assert(row[5] === "Spring Boot", "col5 Must Have skills <- must_have_skills");
  assert(row[6] === "No Flex", "col6 Location Flex <- location_flex");
  assert(row[7] === "Core", "col7 Skill category <- skill_categorization");
  assert(row[8] === "Build things", "col8 Job Description <- job_description");
  assert(row[9] === "High", "col9 Priority <- priority");
  assert(row[10] === null, "col10 Posted must ALWAYS be null — never written from Base DS");
}

// --- Nulls in source pass through as null, not coerced to empty string or "null" text ---
{
  const row = mapExecutiveRowToNewSheetRow(fullRow({ market_map: null, must_have_skills: null }));
  assert(row[1] === null, "missing market_map must stay null");
  assert(row[5] === null, "missing must_have_skills must stay null");
  assert(row[10] === null, "Posted still null regardless of other nulls");
}

// --- Batch mapping preserves order ---
{
  const rows: ExecutiveMappedRow[] = [
    fullRow({ }),
    { ...fullRow(), jobRequisitionId: "ATCI-1111111-S1111111" },
    { ...fullRow(), jobRequisitionId: "ATCI-2222222-S2222222" },
  ];
  const mapped = mapExecutiveRowsToNewSheetRows(rows);
  assert(mapped.length === 3, "must map every row");
  assert(mapped[0][0] === "ATCI-9999999-S9999999", "order preserved: row 0");
  assert(mapped[1][0] === "ATCI-1111111-S1111111", "order preserved: row 1");
  assert(mapped[2][0] === "ATCI-2222222-S2222222", "order preserved: row 2");
  for (const row of mapped) {
    assert(row[10] === null, "every row's Posted must be null");
  }
}

console.log("verify-executive-new-sheet-mapping: OK");
