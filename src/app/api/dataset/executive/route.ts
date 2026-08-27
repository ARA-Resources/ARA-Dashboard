import { NextResponse } from "next/server";
import { getExecutiveIngestionConfigStatus } from "@/services/dataset/executive-ingestion-config";
import { getExecutiveIngestionPublicStatus } from "@/services/dataset/executive-ingestion-state";
import { runExecutiveWorkbookIngestion } from "@/services/dataset/executive-ingestion";
import {
  getExecutiveDatasetImportConfigStatus,
  runExecutiveDatasetImport,
} from "@/services/dataset/executive-dataset-import";
import { isGmailOAuthConfigured } from "@/services/gmail/oauth";
import { runExecutiveMasterReconcileDryRunService } from "@/services/executive-processing/executive-master-reconcile-service";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Executive Dataset API
 * GET  — status (4A + 4B + 4C readiness)
 * POST action=fetch — Phase 4A XLSM → Drive (legacy)
 * POST action=import-dataset | fetch-latest-ds — Phase 4B Base DS → New Sheet
 * POST action=process-master-sheet — Phase 4C dry-run reconciliation (no Master write)
 */
export async function GET() {
  try {
    const config4a = getExecutiveIngestionConfigStatus();
    const config4b = getExecutiveDatasetImportConfigStatus();
    const status = await getExecutiveIngestionPublicStatus();
    const oauthConfigured = isGmailOAuthConfigured();

    return NextResponse.json({
      ok: true,
      phase: "4C",
      scope: "executive-master-reconcile-dry-run",
      claims: {
        workbookFetchedAndStored: true,
        newSheetUpdated: true,
        masterSheetProcessed: false,
        masterSheetLiveWriteEnabled: false,
      },
      oauthConfigured,
      config: {
        // Phase 4A (XLSM → Drive)
        fetchReady: config4a.fetchReady,
        gmailSearchConfigured: config4a.gmailSearchConfigured,
        driveUploadConfigured: config4a.driveUploadConfigured,
        gmailFromConfigured: config4a.gmailFromConfigured,
        gmailSubjectConfigured: config4a.gmailSubjectConfigured,
        gmailKeywordsConfigured: config4a.gmailKeywordsConfigured,
        attachmentPatternConfigured: config4a.attachmentPatternConfigured,
        masterDriveFileConfigured: config4a.masterDriveFileConfigured,
        missing: config4a.missing,
        notes: config4a.notes,
      },
      datasetImport: {
        fetchReady: config4b.fetchReady,
        spreadsheetConfigured: config4b.spreadsheetConfigured,
        spreadsheetIdMasked: config4b.spreadsheetIdMasked,
        attachmentPattern: config4b.attachmentPattern,
        sourceSheet: config4b.sourceSheet,
        destinationSheet: config4b.destinationSheet,
        missing: config4b.missing,
        notes: config4b.notes,
      },
      source: status,
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to load Executive dataset status.";
    console.error("[api/dataset/executive]", message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      action?: string;
    };
    const action = body.action ?? "import-dataset";

    if (action === "fetch") {
      const result = await runExecutiveWorkbookIngestion();
      const status =
        result.ok || result.phase === "skipped_duplicate" ? 200 : 422;
      return NextResponse.json(
        {
          ok: result.ok,
          phase: result.phase,
          message: result.message,
          result: {
            skippedDuplicate: result.skippedDuplicate ?? false,
            sourceMessageId: result.sourceMessageId,
            attachmentName: result.attachmentName,
            checksumSha256: result.checksumSha256
              ? `${result.checksumSha256.slice(0, 12)}…`
              : undefined,
            driveFileId: result.driveFileId,
            replacedExisting: result.replacedExisting,
            processedAt: result.processedAt,
            localCurrentRelative: result.localCurrentRelative,
            candidatesConsidered: result.candidatesConsidered,
            validationError: result.validationError,
            previousSourcePreserved: result.previousSourcePreserved,
          },
          notice:
            "Phase 4A only. Workbook fetched and stored — Master Sheet is not processed.",
        },
        { status }
      );
    }

    if (
      action === "import-dataset" ||
      action === "fetch-latest-ds" ||
      action === "fetch-latest-executive-ds"
    ) {
      const result = await runExecutiveDatasetImport();
      const status = result.ok ? 200 : 422;
      return NextResponse.json(
        {
          ok: result.ok,
          phase: result.phase,
          message: result.message,
          result: {
            existingNewSheetUnchanged: result.existingNewSheetUnchanged,
            clearedBeforeWrite: result.clearedBeforeWrite,
            partialWrite: result.partialWrite,
            attachmentName: result.attachmentName,
            sourceMessageId: result.sourceMessageId,
            sourceRowCount: result.sourceRowCount,
            destinationRowCount: result.destinationRowCount,
            sheetName: result.sheetName,
            // Do not return full spreadsheet ID to the browser
            spreadsheetIdMasked: result.spreadsheetId
              ? `${result.spreadsheetId.slice(0, 6)}…${result.spreadsheetId.slice(-4)}`
              : undefined,
            unmappedDestinationHeaders: result.unmappedDestinationHeaders,
            processedAt: result.processedAt,
          },
          notice:
            "Phase 4B only. Google Sheet New Sheet updated — Master Sheet is not processed.",
        },
        { status }
      );
    }

    if (
      action === "process-master-sheet" ||
      action === "reconcile-master-sheet"
    ) {
      // Phase 4C safety: dry-run only. Live Master Sheet writes are not enabled.
      const result = await runExecutiveMasterReconcileDryRunService();
      const status = result.ok ? 200 : 422;
      return NextResponse.json(
        {
          ok: result.ok,
          phase: "process-master-sheet-dry-run",
          dryRun: true,
          masterSheetWritePerformed: false,
          message: result.ok
            ? "Executive Master Sheet dry-run reconciliation completed. Master Sheet was not modified."
            : `Dry-run blocked: ${result.blockers.join(" ")}`,
          result: {
            rowsProcessed: result.projectedMasterRows.length,
            newCount: result.counts.new,
            reopenCount: result.counts.reopen,
            activeCount: result.counts.active,
            closedCount: result.counts.closed,
            unchangedCount: result.counts.unchanged,
            postedYesCount: result.counts.postedYes,
            postedDashCount: result.counts.postedDash,
            newSheetRows: result.counts.newSheetRows,
            masterSheetRows: result.counts.masterSheetRows,
            postedSheetRows: result.counts.postedSheetRows,
            uniqueNewJrIds: result.counts.uniqueNewJrIds,
            uniqueMasterJrIds: result.counts.uniqueMasterJrIds,
            uniquePostedJrIds: result.counts.uniquePostedJrIds,
            duplicates: result.duplicates,
            blockers: result.blockers,
            notes: result.notes,
            processingDate: result.processingDate,
            sources: result.sources,
            timestamp: new Date().toISOString(),
            // Sample of changes only (avoid huge payloads)
            changeSample: result.changes.slice(0, 25),
            changeCount: result.changes.length,
          },
          notice:
            "Phase 4C DRY-RUN. Live Master Sheet write is disabled until dry-run review.",
        },
        { status }
      );
    }

    return NextResponse.json(
      {
        ok: false,
        error:
          "Unsupported action. Use action=import-dataset (Phase 4B), action=process-master-sheet (Phase 4C dry-run), or action=fetch (Phase 4A).",
      },
      { status: 400 }
    );
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Executive dataset request failed.";
    console.error("[api/dataset/executive POST]", message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
