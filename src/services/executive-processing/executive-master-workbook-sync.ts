/**
 * Executive Master Workbook mirror sync.
 *
 * Wires the previously-unwired writer/mapping modules
 * (`executive-master-workbook-writer.ts`, `executive-new-sheet-mapping.ts`)
 * into the real "Run All" job. Runs AFTER `executive_master` has already
 * been fully updated for this run (reconcile + posted refresh both
 * committed) — Postgres is always the source of truth; this is a
 * best-effort mirror of that already-correct state into the real Excel
 * Master Workbook on Drive.
 *
 * A failure here is returned as a typed `ok:false` and MUST NOT be allowed
 * by the caller (`executive-job.ts`) to fail the overall run or block the
 * Gmail checkpoint from advancing — same invariant already proven for
 * Lateral's own "Skipped VBA finalize (Postgres primary)" pattern, and
 * directly verified for the underlying write path via the fake-job
 * orchestration test (Checkpoint 3, excel-fail mode) before this was wired
 * in for real. This function itself never throws.
 *
 * Design choice (deliberate, keeps already-approved code untouched):
 * rather than threading per-JR decision objects out of
 * `reconcileExecutiveMasterFromBaseDs` / `refreshExecutivePostedFromSheet`
 * (which would mean changing their signatures), this:
 *  - re-reads today's Base DS file (already downloaded, still on disk —
 *    `executive-gmail-incremental-sync.ts` never deletes it — via the same
 *    reader/mapper those functions themselves use) to build New Sheet's
 *    snapshot, and
 *  - reads `executive_master`'s FULL current state directly from Postgres
 *    for Master Sheet's Job Status/Posted columns.
 * This is a true "read back what's now true" mirror, never a parallel
 * computation that could drift from what Postgres actually says. The cost
 * (rewriting every Master Sheet row's Job Status/Posted every run, not just
 * a delta) is negligible at this table's size (~1,576 rows) and makes the
 * mirror self-healing if a prior run's mirror step was ever skipped.
 */
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { drive_v3 } from "googleapis";
import { getDbClient } from "@/lib/persistence/db-client";
import { getAuthorizedGmailClient } from "@/services/gmail/oauth";
import { getExecutiveMasterDriveFileId } from "@/lib/config/runtime";
import {
  readExecutiveBaseDsSheet,
  ExecutiveBaseDsReadError,
} from "@/services/executive-processing/executive-base-ds-reader";
import {
  EXECUTIVE_BASE_DS_SHEET_NAME,
  resolveExecutiveBaseDsHeaderIndex,
  mapExecutiveBaseDsRow,
  type ExecutiveMappedRow,
} from "@/services/executive-processing/executive-base-ds-mapping";
import { normalizeExecutiveJobRequisitionId } from "@/services/executive-processing/executive-job-status-rules";
import { mapExecutiveRowsToNewSheetRows } from "@/services/executive-processing/executive-new-sheet-mapping";
import { writeExecutiveMasterWorkbookUpdates } from "@/services/executive-processing/executive-master-workbook-writer";

const execFileAsync = promisify(execFile);
const XLSM_MIME = "application/vnd.ms-excel.sheet.macroEnabled.12";

export interface ExecutiveMasterWorkbookSyncSuccess {
  ok: true;
  newSheetRowsWritten: number;
  masterRowsUpdated: number;
  driveFileId: string;
  message: string;
}
export interface ExecutiveMasterWorkbookSyncFailure {
  ok: false;
  phase: "read_demand_sheet" | "download" | "write" | "verify" | "upload";
  reason: string;
}
export type ExecutiveMasterWorkbookSyncResult =
  | ExecutiveMasterWorkbookSyncSuccess
  | ExecutiveMasterWorkbookSyncFailure;

async function verifyLocalWorkbookBeforeUpload(
  localPath: string
): Promise<string | null> {
  const scriptPath = path.join(
    os.tmpdir(),
    `executive-master-workbook-verify-${Date.now()}.py`
  );
  const script = `
import json, sys, zipfile
path = sys.argv[1]
try:
    with zipfile.ZipFile(path) as z:
        names = z.namelist()
        has_vba = "xl/vbaProject.bin" in names
        wb_xml = z.read("xl/workbook.xml").decode("utf-8", errors="replace")
        has_master = 'name="Master Sheet"' in wb_xml
        has_new = 'name="New Sheet"' in wb_xml
    if not has_vba:
        print(json.dumps({"ok": False, "error": "vbaProject.bin missing after write -- refusing to upload"}))
    elif not has_master or not has_new:
        print(json.dumps({"ok": False, "error": "Master Sheet or New Sheet missing after write -- refusing to upload"}))
    else:
        print(json.dumps({"ok": True}))
except Exception as e:
    print(json.dumps({"ok": False, "error": str(e)}))
`.trim();
  await fs.writeFile(scriptPath, script, "utf8");
  try {
    const { stdout } = await execFileAsync("python3", [scriptPath, localPath], {
      windowsHide: true,
      timeout: 60_000,
    });
    const parsed = JSON.parse((stdout || "").trim()) as
      | { ok: true }
      | { ok: false; error: string };
    return parsed.ok ? null : parsed.error;
  } catch (error) {
    return error instanceof Error ? error.message : "Local workbook verification failed.";
  } finally {
    await fs.unlink(scriptPath).catch(() => undefined);
  }
}

