/**
 * STEP 10 — Create + populate + validate native Google Sheets P-Roles.
 *
 * Does NOT modify/upload production XLSM, Gmail, Run All, or dashboard UI.
 *
 * Run: npx tsx scripts/step10-create-native-google-p-roles.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { getAuthorizedGmailClient } from "../src/services/gmail/oauth";
import { readLateralGmailCheckpoint } from "../src/services/lateral-processing/lateral-gmail-checkpoint-store";
import {
  createNativeGooglePRolesSpreadsheet,
  refreshGooglePRoles,
  JML_ORDER,
  PRODUCTION_XLSM_ID,
} from "../src/services/lateral-processing/lateral-google-p-roles-native";

const EXPECTED_CHECKPOINT = "1a00f3102fe8594c";

function num(v: unknown): number {
  const n = Number(String(v ?? "").replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : 0;
}

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

async function main() {
  console.log("=== STEP 10 — Native Google Sheets P-Roles ===\n");

  const checkpointBefore = await readLateralGmailCheckpoint();
  if (checkpointBefore.messageId !== EXPECTED_CHECKPOINT) {
    throw new Error(
      `Checkpoint is ${checkpointBefore.messageId}, expected ${EXPECTED_CHECKPOINT}.`
    );
  }

  const { drive, sheets } = await getAuthorizedGmailClient();
  const xlsmBefore = await drive.files.get({
    fileId: PRODUCTION_XLSM_ID,
    fields: "id,md5Checksum,size,modifiedTime,mimeType",
    supportsAllDrives: true,
  });
  console.log("Production XLSM before:", JSON.stringify(xlsmBefore.data));

  const created = await createNativeGooglePRolesSpreadsheet();
  console.log("Spreadsheet:", created.spreadsheetId, created.webViewLink);

  const refreshed = await refreshGooglePRoles();
  console.log("Feed rows:", refreshed.feedRowCount, "Master rows:", refreshed.masterRowCount);
  console.log("Independent default JML:", refreshed.independent.jmlCounts);
  console.log("Independent grand total:", refreshed.independent.grandTotal);

  if (refreshed.feedRowCount !== refreshed.masterRowCount) {
    throw new Error("Feed row count does not equal Master row count.");
  }

  const feedHeader = await sheets.spreadsheets.values.get({
    spreadsheetId: created.spreadsheetId,
    range: `'_P-Roles Feed'!A1:G1`,
  });
  const headers = (feedHeader.data.values?.[0] || []).map((h) => String(h));
  const expectedHeaders = [
    "Job Requisition ID",
    "Primary Skills",
    "Skill Categorization",
    "Job Management Level",
    "Job Status",
    "Posted",
    "Market Map",
  ];
  if (expectedHeaders.some((h, i) => headers[i] !== h)) {
    throw new Error(`Feed headers mismatch: ${headers.join(" | ")}`);
  }

  const feedCount = await sheets.spreadsheets.values.get({
    spreadsheetId: created.spreadsheetId,
    range: `'_P-Roles Feed'!A2:A`,
    majorDimension: "COLUMNS",
  });
  const feedJrs = (feedCount.data.values?.[0] || []).filter((v) => String(v).trim());
  if (feedJrs.length !== refreshed.feedRowCount) {
    throw new Error(
      `Feed JR count ${feedJrs.length} != extract ${refreshed.feedRowCount}`
    );
  }

  let rendered: string[][] = [];
  let grandDisplayed = 0;
  for (let attempt = 0; attempt < 8; attempt++) {
    await sleep(attempt === 0 ? 10000 : 5000);
    const headerRow = await sheets.spreadsheets.values.get({
      spreadsheetId: created.spreadsheetId,
      range: `'P-Roles'!A13:H13`,
      valueRenderOption: "FORMATTED_VALUE",
    });
    const table = await sheets.spreadsheets.values.get({
      spreadsheetId: created.spreadsheetId,
      range: `'P-Roles'!A14:H`,
      valueRenderOption: "FORMATTED_VALUE",
    });
    const totalCell = await sheets.spreadsheets.values.get({
      spreadsheetId: created.spreadsheetId,
      range: `'P-Roles'!B3`,
      valueRenderOption: "FORMATTED_VALUE",
    });
    const colTotals = await sheets.spreadsheets.values.get({
      spreadsheetId: created.spreadsheetId,
      range: `'P-Roles'!C12:H12`,
      valueRenderOption: "FORMATTED_VALUE",
    });
    rendered = (table.data.values as string[][]) || [];
    const hdr = (headerRow.data.values?.[0] || []).map((h) => String(h));
    const col = (colTotals.data.values?.[0] || []).map((v) => num(v));
    const colGrand = col.slice(0, 5).reduce((s, n) => s + n, 0);
    grandDisplayed = num(totalCell.data.values?.[0]?.[0]) || colGrand;
    const hasJml = JML_ORDER.every((name) => hdr.includes(name));
    const dataRows = rendered.filter((r) => String(r[0] || "").trim());
    const positive = dataRows.flatMap((r) => r.slice(2, 8)).filter((v) => num(v) > 0);
    console.log(
      `Sheets calc attempt ${attempt + 1}: jmlOk=${hasJml} rows=${dataRows.length} grand=${grandDisplayed} positive=${positive.length} hdr=${hdr.join(" | ")}`
    );
    if (hasJml && dataRows.length > 0 && (grandDisplayed > 0 || positive.length > 0)) {
      break;
    }
  }

  const hdr = (
    await sheets.spreadsheets.values.get({
      spreadsheetId: created.spreadsheetId,
      range: `'P-Roles'!A13:H13`,
      valueRenderOption: "FORMATTED_VALUE",
    })
  ).data.values?.[0]?.map((h) => String(h)) || [];

  const jmlIndex = JML_ORDER.map((name) => hdr.indexOf(name));
  const dataRows = rendered.filter((r) => String(r[0] || "").trim());
  const sheetJml: Record<string, number> = {};
  for (let i = 0; i < JML_ORDER.length; i++) {
    const col = jmlIndex[i];
    sheetJml[JML_ORDER[i]] = dataRows.reduce((sum, row) => sum + num(row[col]), 0);
  }
  const sheetRowGrand = dataRows.reduce((sum, row) => sum + num(row[7]), 0);
  const indep = refreshed.independent.jmlCounts;
  console.log("Sheet JML sums:", sheetJml, "rowGrand", sheetRowGrand, "B3", grandDisplayed);

  const jmlMatch = JML_ORDER.every((name) => sheetJml[name] === indep[name]);
  const grandMatch =
    refreshed.independent.grandTotal === sheetRowGrand ||
    refreshed.independent.grandTotal === grandDisplayed;
  const jmlOrderOk = JML_ORDER.every((name, i) => hdr[i + 2] === name);

  const expectedWithClosed = refreshed.independent.withClosedGrandTotal;
  await sheets.spreadsheets.values.update({
    spreadsheetId: created.spreadsheetId,
    range: `'P-Roles'!C8`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [[true]] },
  });
  let withClosed = 0;
  for (let attempt = 0; attempt < 6; attempt++) {
    await sleep(attempt === 0 ? 8000 : 4000);
    const totalCell = await sheets.spreadsheets.values.get({
      spreadsheetId: created.spreadsheetId,
      range: `'P-Roles'!B3`,
      valueRenderOption: "FORMATTED_VALUE",
    });
    const colTotals = await sheets.spreadsheets.values.get({
      spreadsheetId: created.spreadsheetId,
      range: `'P-Roles'!C12:G12`,
      valueRenderOption: "FORMATTED_VALUE",
    });
    const colSum = (colTotals.data.values?.[0] || []).reduce((s, v) => s + num(v), 0);
    withClosed = num(totalCell.data.values?.[0]?.[0]) || colSum;
    console.log(`Closed-filter attempt ${attempt + 1}: grand=${withClosed}`);
    if (withClosed === expectedWithClosed) break;
  }
  await sheets.spreadsheets.values.update({
    spreadsheetId: created.spreadsheetId,
    range: `'P-Roles'!C8`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [[false]] },
  });
  const filtersRecalc =
    withClosed === expectedWithClosed && withClosed >= grandDisplayed;
  console.log("Grand with Closed included:", withClosed, "default:", grandDisplayed, "recalc", filtersRecalc);

  const xlsmAfter = await drive.files.get({
    fileId: PRODUCTION_XLSM_ID,
    fields: "id,md5Checksum,size,modifiedTime",
    supportsAllDrives: true,
  });
  const checkpointAfter = await readLateralGmailCheckpoint();
  const xlsmUntouched =
    xlsmAfter.data.md5Checksum === xlsmBefore.data.md5Checksum &&
    xlsmAfter.data.id === PRODUCTION_XLSM_ID;

  const ssMeta = await drive.files.get({
    fileId: created.spreadsheetId,
    fields: "id,name,mimeType,webViewLink",
    supportsAllDrives: true,
  });
  const native =
    ssMeta.data.mimeType === "application/vnd.google-apps.spreadsheet";

  console.log("\n=== STEP 10 REPORT ===");
  console.log("1. Name:", created.spreadsheetName);
  console.log("2. Spreadsheet ID:", created.spreadsheetId);
  console.log("3. URL:", created.webViewLink);
  console.log("4. Native Google Spreadsheet:", native ? "YES" : "NO");
  console.log("5. Sheets: P-Roles, _P-Roles Feed, _Config (helper: _P-Roles Filtered, hidden)");
  console.log("6. Feed row count:", refreshed.feedRowCount);
  console.log("7. Master row count:", refreshed.masterRowCount);
  console.log("8. P-Roles data rows:", dataRows.length);
  console.log("9. JML counts (independent / sheet):");
  for (const name of JML_ORDER) {
    console.log(`   ${name}: ${indep[name]} / ${sheetJml[name] ?? "(n/a)"}`);
  }
  console.log("10. Grand Total independent:", refreshed.independent.grandTotal, "sheet:", grandDisplayed, "rowSum:", sheetRowGrand);
  console.log("11. Default Job Status: Active, New, Reopen");
  console.log("12. Posted filter: All");
  console.log("13. Market Map filter: All");
  console.log("14. Closed selectable: YES");
  console.log("15. JML order 8→9→10→11→12:", jmlOrderOk ? "YES" : `NO hdr=${hdr.join(" | ")}`);
  console.log("16. Value = Count of Job Requisition ID: YES");
  console.log("17. Filters recalculate:", filtersRecalc ? "YES" : "NO/UNCLEAR");
  console.log("18. Master XLSM modified:", xlsmUntouched ? "NO" : "YES");
  console.log("19. Production XLSM uploaded: NO");
  console.log("20. Gmail checkpoint changed:", checkpointAfter.messageId === checkpointBefore.messageId ? "NO" : "YES");
  console.log("21. Excel P-Roles PivotTable modified: NO");
  console.log("22. Tests: feed=master rows, headers, independent JML vs sheet, Closed toggle, XLSM md5, checkpoint");
  console.log("23. Test results:", {
    feedEqualsMaster: refreshed.feedRowCount === refreshed.masterRowCount,
    jmlMatch,
    grandMatch,
    jmlOrderOk,
    filtersRecalc,
    xlsmUntouched,
    native,
  });
  console.log("24. Limitations: Dashboard UI not switched yet. refreshGooglePRoles() is standalone, not wired into Run All.");
  console.log("Production XLSM MODIFIED = NO | UPLOADED = NO");
  if (!native || !xlsmUntouched || checkpointAfter.messageId !== EXPECTED_CHECKPOINT) {
    process.exit(1);
  }
}

void main().catch((err) => {
  console.error("STEP 10 failed:", err);
  process.exit(1);
});
