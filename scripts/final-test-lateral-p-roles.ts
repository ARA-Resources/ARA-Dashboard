/**
 * Complete final live test of Lateral P-Roles.
 *
 * Tests: filters (change → values change), row hierarchy, JML numeric order,
 * future levels, Google Sheet-only source, Master Sheet protection.
 *
 * Run: npx tsx scripts/final-test-lateral-p-roles.ts
 *
 * Restores default P-Roles config via apply at the end.
 */
import fs from "node:fs";
import type { sheets_v4 } from "googleapis";
import { getAuthorizedGmailClient } from "../src/services/gmail/oauth";
import {
  assertBatchUpdateTargetsOnlyPRoles,
  captureMasterSheetFingerprint,
  type MasterSheetSourceFingerprint,
} from "../src/services/lateral-processing/lateral-p-roles-source-guard";
import {
  MASTER_COL,
  MASTER_SHEET_TITLE,
  P_ROLES_FIELDS,
  P_ROLES_FEED_SHEET_TITLE,
  P_ROLES_PIVOT_ANCHOR,
  P_ROLES_SHEET_TITLE,
  applyLateralPRolesPivotTable,
  compareJobManagementLevelsByNumericPrefix,
  extractJobManagementLevelNumericPrefix,
  findExistingPRolesPivots,
  readMasterSheetColumnDistinctValues,
  sortJobManagementLevelsByNumericPrefix,
  verifyPRolesDataSourceArchitecture,
} from "../src/services/lateral-processing/lateral-p-roles-sheets-pivot";

type Check = { name: string; ok: boolean; detail: string };

const EXPECTED_FILTERS = [
  P_ROLES_FIELDS.jobStatus,
  P_ROLES_FIELDS.posted,
  P_ROLES_FIELDS.marketMap,
] as const;

