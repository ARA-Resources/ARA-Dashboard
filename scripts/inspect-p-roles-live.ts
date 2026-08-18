/**
 * Inspect live P-Roles pivot + report-filter slicers (read-only).
 */
import fs from "node:fs";
import { getAuthorizedGmailClient } from "../src/services/gmail/oauth";
import {
  P_ROLES_PIVOT_ANCHOR,
  P_ROLES_SHEET_TITLE,
  findExistingPRolesPivots,
} from "../src/services/lateral-processing/lateral-p-roles-sheets-pivot";

async function main() {
  const state = JSON.parse(
    fs.readFileSync(".data/lateral-p-roles-google-sheet.json", "utf8")
  );
  const { sheets } = await getAuthorizedGmailClient();
  const props = await sheets.spreadsheets.get({
    spreadsheetId: state.spreadsheetId,
    fields: "sheets(properties(title,sheetId),slicers)",
  });
  const pRoles = (props.data.sheets || []).find(
    (s) => s.properties?.title === P_ROLES_SHEET_TITLE
  );
  if (!pRoles?.properties?.sheetId) throw new Error("P-Roles missing");

  const pivots = await findExistingPRolesPivots({
    sheets,
    spreadsheetId: state.spreadsheetId,
    pRolesSheetId: pRoles.properties.sheetId,
  });

  const a1 = `${String.fromCharCode(65 + P_ROLES_PIVOT_ANCHOR.columnIndex)}${
    P_ROLES_PIVOT_ANCHOR.rowIndex + 1
  }`;
  const grid = await sheets.spreadsheets.get({
    spreadsheetId: state.spreadsheetId,
    includeGridData: true,
    ranges: [`'${P_ROLES_SHEET_TITLE}'!${a1}:${String.fromCharCode(65 + 7)}${P_ROLES_PIVOT_ANCHOR.rowIndex + 4}`],
    fields:
      "sheets(data.rowData.values(pivotTable,formattedValue))",
  });
  const pivot = grid.data.sheets?.[0]?.data?.[0]?.rowData?.[0]?.values?.[0]
    ?.pivotTable;
  const preview = (grid.data.sheets?.[0]?.data?.[0]?.rowData || []).map(
    (r, i) => ({
      row: P_ROLES_PIVOT_ANCHOR.rowIndex + 1 + i,
      cells: (r.values || []).map((c) => c.formattedValue ?? null),
    })
  );

  console.log(
    JSON.stringify(
      {
        canonicalAnchor: a1,
        slicers: (pRoles.slicers || []).map((s) => ({
          title: s.spec?.title,
          columnIndex: s.spec?.columnIndex,
          applyToPivotTables: s.spec?.applyToPivotTables !== false,
          hiddenValues: s.spec?.filterCriteria?.hiddenValues ?? [],
        })),
        pivotCount: pivots.length,
        pivot: {
          filterCount: pivot?.filterSpecs?.length ?? 0,
          filterSpecs: pivot?.filterSpecs,
          rows: pivot?.rows?.map((r) => r.label),
          columns: pivot?.columns?.map((c) => c.label),
          values: pivot?.values,
          grandTotal: pivot?.columns?.[0]?.showTotals === true,
          sourceSheetId: pivot?.source?.sheetId,
        },
        preview,
      },
      null,
      2
    )
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
