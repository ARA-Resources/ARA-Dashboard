/**
 * Executive Posted Sheet -> executive_master.posted full refresh (Phase E6).
 *
 * Safety rule (confirmed, same spirit as Lateral): if the Posted Sheet comes
 * back empty/unreadable for ANY reason (file not found, trashed, tab
 * missing, required columns missing, zero data rows, Drive connection
 * failure), this is treated as a likely error — `executive_master.posted`
 * is NOT touched for anyone. A partial/garbled read is never allowed to
 * mass-clear real "Yes" values to "-".
 *
 * On a successful read: full refresh every run — every JR currently in
 * executive_master gets `posted` re-derived from the Posted Sheet, never
 * just newly-added rows, matching the confirmed rule exactly.
 *
 * Never touches job_status, descriptive fields, created_at, or last_seen_at
 * — this module owns exactly one column.
 */
import type { drive_v3 } from "googleapis";
import { getDbClient } from "@/lib/persistence/db-client";
import {
  buildExecutivePostedDemandMap,
  resolveExecutivePostedFromDemandMap,
} from "@/services/executive-processing/executive-posted-demand-rule";
import { readExecutivePostedSheet } from "@/services/executive-processing/executive-posted-sheet-reader";

export interface ExecutivePostedRefreshCounts {
  masterJrCount: number;
  postedSheetRowCount: number;
  postedYes: number;
  postedDash: number;
  changed: number;
}

export type ExecutivePostedRefreshResult =
  | {
      ok: true;
      skipped: false;
      counts: ExecutivePostedRefreshCounts;
      sourceFileName: string;
      message: string;
    }
  | {
      ok: false;
      skipped: true;
      reason: string;
      message: string;
    };

export async function refreshExecutivePostedFromSheet(options?: {
  driveFileId?: string;
  sheetName?: string;
  /** Test-only: inject a fake Drive client to avoid live credentials. */
  drive?: drive_v3.Drive;
}): Promise<ExecutivePostedRefreshResult> {
  const sheetResult = await readExecutivePostedSheet(options);

  if (!sheetResult.ok) {
    return {
      ok: false,
      skipped: true,
      reason: sheetResult.reason,
      message: `Posted Sheet refresh SKIPPED (source unreadable) — executive_master.posted was not modified. Reason: ${sheetResult.reason}`,
    };
  }

  const demandMap = buildExecutivePostedDemandMap(sheetResult.rows);

  const sql = getDbClient();
  const masterRows = await sql<{ job_requisition_id: string; posted: string | null }[]>`
    SELECT job_requisition_id, posted FROM executive_master
  `;

  const yesIds: string[] = [];
  const dashIds: string[] = [];
  let changed = 0;

  for (const row of masterRows) {
    const next = resolveExecutivePostedFromDemandMap(
      row.job_requisition_id,
      demandMap
    );
    if (next !== (row.posted ?? "-")) changed += 1;
    if (next === "Yes") yesIds.push(row.job_requisition_id);
    else dashIds.push(row.job_requisition_id);
  }

  await sql.begin(async (tx) => {
    const BATCH = 500;
    for (let i = 0; i < yesIds.length; i += BATCH) {
      const chunk = yesIds.slice(i, i + BATCH);
      await tx`
        UPDATE executive_master
        SET posted = 'Yes', updated_at = NOW()
        WHERE job_requisition_id = ANY(${chunk})
          AND posted IS DISTINCT FROM 'Yes'
      `;
    }
    for (let i = 0; i < dashIds.length; i += BATCH) {
      const chunk = dashIds.slice(i, i + BATCH);
      await tx`
        UPDATE executive_master
        SET posted = '-', updated_at = NOW()
        WHERE job_requisition_id = ANY(${chunk})
          AND posted IS DISTINCT FROM '-'
      `;
    }
  });

  const counts: ExecutivePostedRefreshCounts = {
    masterJrCount: masterRows.length,
    postedSheetRowCount: sheetResult.rows.length,
    postedYes: yesIds.length,
    postedDash: dashIds.length,
    changed,
  };

  return {
    ok: true,
    skipped: false,
    counts,
    sourceFileName: sheetResult.fileName,
    message: `Posted refreshed from "${sheetResult.fileName}": ${counts.postedYes} Yes / ${counts.postedDash} - (${counts.changed} changed of ${counts.masterJrCount} JR(s)).`,
  };
}