/**
 * Mirror current executive_master state into the real Master Workbook on
 * Drive. Never throws — every failure mode returns a typed `ok:false`.
 */
export async function syncExecutiveMasterWorkbookMirror(options: {
  localDemandWorkbookPath: string;
  demandSheetName?: string;
  /** Test-only: inject a Drive client (e.g. to stub the final upload call). */
  drive?: drive_v3.Drive;
}): Promise<ExecutiveMasterWorkbookSyncResult> {
  let localMasterPath: string | null = null;
  try {
    // 1. Re-read today's Base DS to build New Sheet's snapshot.
    let sheet;
    try {
      sheet = await readExecutiveBaseDsSheet(
        options.localDemandWorkbookPath,
        options.demandSheetName?.trim() || EXECUTIVE_BASE_DS_SHEET_NAME
      );
    } catch (error) {
      return {
        ok: false,
        phase: "read_demand_sheet",
        reason:
          error instanceof ExecutiveBaseDsReadError || error instanceof Error
            ? error.message
            : "Failed to re-read Base DS sheet for the Excel mirror.",
      };
    }
    const headerIndex = resolveExecutiveBaseDsHeaderIndex(sheet.headers);
    if (headerIndex.jobRequisitionId < 0) {
      return {
        ok: false,
        phase: "read_demand_sheet",
        reason:
          'Base DS is missing "Job Requisition ID" -- cannot build New Sheet mirror.',
      };
    }
    const mappedRows: ExecutiveMappedRow[] = [];
    const seenJr = new Set<string>();
    for (const row of sheet.dataRows) {
      const mapped = mapExecutiveBaseDsRow(headerIndex, row);
      if (!mapped) continue;
      const jr = normalizeExecutiveJobRequisitionId(mapped.jobRequisitionId);
      // Duplicates are already rejected upstream by reconcile; skip defensively.
      if (!jr || seenJr.has(jr)) continue;
      seenJr.add(jr);
      mappedRows.push({ ...mapped, jobRequisitionId: jr });
    }
    const newSheetRows = mapExecutiveRowsToNewSheetRows(mappedRows);

    // 2. Read executive_master's FULL current state for Master Sheet.
    const sql = getDbClient();
    const masterRows = await sql<
      { job_requisition_id: string; job_status: string | null; posted: string | null }[]
    >`SELECT job_requisition_id, job_status, posted FROM executive_master`;
    const masterSheetUpdates = masterRows.map((r) => ({
      jobRequisitionId: r.job_requisition_id,
      fields: {
        "Job Status": r.job_status,
        Posted: r.posted,
      },
    }));

    // 3. Download the real Master Workbook fresh (no cache -- about to overwrite it).
    const fileId = getExecutiveMasterDriveFileId();
    const drive = options.drive ?? (await getAuthorizedGmailClient()).drive;
    let meta;
    try {
      meta = await drive.files.get({
        fileId,
        fields: "id,name,mimeType,trashed,modifiedTime",
        supportsAllDrives: true,
      });
    } catch (error) {
      return {
        ok: false,
        phase: "download",
        reason: `Master Workbook (Drive id=${fileId}) was not found or is not accessible: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      };
    }
    if (meta.data.trashed) {
      return {
        ok: false,
        phase: "download",
        reason: `Master Workbook "${meta.data.name}" is in Google Drive trash -- treated as unreadable, not restored automatically.`,
      };
    }

    const resp = await drive.files.get(
      { fileId, alt: "media", supportsAllDrives: true },
      { responseType: "arraybuffer" }
    );
    localMasterPath = path.join(
      os.tmpdir(),
      `executive-master-mirror-${Date.now()}.xlsm`
    );
    await fs.writeFile(localMasterPath, Buffer.from(resp.data as ArrayBuffer));

    // 4. Write New Sheet + Master Sheet updates locally.
    const writeResult = await writeExecutiveMasterWorkbookUpdates({
      localPath: localMasterPath,
      newSheetRows,
      masterSheetUpdates,
    });
    if (!writeResult.ok) {
      return { ok: false, phase: "write", reason: writeResult.reason };
    }

    // 5. Safety verify before upload -- still a valid zip, VBA project
    // intact, both required tabs present.
    const verifyError = await verifyLocalWorkbookBeforeUpload(localMasterPath);
    if (verifyError) {
      return { ok: false, phase: "verify", reason: verifyError };
    }

    // 6. Upload in place -- always update, never create a second file.
    await drive.files.update({
      fileId,
      requestBody: { name: meta.data.name ?? undefined, mimeType: XLSM_MIME },
      media: { mimeType: XLSM_MIME, body: createReadStream(localMasterPath) },
      fields: "id,name,mimeType,modifiedTime",
      supportsAllDrives: true,
    });

    return {
      ok: true,
      newSheetRowsWritten: writeResult.newSheetRowsWritten,
      masterRowsUpdated: writeResult.masterUpdatesApplied.length,
      driveFileId: fileId,
      message: `Master Workbook mirror updated: ${writeResult.newSheetRowsWritten} New Sheet row(s), ${writeResult.masterUpdatesApplied.length} Master Sheet row(s).`,
    };
  } catch (error) {
    return {
      ok: false,
      phase: "upload",
      reason:
        error instanceof Error
          ? `Excel mirror sync failed: ${error.message}`
          : "Excel mirror sync failed.",
    };
  } finally {
    if (localMasterPath) await fs.unlink(localMasterPath).catch(() => undefined);
  }
}