function mark(ok: boolean): string {
  return ok ? "✓" : "✗";
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function loadState(): Promise<{ spreadsheetId: string }> {
  return JSON.parse(
    fs.readFileSync(".data/lateral-p-roles-google-sheet.json", "utf8")
  );
}

async function sheetIds(options: {
  sheets: sheets_v4.Sheets;
  spreadsheetId: string;
}): Promise<{
  masterSheetId: number;
  pRolesSheetId: number;
  feedSheetId: number | null;
}> {
  const meta = await options.sheets.spreadsheets.get({
    spreadsheetId: options.spreadsheetId,
    fields: "sheets(properties(sheetId,title),slicers)",
  });
  const find = (title: string) =>
    (meta.data.sheets ?? []).find((s) => s.properties?.title === title);
  const master = find(MASTER_SHEET_TITLE);
  const pRoles = find(P_ROLES_SHEET_TITLE);
  const feed = find(P_ROLES_FEED_SHEET_TITLE);
  if (master?.properties?.sheetId == null) {
    throw new Error(`Missing "${MASTER_SHEET_TITLE}"`);
  }
  if (pRoles?.properties?.sheetId == null) {
    throw new Error(`Missing "${P_ROLES_SHEET_TITLE}"`);
  }
  return {
    masterSheetId: master.properties.sheetId,
    pRolesSheetId: pRoles.properties.sheetId,
    feedSheetId: feed?.properties?.sheetId ?? null,
  };
}

async function listSlicers(options: {
  sheets: sheets_v4.Sheets;
  spreadsheetId: string;
  pRolesSheetId: number;
}): Promise<
  Array<{
    slicerId: number;
    title: string;
    applyToPivotTables: boolean;
    columnIndex: number | null;
  }>
> {
  const meta = await options.sheets.spreadsheets.get({
    spreadsheetId: options.spreadsheetId,
    fields: "sheets(properties(sheetId,title),slicers)",
  });
  const pRoles = (meta.data.sheets ?? []).find(
    (s) => s.properties?.sheetId === options.pRolesSheetId
  );
  return (pRoles?.slicers ?? [])
    .filter((s) => typeof s.slicerId === "number")
    .map((s) => ({
      slicerId: s.slicerId as number,
      title: (s.spec?.title || "").trim(),
      applyToPivotTables: s.spec?.applyToPivotTables !== false,
      columnIndex: s.spec?.columnIndex ?? null,
    }));
}

async function readPivotGrid(options: {
  sheets: sheets_v4.Sheets;
  spreadsheetId: string;
}): Promise<string[][]> {
  const start = P_ROLES_PIVOT_ANCHOR.rowIndex + 1;
  const g = await options.sheets.spreadsheets.get({
    spreadsheetId: options.spreadsheetId,
    includeGridData: true,
    ranges: [`'${P_ROLES_SHEET_TITLE}'!A${start}:Z${start + 40}`],
    fields: "sheets(data.rowData.values.formattedValue)",
  });
  return (g.data.sheets?.[0]?.data?.[0]?.rowData ?? []).map((r) =>
    (r.values ?? []).map((c) => String(c.formattedValue ?? "").trim())
  );
}

/** Signature of rendered pivot numeric cells — changes when filters change counts. */
function valueSignature(grid: string[][]): string {
  const nums: string[] = [];
  for (const row of grid) {
    for (const cell of row) {
      if (/^\d[\d,]*$/.test(cell)) nums.push(cell.replace(/,/g, ""));
    }
  }
  return nums.join("|");
}

function findJmlHeaderRow(grid: string[][]): string[] {
  for (const row of grid) {
    if (row.some((v) => /Associate Manager|Team Lead|Senior Analyst|12-Associate/i.test(v))) {
      return row.filter(
        (v) =>
          v &&
          v !== P_ROLES_FIELDS.primarySkills &&
          v !== P_ROLES_FIELDS.skillCategorization &&
          v !== "Count of Job Management Level" &&
          v !== P_ROLES_FIELDS.jobManagementLevel &&
          v !== "JML#" &&
          v !== " "
      );
    }
  }
  return [];
}

/**
 * Sheets shows Grand Total on the outer (sort-key) column header row,
 * while JML labels sit on the inner header row.
 */
function findGrandTotalHeaderRow(grid: string[][]): string[] {
  for (const row of grid.slice(0, 6)) {
    const vals = row.filter(
      (v) =>
        v &&
        v !== P_ROLES_FIELDS.primarySkills &&
        v !== P_ROLES_FIELDS.skillCategorization &&
        v !== "Count of Job Management Level" &&
        v !== P_ROLES_FIELDS.jobManagementLevel &&
        v !== "JML#"
    );
    if (vals.includes("Grand Total")) return vals;
  }
  return [];
}

function isNumericAscending(levels: string[]): boolean {
  for (let i = 1; i < levels.length; i++) {
    if (compareJobManagementLevelsByNumericPrefix(levels[i - 1], levels[i]) > 0) {
      return false;
    }
  }
  return levels.length > 0;
}

async function pRolesOnlyBatchUpdate(options: {
  sheets: sheets_v4.Sheets;
  spreadsheetId: string;
  masterSheetId: number;
  pRolesSheetId: number;
  feedSheetId: number | null;
  requests: sheets_v4.Schema$Request[];
}): Promise<void> {
  assertBatchUpdateTargetsOnlyPRoles({
    masterSheetId: options.masterSheetId,
    pRolesSheetId: options.pRolesSheetId,
    allowedExtraSheetIds: options.feedSheetId != null ? [options.feedSheetId] : [],
    requests: options.requests,
  });
  await options.sheets.spreadsheets.batchUpdate({
    spreadsheetId: options.spreadsheetId,
    requestBody: { requests: options.requests },
  });
}

async function setSlicerHiddenValues(options: {
  sheets: sheets_v4.Sheets;
  spreadsheetId: string;
  masterSheetId: number;
  pRolesSheetId: number;
  feedSheetId: number | null;
  slicerId: number;
  hiddenValues: string[];
}): Promise<void> {
  await pRolesOnlyBatchUpdate({
    sheets: options.sheets,
    spreadsheetId: options.spreadsheetId,
    masterSheetId: options.masterSheetId,
    pRolesSheetId: options.pRolesSheetId,
    feedSheetId: options.feedSheetId,
    requests: [
      {
        updateSlicerSpec: {
          slicerId: options.slicerId,
          fields: "filterCriteria",
          spec: {
            filterCriteria: {
              hiddenValues: options.hiddenValues,
            },
          },
        },
      },
    ],
  });
}

async function setPivotFilterCriteria(options: {
  sheets: sheets_v4.Sheets;
  spreadsheetId: string;
  masterSheetId: number;
  pRolesSheetId: number;
  feedSheetId: number | null;
  columnOffsetIndex: number;
  criteria: sheets_v4.Schema$PivotFilterCriteria;
}): Promise<void> {
  const pivots = await findExistingPRolesPivots({
    sheets: options.sheets,
    spreadsheetId: options.spreadsheetId,
    pRolesSheetId: options.pRolesSheetId,
  });
  const hit =
    pivots.find(
      (p) =>
        p.rowIndex === P_ROLES_PIVOT_ANCHOR.rowIndex &&
        p.columnIndex === P_ROLES_PIVOT_ANCHOR.columnIndex
    ) ?? pivots[0];
  if (!hit?.pivot) throw new Error("No P-Roles pivot found for filter update");

  const pivot: sheets_v4.Schema$PivotTable = JSON.parse(JSON.stringify(hit.pivot));
  const specs = pivot.filterSpecs ?? [];
  const idx = specs.findIndex(
    (f) => f.columnOffsetIndex === options.columnOffsetIndex
  );
  if (idx < 0) {
    throw new Error(
      `Pivot missing filterSpec for columnOffsetIndex=${options.columnOffsetIndex}`
    );
  }
  specs[idx] = {
    ...specs[idx],
    filterCriteria: options.criteria,
  };
  pivot.filterSpecs = specs;

  await pRolesOnlyBatchUpdate({
    sheets: options.sheets,
    spreadsheetId: options.spreadsheetId,
    masterSheetId: options.masterSheetId,
    pRolesSheetId: options.pRolesSheetId,
    feedSheetId: options.feedSheetId,
    requests: [
      {
        updateCells: {
          rows: [{ values: [{ pivotTable: pivot }] }],
          start: {
            sheetId: options.pRolesSheetId,
            rowIndex: hit.rowIndex,
            columnIndex: hit.columnIndex,
          },
          fields: "pivotTable",
        },
      },
    ],
  });
}

function fingerprintsEqual(
  a: MasterSheetSourceFingerprint,
  b: MasterSheetSourceFingerprint
): boolean {
  return (
    a.contentSha256 === b.contentSha256 &&
    a.lastSentinelRow1Based === b.lastSentinelRow1Based &&
    a.sentinelNonEmptyCount === b.sentinelNonEmptyCount &&
    JSON.stringify(a.headerRow) === JSON.stringify(b.headerRow)
  );
}

async function main() {
  const checks: Check[] = [];
  const state = await loadState();
  const { sheets } = await getAuthorizedGmailClient();
  const spreadsheetId = state.spreadsheetId;
  const ids = await sheetIds({ sheets, spreadsheetId });

  const fpBefore = await captureMasterSheetFingerprint({
    sheets,
    spreadsheetId,
    masterSheetId: ids.masterSheetId,
  });

  // -------------------------------------------------------------------------
  // TEST 1 — FILTERS
  // -------------------------------------------------------------------------
  const slicers = await listSlicers({
    sheets,
    spreadsheetId,
    pRolesSheetId: ids.pRolesSheetId,
  });
  const slicerTitles = slicers.map((s) => s.title).sort();
  const expectedSorted = [...EXPECTED_FILTERS].sort();
  const filtersExist =
    EXPECTED_FILTERS.every((t) => slicers.some((s) => s.title === t)) &&
    slicers
      .filter((s) => (EXPECTED_FILTERS as readonly string[]).includes(s.title))
      .every((s) => s.applyToPivotTables);

  const pivots = await findExistingPRolesPivots({
    sheets,
    spreadsheetId,
    pRolesSheetId: ids.pRolesSheetId,
  });
  const pivot =
    pivots.find(
      (p) =>
        p.rowIndex === P_ROLES_PIVOT_ANCHOR.rowIndex &&
        p.columnIndex === P_ROLES_PIVOT_ANCHOR.columnIndex
    )?.pivot ?? pivots[0]?.pivot;
  const filterSpecNames = (pivot?.filterSpecs ?? []).map((f) => {
    const map: Record<number, string> = {
      [MASTER_COL.jobStatus]: P_ROLES_FIELDS.jobStatus,
      [MASTER_COL.posted]: P_ROLES_FIELDS.posted,
      [MASTER_COL.marketMap]: P_ROLES_FIELDS.marketMap,
    };
    return map[f.columnOffsetIndex ?? -1] ?? `col:${f.columnOffsetIndex}`;
  });
  const filterSpecsOk =
    EXPECTED_FILTERS.every((n) => filterSpecNames.includes(n)) &&
    filterSpecNames.length >= 3;

  checks.push({
    name: "Filters exist (Job Status / Posted / Market Map)",
    ok: filtersExist && filterSpecsOk,
    detail: `slicers=[${slicerTitles.join(", ")}] applyToPivotTables; filterSpecs=[${filterSpecNames.join(", ")}]`,
  });

  const baselineGrid = await readPivotGrid({ sheets, spreadsheetId });
  const baselineSig = valueSignature(baselineGrid);
  if (!baselineSig) {
    checks.push({
      name: "Filters change PivotTable values",
      ok: false,
      detail: "Baseline pivot has no numeric values to compare",
    });
  } else {
    const filterTrials: Array<{
      label: string;
      columnOffset: number;
      slicerTitle: string;
      pickColumn: number;
    }> = [
      {
        label: P_ROLES_FIELDS.jobStatus,
        columnOffset: MASTER_COL.jobStatus,
        slicerTitle: P_ROLES_FIELDS.jobStatus,
        pickColumn: MASTER_COL.jobStatus,
      },
      {
        label: P_ROLES_FIELDS.posted,
        columnOffset: MASTER_COL.posted,
        slicerTitle: P_ROLES_FIELDS.posted,
        pickColumn: MASTER_COL.posted,
      },
      {
        label: P_ROLES_FIELDS.marketMap,
        columnOffset: MASTER_COL.marketMap,
        slicerTitle: P_ROLES_FIELDS.marketMap,
        pickColumn: MASTER_COL.marketMap,
      },
    ];

    let allFilterChangesOk = true;
    const filterDetails: string[] = [];

    for (const trial of filterTrials) {
      const distinct = await readMasterSheetColumnDistinctValues({
        sheets,
        spreadsheetId,
        columnIndex: trial.pickColumn,
      });
      if (distinct.length < 2) {
        allFilterChangesOk = false;
        filterDetails.push(
          `${trial.label}: need ≥2 distinct source values (got ${distinct.length})`
        );
        continue;
      }

      // Keep only the last distinct value visible (hide the rest) — should shrink counts.
      const keep = distinct[distinct.length - 1];
      const hide = distinct.filter((v) => v !== keep);
      const slicer = slicers.find((s) => s.title === trial.slicerTitle);
      if (!slicer) {
        allFilterChangesOk = false;
        filterDetails.push(`${trial.label}: slicer missing`);
        continue;
      }

      await setSlicerHiddenValues({
        sheets,
        spreadsheetId,
        masterSheetId: ids.masterSheetId,
        pRolesSheetId: ids.pRolesSheetId,
        feedSheetId: ids.feedSheetId,
        slicerId: slicer.slicerId,
        hiddenValues: hide,
      });
      await setPivotFilterCriteria({
        sheets,
        spreadsheetId,
        masterSheetId: ids.masterSheetId,
        pRolesSheetId: ids.pRolesSheetId,
        feedSheetId: ids.feedSheetId,
        columnOffsetIndex: trial.columnOffset,
        criteria: {
          visibleByDefault: false,
          visibleValues: [keep],
        },
      });

      await sleep(2500);
      const afterGrid = await readPivotGrid({ sheets, spreadsheetId });
      const afterSig = valueSignature(afterGrid);
      const changed = afterSig !== baselineSig && afterSig.length > 0;
      filterDetails.push(
        `${trial.label}: keep="${keep}" changed=${changed} (sigLen ${baselineSig.length}→${afterSig.length})`
      );
      if (!changed) allFilterChangesOk = false;

      // Restore this slicer to "nothing hidden" before next trial so effects are isolated.
      // Job Status default (Closed hidden) is fully restored via apply at the end.
      await setSlicerHiddenValues({
        sheets,
        spreadsheetId,
        masterSheetId: ids.masterSheetId,
        pRolesSheetId: ids.pRolesSheetId,
        feedSheetId: ids.feedSheetId,
        slicerId: slicer.slicerId,
        hiddenValues: [],
      });
      await setPivotFilterCriteria({
        sheets,
        spreadsheetId,
        masterSheetId: ids.masterSheetId,
        pRolesSheetId: ids.pRolesSheetId,
        feedSheetId: ids.feedSheetId,
        columnOffsetIndex: trial.columnOffset,
        criteria: { visibleByDefault: true },
      });
      await sleep(1500);
    }

    checks.push({
      name: "Filters change PivotTable values",
      ok: allFilterChangesOk,
      detail: filterDetails.join(" | "),
    });
  }

  // -------------------------------------------------------------------------
  // Restore default pivot (Closed hidden etc.) before hierarchy/order checks
  // -------------------------------------------------------------------------
  const restore = await applyLateralPRolesPivotTable({ forceAppearance: true });
  await sleep(2000);

  // -------------------------------------------------------------------------
  // TEST 2 — ROW HIERARCHY
  // -------------------------------------------------------------------------
  const pivots2 = await findExistingPRolesPivots({
    sheets,
    spreadsheetId,
    pRolesSheetId: ids.pRolesSheetId,
  });
  const pivot2 =
    pivots2.find(
      (p) =>
        p.rowIndex === P_ROLES_PIVOT_ANCHOR.rowIndex &&
        p.columnIndex === P_ROLES_PIVOT_ANCHOR.columnIndex
    )?.pivot ?? pivots2[0]?.pivot;
  const rowLabels = (pivot2?.rows ?? []).map(
    (r) =>
      r.label ||
      (r.sourceColumnOffset === MASTER_COL.primarySkills
        ? P_ROLES_FIELDS.primarySkills
        : r.sourceColumnOffset === MASTER_COL.skillCategorization
          ? P_ROLES_FIELDS.skillCategorization
          : `col:${r.sourceColumnOffset}`)
  );
  const rowOk =
    rowLabels.length === 2 &&
    rowLabels[0] === P_ROLES_FIELDS.primarySkills &&
    rowLabels[1] === P_ROLES_FIELDS.skillCategorization &&
    pivot2?.rows?.[0]?.repeatHeadings === true &&
    pivot2?.rows?.[1]?.repeatHeadings === true;

  checks.push({
    name: "Row hierarchy (Primary Skills → Skill Categorization)",
    ok: rowOk,
    detail: rowLabels.join(" → "),
  });

  // -------------------------------------------------------------------------
  // TEST 3 — JOB MANAGEMENT LEVEL (+ show Closed so 12-Associate can appear)
  // -------------------------------------------------------------------------
  const jmlSource = sortJobManagementLevelsByNumericPrefix(
    await readMasterSheetColumnDistinctValues({
      sheets,
      spreadsheetId,
      columnIndex: MASTER_COL.jobManagementLevel,
    })
  );
  const metaLabels = (pivot2?.columns ?? [])
    .flatMap((c) => c.valueMetadata ?? [])
    .map((m) => m.value?.stringValue || "")
    .filter(Boolean);
  const metaNumeric = sortJobManagementLevelsByNumericPrefix(
    metaLabels.filter((v) => extractJobManagementLevelNumericPrefix(v) != null)
  );
  const metaCoversSource =
    JSON.stringify(metaNumeric) ===
    JSON.stringify(
      jmlSource.filter((v) => extractJobManagementLevelNumericPrefix(v) != null)
    );
  const metaOrderOk = isNumericAscending(metaNumeric);
  const hasGrandTotalColumn = (pivot2?.columns ?? []).some(
    (c) => c.showTotals === true
  );

  // Temporarily show Closed so 12-Associate (Closed-only in source) is displayable.
  const restoredSlicers = await listSlicers({
    sheets,
    spreadsheetId,
    pRolesSheetId: ids.pRolesSheetId,
  });
  const jobStatusSlicer = restoredSlicers.find(
    (s) => s.title === P_ROLES_FIELDS.jobStatus
  );
  if (jobStatusSlicer) {
    await setSlicerHiddenValues({
      sheets,
      spreadsheetId,
      masterSheetId: ids.masterSheetId,
      pRolesSheetId: ids.pRolesSheetId,
      feedSheetId: ids.feedSheetId,
      slicerId: jobStatusSlicer.slicerId,
      hiddenValues: [],
    });
  }
  await setPivotFilterCriteria({
    sheets,
    spreadsheetId,
    masterSheetId: ids.masterSheetId,
    pRolesSheetId: ids.pRolesSheetId,
    feedSheetId: ids.feedSheetId,
    columnOffsetIndex: MASTER_COL.jobStatus,
    criteria: { visibleByDefault: true },
  });
  await sleep(2500);

  const displayGrid = await readPivotGrid({ sheets, spreadsheetId });
  const displayHeader = findJmlHeaderRow(displayGrid);
  const displayLevels = displayHeader.filter((h) => h !== "Grand Total");
  const displayOrderOk = isNumericAscending(displayLevels);
  const gtHeader = findGrandTotalHeaderRow(displayGrid);
  const gtTrailing =
    gtHeader.length > 0 && gtHeader[gtHeader.length - 1] === "Grand Total";
  const expectedCurrent = [
    "8-Associate Manager",
    "9-Team Lead/Consultant",
    "10-Senior Analyst",
    "11-Analyst",
    "12-Associate",
  ];
  const sourceHas12 = jmlSource.some(
    (v) => v.trim().toLowerCase() === "12-associate"
  );
  const displayHasExpected =
    !sourceHas12 ||
    (expectedCurrent.every((e) => displayLevels.includes(e)) &&
      JSON.stringify(
        displayLevels.filter((l) => expectedCurrent.includes(l))
      ) === JSON.stringify(expectedCurrent));

  checks.push({
    name: "Column hierarchy / numeric JML order",
    ok:
      metaCoversSource &&
      metaOrderOk &&
      displayOrderOk &&
      displayHasExpected &&
      metaNumeric.includes("12-Associate") === sourceHas12,
    detail: `source=${jmlSource.join(" → ")} | metadata=${metaNumeric.join(" → ")} | display=${displayHeader.join(" → ")}`,
  });

  checks.push({
    name: "Grand Total trailing",
    ok: hasGrandTotalColumn && gtTrailing,
    detail: `showTotals=${hasGrandTotalColumn}; sortKeyHeader=${gtHeader.join(" → ")}; jmlLabelHeader=${displayHeader.join(" → ")}`,
  });

  // -------------------------------------------------------------------------
  // TEST 4 — FUTURE LEVELS (dynamic sort; invent only in unit check)
  // -------------------------------------------------------------------------
  const futureSample = sortJobManagementLevelsByNumericPrefix([
    "10-Senior Analyst",
    "13-Something",
    "8-Associate Manager",
    "12-Associate",
    "7-Something",
    "11-Analyst",
    "9-Team Lead/Consultant",
  ]);
  const futureOk =
    JSON.stringify(futureSample) ===
    JSON.stringify([
      "7-Something",
      "8-Associate Manager",
      "9-Team Lead/Consultant",
      "10-Senior Analyst",
      "11-Analyst",
      "12-Associate",
      "13-Something",
    ]);
  const sourceHas7 = jmlSource.some(
    (v) => extractJobManagementLevelNumericPrefix(v) === 7
  );
  const sourceHas13 = jmlSource.some(
    (v) => extractJobManagementLevelNumericPrefix(v) === 13
  );
  // If present in source, must sit in correct position in metadata.
  let liveFutureOk = true;
  if (sourceHas7) {
    const i7 = metaNumeric.findIndex(
      (v) => extractJobManagementLevelNumericPrefix(v) === 7
    );
    const i8 = metaNumeric.findIndex(
      (v) => extractJobManagementLevelNumericPrefix(v) === 8
    );
    liveFutureOk = liveFutureOk && i7 >= 0 && (i8 < 0 || i7 < i8);
  }
  if (sourceHas13) {
    const i12 = metaNumeric.findIndex(
      (v) => extractJobManagementLevelNumericPrefix(v) === 12
    );
    const i13 = metaNumeric.findIndex(
      (v) => extractJobManagementLevelNumericPrefix(v) === 13
    );
    liveFutureOk = liveFutureOk && i13 >= 0 && (i12 < 0 || i12 < i13);
  }

  checks.push({
    name: "Dynamic future levels (7 before 8; 13 after 12)",
    ok: futureOk && liveFutureOk,
    detail: `unitOrder=${futureSample.join(" → ")}; sourceHas7=${sourceHas7}; sourceHas13=${sourceHas13}; (not invented if absent)`,
  });

  // -------------------------------------------------------------------------
  // TEST 5 — DATA SOURCE
  // -------------------------------------------------------------------------
  const architecture = await verifyPRolesDataSourceArchitecture({
    spreadsheetId,
  });
  const pivotSourceSheetId = pivot2?.source?.sheetId;
  const sourceIsFeedOrMaster =
    pivotSourceSheetId === ids.feedSheetId ||
    pivotSourceSheetId === ids.masterSheetId;
  const googleOnly =
    architecture.pivotReadsExcelWorkbook === false &&
    architecture.pivotReadsExcelPivotTable === false &&
    architecture.pivotUsesStaticCopiedCache === false &&
    architecture.sourceSpreadsheetMimeType ===
      "application/vnd.google-apps.spreadsheet" &&
    sourceIsFeedOrMaster &&
    (architecture.sourceTab.includes(MASTER_SHEET_TITLE) ||
      architecture.sourceTab.includes(P_ROLES_FEED_SHEET_TITLE));

  checks.push({
    name: "Google Sheet-only data source (not Excel runtime)",
    ok: googleOnly,
    detail: `${architecture.sourceSpreadsheetName} | ${architecture.sourceTab} | ${architecture.sourceRange} | mime=${architecture.sourceSpreadsheetMimeType}`,
  });

  // -------------------------------------------------------------------------
  // Restore defaults again + TEST 6 — SOURCE PROTECTION
  // -------------------------------------------------------------------------
  const restore2 = await applyLateralPRolesPivotTable({ forceAppearance: true });
  const fpAfter = await captureMasterSheetFingerprint({
    sheets,
    spreadsheetId,
    masterSheetId: ids.masterSheetId,
  });
  const sourceProtected =
    fingerprintsEqual(fpBefore, fpAfter) &&
    architecture.masterSheetReadOnlyByPRoles === true &&
    restore.sourceGuard?.masterSheetUnchanged === true &&
    restore2.sourceGuard?.masterSheetUnchanged === true;

  checks.push({
    name: "Source data protected",
    ok: sourceProtected,
    detail: `fingerprintBefore=${fpBefore.contentSha256.slice(0, 16)}… after=${fpAfter.contentSha256.slice(0, 16)}… equal=${fingerprintsEqual(fpBefore, fpAfter)}; apply guards unchanged`,
  });

  // -------------------------------------------------------------------------
  // FINAL RESULT
  // -------------------------------------------------------------------------
  const checklist = [
    {
      key: "Filters",
      ok:
        checks.find((c) => c.name.startsWith("Filters exist"))?.ok === true &&
        checks.find((c) => c.name.startsWith("Filters change"))?.ok === true,
    },
    {
      key: "Row hierarchy",
      ok: checks.find((c) => c.name.startsWith("Row hierarchy"))?.ok === true,
    },
    {
      key: "Column hierarchy",
      ok:
        checks.find((c) => c.name.startsWith("Column hierarchy"))?.ok === true,
    },
    {
      key: "Numeric sorting",
      ok:
        checks.find((c) => c.name.startsWith("Column hierarchy"))?.ok === true,
    },
    {
      key: "Grand Total",
      ok: checks.find((c) => c.name.startsWith("Grand Total"))?.ok === true,
    },
    {
      key: "Dynamic future levels",
      ok: checks.find((c) => c.name.startsWith("Dynamic future"))?.ok === true,
    },
    {
      key: "Google Sheet-only data source",
      ok: checks.find((c) => c.name.startsWith("Google Sheet-only"))?.ok === true,
    },
    {
      key: "Source data protected",
      ok: checks.find((c) => c.name.startsWith("Source data"))?.ok === true,
    },
  ];

  const allPass = checks.every((c) => c.ok) && checklist.every((c) => c.ok);

  const report = {
    FINAL_TEST: allPass ? "PASS" : "FAIL",
    spreadsheetId,
    checks,
    checklist,
  };

  console.log(JSON.stringify(report, null, 2));
  console.log("");
  for (const c of checks) {
    console.log(`${mark(c.ok)} ${c.name}`);
    console.log(`  ${c.detail}`);
  }
  console.log("");
  console.log("==================================================");
  console.log("FINAL RESULT");
  console.log("==================================================");
  for (const c of checklist) {
    console.log(`${mark(c.ok)} ${c.key}`);
  }
  console.log("");
  console.log("FINAL_TEST:", report.FINAL_TEST);

  if (!allPass) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
