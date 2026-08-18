/**
 * Verify P-Roles never writes Master Sheet (source-guard unit checks + live fingerprint).
 * Run: npx tsx scripts/verify-lateral-p-roles-source-readonly.ts
 */
import type { sheets_v4 } from "googleapis";
import {
  assertBatchUpdateTargetsOnlyPRoles,
  assertValuesWriteRangeIsNotMasterSheet,
  captureMasterSheetFingerprint,
} from "../src/services/lateral-processing/lateral-p-roles-source-guard";
import {
  MASTER_SHEET_TITLE,
  verifyPRolesDataSourceArchitecture,
} from "../src/services/lateral-processing/lateral-p-roles-sheets-pivot";
import { getAuthorizedGmailClient } from "../src/services/gmail/oauth";

function expectThrows(label: string, fn: () => void) {
  try {
    fn();
    throw new Error(`${label}: expected throw, but succeeded`);
  } catch (e) {
    if (e instanceof Error && e.message.startsWith(`${label}:`)) throw e;
    // expected
  }
}

function runLocalGuardChecks() {
  const masterSheetId = 111;
  const pRolesSheetId = 222;

  expectThrows("master updateCells", () => {
    assertBatchUpdateTargetsOnlyPRoles({
      masterSheetId,
      pRolesSheetId,
      requests: [
        {
          updateCells: {
            start: { sheetId: masterSheetId, rowIndex: 0, columnIndex: 0 },
            fields: "userEnteredValue",
          },
        },
      ],
    });
  });

  expectThrows("copyPaste", () => {
    assertBatchUpdateTargetsOnlyPRoles({
      masterSheetId,
      pRolesSheetId,
      requests: [
        {
          copyPaste: {
            source: { sheetId: pRolesSheetId },
            destination: { sheetId: masterSheetId },
          },
        },
      ],
    });
  });

  expectThrows("sortRange", () => {
    assertBatchUpdateTargetsOnlyPRoles({
      masterSheetId,
      pRolesSheetId,
      requests: [
        {
          sortRange: {
            range: { sheetId: masterSheetId, startRowIndex: 1 },
          },
        },
      ],
    });
  });

  expectThrows("values write master", () => {
    assertValuesWriteRangeIsNotMasterSheet(`'${MASTER_SHEET_TITLE}'!A1`);
  });

  // Allowed: P-Roles-only pivot write
  assertBatchUpdateTargetsOnlyPRoles({
    masterSheetId,
    pRolesSheetId,
    requests: [
      {
        updateCells: {
          start: { sheetId: pRolesSheetId, rowIndex: 0, columnIndex: 0 },
          fields: "pivotTable",
        },
      },
    ] as sheets_v4.Schema$Request[],
  });

  console.log("LOCAL_GUARD_CHECKS_PASSED");
}

async function main() {
  runLocalGuardChecks();

  const architecture = await verifyPRolesDataSourceArchitecture();
  if (!architecture.masterSheetReadOnlyByPRoles) {
    throw new Error("architecture.masterSheetReadOnlyByPRoles must be true");
  }

  const { sheets } = await getAuthorizedGmailClient();
  const ss = await sheets.spreadsheets.get({
    spreadsheetId: architecture.sourceSpreadsheetId,
    fields: "sheets.properties",
  });
  const master = (ss.data.sheets ?? []).find(
    (s) => s.properties?.title === MASTER_SHEET_TITLE
  );
  if (master?.properties?.sheetId == null) {
    throw new Error(`Missing ${MASTER_SHEET_TITLE}`);
  }

  const fingerprint = await captureMasterSheetFingerprint({
    sheets,
    spreadsheetId: architecture.sourceSpreadsheetId,
    masterSheetId: master.properties.sheetId,
  });

  console.log(
    JSON.stringify(
      {
        architecture,
        masterSheetFingerprint: {
          contentSha256: fingerprint.contentSha256,
          lastSentinelRow1Based: fingerprint.lastSentinelRow1Based,
          sentinelNonEmptyCount: fingerprint.sentinelNonEmptyCount,
          headerRow: fingerprint.headerRow,
        },
      },
      null,
      2
    )
  );
  console.log("VERIFICATION_PASSED");
}

main().catch((error) => {
  console.error(error);
  console.error("VERIFICATION_FAILED");
  process.exit(1);
});
