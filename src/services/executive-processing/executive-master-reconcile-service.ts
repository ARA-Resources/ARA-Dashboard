import "server-only";

import { getAuthorizedGmailClient } from "@/services/gmail/oauth";
import { readExecutiveMasterSheet } from "@/services/excel/read-executive-master-sheet";
import {
  EXECUTIVE_NEW_SHEET_NAME,
  EXECUTIVE_NEW_SHEET_SPREADSHEET_ID_DEFAULT,
} from "@/services/dataset/executive-dataset-mapping";
import { peekExecutiveNewSheetSpreadsheetId } from "@/lib/config/runtime";
import { EXECUTIVE_POSTED_SHEET_NAME } from "@/services/executive-processing/executive-posted-rules";
import {
  runExecutiveMasterReconcileDryRun,
  type ExecutiveNewSheetRow,
  type ExecutiveReconcileDryRunResult,
} from "@/services/executive-processing/executive-master-reconcile-engine";
import {
  readExecutivePostedSheetRowsFromWorkbook,
  runExecutiveMasterReconcileDryRunFromLocalWorkbook,
} from "@/services/executive-processing/executive-master-reconcile-local";

export {
  readExecutivePostedSheetRowsFromWorkbook as readExecutivePostedSheetRows,
  runExecutiveMasterReconcileDryRunFromLocalWorkbook,
};

function resolveSpreadsheetId(): string {
  return (
    peekExecutiveNewSheetSpreadsheetId() ||
    EXECUTIVE_NEW_SHEET_SPREADSHEET_ID_DEFAULT
  );
}

async function readNewSheetFromGoogle(): Promise<ExecutiveNewSheetRow[]> {
  const spreadsheetId = resolveSpreadsheetId();
  const { sheets } = await getAuthorizedGmailClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${EXECUTIVE_NEW_SHEET_NAME.replace(/'/g, "''")}'!A1:ZZ`,
    majorDimension: "ROWS",
  });
  const values = res.data.values ?? [];
  if (values.length === 0) {
    throw new Error("Executive New Sheet is empty.");
  }
  const headers = (values[0] ?? []).map((cell) =>
    cell === null || cell === undefined ? "" : String(cell).trim()
  );
  const jrHeader = headers.find((h) =>
    /^job\s*requisition\s*id$/i.test(h.replace(/\s+/g, " "))
  );
  if (!jrHeader) {
    throw new Error(
      'New Sheet is missing "Job requisition ID" (or Job Requisition ID) header.'
    );
  }

  const rows: ExecutiveNewSheetRow[] = [];
  for (let i = 1; i < values.length; i += 1) {
    const raw = values[i] ?? [];
    const row: ExecutiveNewSheetRow = { id: `new-${i}` };
    let hasAny = false;
    for (let c = 0; c < headers.length; c += 1) {
      const header = headers[c];
      if (!header) continue;
      const value = raw[c];
      if (value !== null && value !== undefined && String(value).trim() !== "") {
        hasAny = true;
      }
      row[header] = value ?? null;
    }
    if (hasAny) rows.push(row);
  }
  return rows;
}

/**
 * Phase 4C dry-run ONLY. Never writes Master Sheet.
 * Sources: Google New Sheet + Executive Master + Posted Sheet from XLSM.
 */
export async function runExecutiveMasterReconcileDryRunService(): Promise<
  ExecutiveReconcileDryRunResult & {
    sources: {
      newSheet: string;
      masterSheet: string;
      postedSheet: string;
      spreadsheetIdMasked: string;
    };
  }
> {
  const spreadsheetId = resolveSpreadsheetId();
  const [master, newSheetRows, postedSheetRows] = await Promise.all([
    readExecutiveMasterSheet({ bypassCache: true }),
    readNewSheetFromGoogle(),
    readExecutivePostedSheetRowsFromWorkbook(),
  ]);

  const result = runExecutiveMasterReconcileDryRun({
    masterRows: master.rows,
    newSheetRows,
    postedSheetRows,
  });

  return {
    ...result,
    sources: {
      newSheet: EXECUTIVE_NEW_SHEET_NAME,
      masterSheet: master.sheetName,
      postedSheet: EXECUTIVE_POSTED_SHEET_NAME,
      spreadsheetIdMasked: `${spreadsheetId.slice(0, 6)}…${spreadsheetId.slice(-4)}`,
    },
  };
}
