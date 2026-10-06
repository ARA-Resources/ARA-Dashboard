/**
 * Migration 022 (Accenture Final Report, Stage 1) — static validation of
 * the Candidate Master Sheet column map. No DB access, not destructive.
 *
 * Confirms: all three column arrays have grown from 16 to 21 entries and
 * stayed in lockstep; the renamed "Oorwin Candidate Stage" label still
 * resolves to the unchanged `status` DB column (and keeps "Status" as an
 * import alias); and the 5 new Accenture columns round-trip correctly
 * through the header<->column lookup.
 *
 * Run: npx tsx scripts/verify-candidate-column-map.ts
 */
import {
  CANDIDATE_MASTER_COLUMN_MAP,
  CANDIDATE_MASTER_EXCEL_HEADERS,
  CANDIDATE_MASTER_SHEET_DB_COLUMNS,
  excelHeaderForCandidateDbColumn,
} from "../src/services/persistence/candidate-master-sheet-columns";
import {
  applyCandidateMasterSheetFilters,
  normalizeLegacyCandidateFilterKey,
  type CandidateMasterSheetPgRow,
} from "../src/services/persistence/candidate-master-sheet-postgres";

interface TestResult {
  name: string;
  status: "PASS" | "FAIL";
  detail?: string;
}
function check(results: TestResult[], name: string, pass: boolean, detail?: string) {
  results.push({ name, status: pass ? "PASS" : "FAIL", detail });
}

