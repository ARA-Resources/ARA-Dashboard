/**
 * Validate Job Management Level presence from Google Sheet SOURCE (not Excel screenshots).
 * SOURCE determines which levels exist; numeric-prefix sort determines order.
 *
 * Run: npx tsx scripts/validate-jml-source-levels.ts
 */
import fs from "node:fs";
import { getAuthorizedGmailClient } from "../src/services/gmail/oauth";
import {
  MASTER_COL,
  MASTER_SHEET_TITLE,
  P_ROLES_PIVOT_ANCHOR,
  P_ROLES_SHEET_TITLE,
  extractJobManagementLevelNumericPrefix,
  findExistingPRolesPivots,
  readMasterSheetColumnDistinctValues,
  sortJobManagementLevelsByNumericPrefix,
} from "../src/services/lateral-processing/lateral-p-roles-sheets-pivot";

async function main() {
  const state = JSON.parse(
    fs.readFileSync(".data/lateral-p-roles-google-sheet.json", "utf8")
  );
  const { sheets } = await getAuthorizedGmailClient();
  const spreadsheetId = state.spreadsheetId;

  const distinct = await readMasterSheetColumnDistinctValues({
    sheets,
    spreadsheetId,
    columnIndex: MASTER_COL.jobManagementLevel,
  });
  const ordered = sortJobManagementLevelsByNumericPrefix(distinct);
  const has12 = distinct.some(
    (v) => v.trim().toLowerCase() === "12-associate"
  );

  // Count rows per JML (source truth)
  const col = String.fromCharCode(65 + MASTER_COL.jobManagementLevel); // G
  const statusCol = String.fromCharCode(65 + MASTER_COL.jobStatus); // K
  const [jmlRes, statusRes] = await Promise.all([
    sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `'${MASTER_SHEET_TITLE}'!${col}2:${col}`,
      majorDimension: "COLUMNS",
    }),
    sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `'${MASTER_SHEET_TITLE}'!${statusCol}2:${statusCol}`,
      majorDimension: "COLUMNS",
    }),
  ]);
  const jmlVals = (jmlRes.data.values?.[0] ?? []).map((v) => String(v ?? "").trim());
  const statusVals = (statusRes.data.values?.[0] ?? []).map((v) =>
    String(v ?? "").trim()
  );
  let count12 = 0;
  let count12NonClosed = 0;
  const statusBreakdown: Record<string, number> = {};
  for (let i = 0; i < jmlVals.length; i++) {
    if (jmlVals[i] !== "12-Associate") continue;
    count12 += 1;
    const st = statusVals[i] || "(blank)";
    statusBreakdown[st] = (statusBreakdown[st] || 0) + 1;
    if (st.toLowerCase() !== "closed") count12NonClosed += 1;
  }

  const props = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "sheets.properties",
  });
  const pRoles = (props.data.sheets || []).find(
    (s) => s.properties?.title === P_ROLES_SHEET_TITLE
  );
  if (!pRoles?.properties?.sheetId) throw new Error("P-Roles missing");

  const pivots = await findExistingPRolesPivots({
    sheets,
    spreadsheetId,
    pRolesSheetId: pRoles.properties.sheetId,
  });
  const pivot =
    pivots.find(
      (p) =>
        p.rowIndex === P_ROLES_PIVOT_ANCHOR.rowIndex &&
        p.columnIndex === P_ROLES_PIVOT_ANCHOR.columnIndex
    )?.pivot ?? pivots[0]?.pivot;

  const metaLabels = (pivot?.columns ?? [])
    .flatMap((c) => c.valueMetadata ?? [])
    .map((m) => m.value?.stringValue || "")
    .filter(Boolean);

  const metaHas12 = metaLabels.some(
    (v) => v.trim().toLowerCase() === "12-associate"
  );

  // Displayed headers
  const grid = await sheets.spreadsheets.get({
    spreadsheetId,
    includeGridData: true,
    ranges: [
      `'${P_ROLES_SHEET_TITLE}'!A${P_ROLES_PIVOT_ANCHOR.rowIndex + 1}:Z${P_ROLES_PIVOT_ANCHOR.rowIndex + 5}`,
    ],
    fields: "sheets(data.rowData.values.formattedValue)",
  });
  const rows = grid.data.sheets?.[0]?.data?.[0]?.rowData ?? [];
  let displayed: string[] = [];
  for (const row of rows) {
    const cells = (row.values ?? [])
      .map((c) => c.formattedValue || "")
      .filter(Boolean);
    if (cells.some((v) => /Associate Manager|12-Associate/i.test(v))) {
      displayed = cells.filter(
        (v) =>
          ![
            "Primary Skills",
            "Skill Categorization",
            "Count of Job Management Level",
            "Job Management Level",
            "JML#",
          ].includes(v) && v.trim() !== "" && v.trim() !== " "
      );
      break;
    }
  }
  const displayHas12 = displayed.some(
    (v) => v.trim().toLowerCase() === "12-associate"
  );

  const numericLevels = ordered.filter(
    (v) => extractJobManagementLevelNumericPrefix(v) != null
  );

  const issues: string[] = [];
  if (has12 && !metaHas12) {
    issues.push(
      "SOURCE has 12-Associate but pivot valueMetadata does not include it — FIX REQUIRED"
    );
  }
  if (has12 && count12NonClosed > 0 && !displayHas12) {
    issues.push(
      `SOURCE has ${count12NonClosed} non-Closed 12-Associate row(s) but pivot display omits the column — FIX REQUIRED`
    );
  }
  if (!has12 && (metaHas12 || displayHas12)) {
    issues.push(
      "12-Associate appears in pivot but NOT in source — should not invent levels"
    );
  }

  // Order check among metadata numeric levels
  const metaNumeric = sortJobManagementLevelsByNumericPrefix(
    metaLabels.filter((v) => extractJobManagementLevelNumericPrefix(v) != null)
  );
  const orderOk =
    JSON.stringify(metaNumeric) ===
    JSON.stringify(
      numericLevels.filter((v) =>
        metaNumeric.includes(v)
      )
    );

  const report = {
    SOURCE_DETERMINES_WHICH_LEVELS: true,
    NUMERIC_PREFIX_DETERMINES_ORDER: true,
    source: {
      distinctJmlCount: distinct.length,
      has_12_Associate: has12,
      count_12_Associate: count12,
      count_12_Associate_nonClosed: count12NonClosed,
      statusBreakdown_12_Associate: statusBreakdown,
      numericLevelsInSourceOrder: numericLevels.slice(0, 20),
    },
    pivot: {
      valueMetadataIncludes_12_Associate: metaHas12,
      valueMetadataNumericOrder: metaNumeric.slice(0, 20),
      displayedHeaders: displayed,
      displayIncludes_12_Associate: displayHas12,
      metadataOrderOk: orderOk,
    },
    verdict: {
      ok: issues.length === 0,
      issues: issues.length ? issues : ["None"],
      note: !has12
        ? "12-Associate not in Google Sheet source — correctly omitted (do not invent)."
        : count12NonClosed === 0 && has12
          ? "12-Associate exists in source but all rows are Closed (current Job Status filter hides Closed). It remains in valueMetadata for availability; column appears when non-Closed rows exist or Closed is shown."
          : "12-Associate present in source and must be available to the pivot.",
    },
  };

  console.log(JSON.stringify(report, null, 2));
  if (issues.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
