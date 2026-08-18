/**
 * Verify Job Management Level columns are in numeric-prefix order.
 */
import fs from "node:fs";
import { getAuthorizedGmailClient } from "../src/services/gmail/oauth";
import {
  P_ROLES_PIVOT_ANCHOR,
  P_ROLES_SHEET_TITLE,
  compareJobManagementLevelsByNumericPrefix,
  extractJobManagementLevelNumericPrefix,
  sortJobManagementLevelsByNumericPrefix,
} from "../src/services/lateral-processing/lateral-p-roles-sheets-pivot";

async function main() {
  const sample = [
    "10-Senior Analyst",
    "12-Associate",
    "8-Associate Manager",
    "9-Team Lead/Consultant",
    "11-Analyst",
    "14-Director",
    "7-Manager",
  ];
  console.log("unit", sortJobManagementLevelsByNumericPrefix(sample));

  const state = JSON.parse(
    fs.readFileSync(".data/lateral-p-roles-google-sheet.json", "utf8")
  );
  const { sheets } = await getAuthorizedGmailClient();
  // Read visible header row under pivot (row after title; sort-key row may be hidden)
  const start = P_ROLES_PIVOT_ANCHOR.rowIndex + 1; // 1-based later
  const g = await sheets.spreadsheets.get({
    spreadsheetId: state.spreadsheetId,
    includeGridData: true,
    ranges: [
      `'${P_ROLES_SHEET_TITLE}'!A${P_ROLES_PIVOT_ANCHOR.rowIndex + 1}:Z${P_ROLES_PIVOT_ANCHOR.rowIndex + 5}`,
    ],
    fields: "sheets(data.rowData.values.formattedValue)",
  });
  const rows = (g.data.sheets?.[0]?.data?.[0]?.rowData || []).map((r, i) => ({
    row: P_ROLES_PIVOT_ANCHOR.rowIndex + 1 + i,
    cells: (r.values || []).map((c) => c.formattedValue || null),
  }));
  console.log("preview_rows", JSON.stringify(rows, null, 2));

  // Find header row containing JML labels (skip title / numeric-only rows)
  let header: string[] = [];
  for (const r of rows) {
    const vals = r.cells.filter((c): c is string => !!c);
    if (vals.some((v) => /Associate Manager|Team Lead|Senior Analyst/i.test(v))) {
      header = r.cells.filter((c): c is string => !!c && c !== "Primary Skills" && c !== "Skill Categorization" && c !== "Grand Total");
      // Keep Grand Total check separately
      const withGt = r.cells.filter((c): c is string => !!c && c !== "Primary Skills" && c !== "Skill Categorization");
      header = withGt;
      break;
    }
  }
  console.log("detected_jml_headers", header);

  const levels = header.filter((h) => h !== "Grand Total");
  const prefixes = levels.map(extractJobManagementLevelNumericPrefix);
  console.log("prefixes", prefixes);

  let ok = true;
  for (let i = 1; i < levels.length; i++) {
    if (compareJobManagementLevelsByNumericPrefix(levels[i - 1], levels[i]) > 0) {
      ok = false;
      break;
    }
  }
  const gtLast = header[header.length - 1] === "Grand Total" || !header.includes("Grand Total");
  console.log("NUMERIC_ORDER", ok ? "PASS" : "FAIL");
  console.log("GRAND_TOTAL_TRAILING", gtLast ? "PASS" : "FAIL");
  if (!ok) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