function main() {
  const results: TestResult[] = [];

  check(
    results,
    "CANDIDATE_MASTER_EXCEL_HEADERS has 21 entries",
    CANDIDATE_MASTER_EXCEL_HEADERS.length === 21,
    `actual: ${CANDIDATE_MASTER_EXCEL_HEADERS.length}`
  );
  check(
    results,
    "CANDIDATE_MASTER_SHEET_DB_COLUMNS has 21 entries",
    CANDIDATE_MASTER_SHEET_DB_COLUMNS.length === 21,
    `actual: ${CANDIDATE_MASTER_SHEET_DB_COLUMNS.length}`
  );
  check(
    results,
    "CANDIDATE_MASTER_COLUMN_MAP has 21 entries",
    CANDIDATE_MASTER_COLUMN_MAP.length === 21,
    `actual: ${CANDIDATE_MASTER_COLUMN_MAP.length}`
  );

  const expectedOrder = [
    "Candidate ID", "Upload Date", "Name", "Email", "Contact Number", "Submitter",
    "Customer", "Job Requisition ID", "Primary Skills", "Job Management Level",
    "Market", "Client SPOC", "Oorwin Candidate Stage", "Accenture Candidate Stage",
    "Current CID Source", "Application Completion Status", "Screening Candidate Stage",
    "Disposition Reason", "Submitted Date", "Submission Comments", "Gender",
  ];
  check(
    results,
    "CANDIDATE_MASTER_EXCEL_HEADERS matches the exact expected 21-column order",
    JSON.stringify(CANDIDATE_MASTER_EXCEL_HEADERS) === JSON.stringify(expectedOrder),
    JSON.stringify(CANDIDATE_MASTER_EXCEL_HEADERS)
  );

  check(
    results,
    '"Oorwin Candidate Stage" maps to db column "status"',
    excelHeaderForCandidateDbColumn("status") === "Oorwin Candidate Stage"
  );

  const statusMapping = CANDIDATE_MASTER_COLUMN_MAP.find((m) => m.dbColumn === "status");
  check(
    results,
    'status mapping keeps "Status" as an import alias',
    Boolean(statusMapping && statusMapping.importAliases.includes("Status")),
    JSON.stringify(statusMapping?.importAliases)
  );
  check(
    results,
    'status mapping also keeps the legacy "Status (Recruiter)" alias',
    Boolean(statusMapping && statusMapping.importAliases.includes("Status (Recruiter)"))
  );
  check(
    results,
    'no literal "Status" excelHeader remains (fully renamed, not duplicated)',
    !CANDIDATE_MASTER_EXCEL_HEADERS.includes("Status" as never)
  );

  const newDbColumns = [
    "accenture_candidate_stage",
    "current_cid_source",
    "application_completion_status",
    "screening_candidate_stage",
    "disposition_reason",
  ] as const;
  const newExcelHeaders = [
    "Accenture Candidate Stage",
    "Current CID Source",
    "Application Completion Status",
    "Screening Candidate Stage",
    "Disposition Reason",
  ];
  for (let i = 0; i < newDbColumns.length; i++) {
    check(
      results,
      `${newDbColumns[i]} round-trips to "${newExcelHeaders[i]}"`,
      excelHeaderForCandidateDbColumn(newDbColumns[i]) === newExcelHeaders[i]
    );
    check(
      results,
      `${newDbColumns[i]} has no import aliases (nothing imports it from a legacy workbook)`,
      CANDIDATE_MASTER_COLUMN_MAP.find((m) => m.dbColumn === newDbColumns[i])?.importAliases.length === 0
    );
  }

  // Lock / reference columns must never appear in any of the 3 arrays.
  const forbidden = [
    "email_accenture_locked",
    "job_management_level_accenture_locked",
    "last_accenture_sync_id",
    "last_accenture_report_date",
  ];
  for (const col of forbidden) {
    check(
      results,
      `"${col}" is excluded from CANDIDATE_MASTER_SHEET_DB_COLUMNS`,
      !(CANDIDATE_MASTER_SHEET_DB_COLUMNS as readonly string[]).includes(col)
    );
  }

  // --- Legacy "Status" filter key still resolves (item 4) ---
  check(
    results,
    'normalizeLegacyCandidateFilterKey("Status") -> "Oorwin Candidate Stage"',
    normalizeLegacyCandidateFilterKey("Status") === "Oorwin Candidate Stage"
  );
  check(
    results,
    "normalizeLegacyCandidateFilterKey leaves every other key untouched",
    normalizeLegacyCandidateFilterKey("Oorwin Candidate Stage") === "Oorwin Candidate Stage" &&
      normalizeLegacyCandidateFilterKey("Email") === "Email"
  );

  function syntheticRow(cid: string, oorwinStage: string): CandidateMasterSheetPgRow {
    const row = { id: cid, insertedSyncId: null, lastAccentureSyncId: null } as CandidateMasterSheetPgRow;
    for (const header of CANDIDATE_MASTER_EXCEL_HEADERS) row[header] = "-";
    row["Candidate ID"] = cid;
    row["Oorwin Candidate Stage"] = oorwinStage;
    return row;
  }
  const syntheticRows = [syntheticRow("C1", "Active"), syntheticRow("C2", "Inactive")];

  const filteredByOldKey = applyCandidateMasterSheetFilters(syntheticRows, {
    columnFilters: { Status: ["Active"] },
    textFilters: {},
    dateFilters: {},
  });
  check(
    results,
    'applyCandidateMasterSheetFilters: a bookmarked columnFilters key of "Status" still filters correctly (not silently empty)',
    filteredByOldKey.length === 1 && filteredByOldKey[0]["Candidate ID"] === "C1",
    JSON.stringify(filteredByOldKey.map((r) => r["Candidate ID"]))
  );

  const filteredByNewKey = applyCandidateMasterSheetFilters(syntheticRows, {
    columnFilters: { "Oorwin Candidate Stage": ["Active"] },
    textFilters: {},
    dateFilters: {},
  });
  check(
    results,
    "applyCandidateMasterSheetFilters: old key (\"Status\") and new key (\"Oorwin Candidate Stage\") produce identical results",
    JSON.stringify(filteredByOldKey.map((r) => r["Candidate ID"])) ===
      JSON.stringify(filteredByNewKey.map((r) => r["Candidate ID"]))
  );

  const failed = results.filter((r) => r.status === "FAIL");
  for (const r of results) {
    console.log(`[${r.status}] ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
  }
  console.log(`\n${results.length - failed.length}/${results.length} passed.`);
  if (failed.length > 0) {
    console.error(`${failed.length} check(s) FAILED.`);
    process.exit(1);
  }
}

main();
