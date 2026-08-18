/**
 * Verify New Sheet refresh rules (date format + post-write validation).
 * Run: npx tsx scripts/verify-lateral-new-sheet-refresh.ts
 */
import { EXPECTED_NEW_SHEET_HEADERS } from "../src/services/lateral-processing/lateral-new-sheet-structure";
import {
  formatProcessingDateDDMMYYYY,
  isProcessingDateDDMMYYYY,
  validateNewSheetRefresh,
} from "../src/services/lateral-processing/lateral-new-sheet-refresh";
import type { ColumnMapping } from "../src/services/lateral-processing/data-reader";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

const fixed = new Date(2026, 7, 12); // 12 Aug 2026 local
assert(formatProcessingDateDDMMYYYY(fixed) === "12-08-2026", "DD-MM-YYYY");
assert(isProcessingDateDDMMYYYY("12-08-2026"), "valid date");
assert(!isProcessingDateDDMMYYYY("2026-08-12"), "reject ISO");

const mappings: ColumnMapping[] = EXPECTED_NEW_SHEET_HEADERS.map((h, i) =>
  h === "Date"
    ? {
        destinationHeader: h,
        sourceHeader: "(system date)",
        sourceColIndex: -1,
        destinationColIndex: i,
        generated: true,
      }
    : {
        destinationHeader: h,
        sourceHeader: h === "Primary Location/Office Locate" ? "Primary Location" : h,
        sourceColIndex: i - 1,
        destinationColIndex: i,
      }
);

const sourceDataRows = [
  ["J1", "P1", "d1", "c1", "s1", "L1", "BLR", "MM", "poc1"],
  ["J2", "P2", "d2", "c2", "s2", "L2", "HYD", "MM", "poc2"],
];

const processingDate = "12-08-2026";
const goodRows = sourceDataRows.map((src) => {
  const row = EXPECTED_NEW_SHEET_HEADERS.map(() => "");
  row[0] = processingDate;
  for (const m of mappings) {
    if (m.generated) continue;
    row[m.destinationColIndex] = src[m.sourceColIndex] ?? "";
  }
  return row;
});

const ok = validateNewSheetRefresh({
  expectedHeaders: EXPECTED_NEW_SHEET_HEADERS,
  actualHeaders: [...EXPECTED_NEW_SHEET_HEADERS],
  sourceRowCount: 2,
  insertedRowCount: 2,
  dataRows: goodRows,
  processingDate,
  mappings,
  sourceDataRows,
});
assert(ok.ok, "good refresh must pass");
assert(ok.checks.rowCountMatch, "row counts");
assert(ok.checks.datePopulated, "dates");
assert(ok.checks.jobRequisitionIdPopulated, "job ids");
assert(ok.checks.noShiftedColumns, "no shift");

const badCount = validateNewSheetRefresh({
  expectedHeaders: EXPECTED_NEW_SHEET_HEADERS,
  actualHeaders: [...EXPECTED_NEW_SHEET_HEADERS],
  sourceRowCount: 2,
  insertedRowCount: 1,
  dataRows: goodRows.slice(0, 1),
  processingDate,
  mappings,
  sourceDataRows: sourceDataRows.slice(0, 1),
});
assert(!badCount.ok, "row count mismatch fails");
assert(/Source row count/.test(badCount.reasons.join(" ")), "mentions counts");

const badDate = validateNewSheetRefresh({
  expectedHeaders: EXPECTED_NEW_SHEET_HEADERS,
  actualHeaders: [...EXPECTED_NEW_SHEET_HEADERS],
  sourceRowCount: 2,
  insertedRowCount: 2,
  dataRows: goodRows.map((r) => {
    const copy = [...r];
    copy[0] = "2026-08-12";
    return copy;
  }),
  processingDate,
  mappings,
  sourceDataRows,
});
assert(!badDate.ok, "ISO date must fail");

const shifted = goodRows.map((r) => [...r]);
shifted[0][1] = shifted[0][2]; // Job Req ID gets Priority value
const badShift = validateNewSheetRefresh({
  expectedHeaders: EXPECTED_NEW_SHEET_HEADERS,
  actualHeaders: [...EXPECTED_NEW_SHEET_HEADERS],
  sourceRowCount: 2,
  insertedRowCount: 2,
  dataRows: shifted,
  processingDate,
  mappings,
  sourceDataRows,
});
assert(!badShift.ok, "shifted columns must fail");
assert(/Column shift/.test(badShift.reasons.join(" ")), "reports shift");

const badHeader = validateNewSheetRefresh({
  expectedHeaders: EXPECTED_NEW_SHEET_HEADERS,
  actualHeaders: ["Date", "Priority", ...EXPECTED_NEW_SHEET_HEADERS.slice(2)],
  sourceRowCount: 2,
  insertedRowCount: 2,
  dataRows: goodRows,
  processingDate,
  mappings,
  sourceDataRows,
});
assert(!badHeader.ok, "Row 1 change must fail");

const caseOk = validateNewSheetRefresh({
  expectedHeaders: EXPECTED_NEW_SHEET_HEADERS,
  actualHeaders: EXPECTED_NEW_SHEET_HEADERS.map((h) =>
    h === "Primary Location/Office Locate"
      ? "Primary Location/Office locate"
      : h
  ),
  sourceRowCount: 2,
  insertedRowCount: 2,
  dataRows: goodRows,
  processingDate,
  mappings,
  sourceDataRows,
});
assert(caseOk.ok, "case-only header difference must pass");

console.log("verify-lateral-new-sheet-refresh: OK");
