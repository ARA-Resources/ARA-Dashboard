/**
 * Phase E3 — Executive demand sheet (Base DS) → PostgreSQL `executive_master`.
 *
 * Single combined step (unlike Lateral's two-step staging-upsert +
 * job-status-sync — Executive has no staging table, per the approved
 * "Postgres-only pipeline" decision): for every JR present in today's
 * demand sheet, refresh ALL descriptive fields AND recompute job_status in
 * one UPSERT — "descriptive fields refresh on every run, not just insert"
 * (approved). For every JR that exists in executive_master but is absent
 * from today's demand sheet (full snapshot — confirmed safe to treat
 * "absent = Closed"), flip job_status to Closed only; never touch its
 * descriptive fields (no incoming data exists for it) or last_seen_at.
 *
 * Never touches `posted` on existing rows (Phase E6 owns that column).
 * Never touches `created_at` on existing rows.
 * Does NOT acquire `acquireExecutiveJobLock()` and does NOT advance the
 * Gmail checkpoint — both belong to Phase E4's orchestrator, which will call
 * this function, then the checkpoint advance, only after this succeeds.
 * Callable and independently testable; wired into nothing live yet.
 */
import { getDbClient } from "@/lib/persistence/db-client";
import {
  readExecutiveBaseDsSheet,
  ExecutiveBaseDsReadError,
} from "@/services/executive-processing/executive-base-ds-reader";
import {
  EXECUTIVE_BASE_DS_SHEET_NAME,
  mapExecutiveBaseDsRow,
  resolveExecutiveBaseDsHeaderIndex,
  type ExecutiveMappedRow,
} from "@/services/executive-processing/executive-base-ds-mapping";
import {
  normalizeExecutiveJobRequisitionId,
  resolveExecutiveJobStatus,
  type ExecutiveMasterJobStatus,
  type ExecutiveStatusAction,
} from "@/services/executive-processing/executive-job-status-rules";
import { normalizeExecutivePriority } from "@/services/executive-processing/executive-priority-normalize";

export interface ExecutiveMasterReconcileOptions {
  localWorkbookPath: string;
  sheetName?: string;
  /** YYYY-MM-DD. Defaults to today (local). */
  processingDateIso?: string;
}

export interface ExecutiveMasterReconcileCellWarning {
  jobRequisitionId: string;
  column: string;
  errorType: string;
}

export interface ExecutiveMasterReconcileCounts {
  demandRowCount: number;
  uniqueDemandJrCount: number;
  masterJrCountBefore: number;
  added: number;
  reopened: number;
  activated: number;
  unchanged: number;
  closed: number;
  masterJrCountAfter: number | null;
}

export type ExecutiveMasterReconcileResult =
  | {
      ok: true;
      counts: ExecutiveMasterReconcileCounts;
      processingDateIso: string;
      /** Per-cell Excel-error blanks (row/column/errorType) — never fails the run. */
      cellErrorWarnings: ExecutiveMasterReconcileCellWarning[];
      /** Confirmed columns not found in this file's header row. */
      headerWarnings: string[];
      message: string;
    }
  | { ok: false; error: string };

function todayIsoLocal(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

interface PlannedRow {
  jobRequisitionId: string;
  values: ExecutiveMappedRow["values"];
  status: ExecutiveMasterJobStatus;
  action: ExecutiveStatusAction;
  dateIso: string | null;
}

/**
 * Reconcile Executive demand sheet (Base DS) into `executive_master`.
 * Pure function of (workbook path, processing date) → Postgres write.
 * No lock, no checkpoint advance, no live trigger — see module doc.
 */
export async function reconcileExecutiveMasterFromBaseDs(
  options: ExecutiveMasterReconcileOptions
): Promise<ExecutiveMasterReconcileResult> {
  const sheetName = options.sheetName?.trim() || EXECUTIVE_BASE_DS_SHEET_NAME;
  const processingDateIso = options.processingDateIso?.trim() || todayIsoLocal();

  let sheet: Awaited<ReturnType<typeof readExecutiveBaseDsSheet>>;
  try {
    sheet = await readExecutiveBaseDsSheet(options.localWorkbookPath, sheetName);
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof ExecutiveBaseDsReadError
          ? error.message
          : error instanceof Error
            ? error.message
            : "Failed to read Base DS sheet.",
    };
  }

  const headerIndex = resolveExecutiveBaseDsHeaderIndex(sheet.headers);
  if (headerIndex.jobRequisitionId < 0) {
    return {
      ok: false,
      error:
        'Base DS is missing "Job Requisition ID" — cannot reconcile executive_master.',
    };
  }

  const demandByJr = new Map<string, ExecutiveMappedRow>();
  const duplicateJrs = new Set<string>();
  const cellErrorWarnings: ExecutiveMasterReconcileCellWarning[] = [];

  for (const row of sheet.dataRows) {
    const mapped = mapExecutiveBaseDsRow(headerIndex, row);
    if (!mapped) continue; // blank JR — skip, mirrors Lateral precedent
    const jr = normalizeExecutiveJobRequisitionId(mapped.jobRequisitionId);
    if (!jr) continue;

    if (demandByJr.has(jr)) {
      duplicateJrs.add(jr);
      continue;
    }
    demandByJr.set(jr, { ...mapped, jobRequisitionId: jr });
    for (const err of mapped.errors) {
      cellErrorWarnings.push({ jobRequisitionId: jr, ...err });
    }
  }

  if (duplicateJrs.size > 0) {
    return {
      ok: false,
      error: `Duplicate Job Requisition ID(s) in Base DS: ${[...duplicateJrs]
        .slice(0, 20)
        .join(", ")}. Reconciliation stopped — executive_master was not modified.`,
    };
  }

  if (demandByJr.size === 0) {
    return {
      ok: false,
      error: "Base DS has no usable Job Requisition ID rows.",
    };
  }

  const sql = getDbClient();

  const masterBefore = await sql<
    { job_requisition_id: string; job_status: string | null }[]
  >`SELECT job_requisition_id, job_status FROM executive_master`;

  const masterStatus = new Map<string, string | null>();
  for (const row of masterBefore) {
    masterStatus.set(row.job_requisition_id, row.job_status);
  }

  const allIds = new Set<string>([...demandByJr.keys(), ...masterStatus.keys()]);

  const planned: PlannedRow[] = [];
  const closedIds: string[] = [];
  const counts: ExecutiveMasterReconcileCounts = {
    demandRowCount: sheet.dataRows.length,
    uniqueDemandJrCount: demandByJr.size,
    masterJrCountBefore: masterBefore.length,
    added: 0,
    reopened: 0,
    activated: 0,
    unchanged: 0,
    closed: 0,
    masterJrCountAfter: null,
  };

  for (const jr of allIds) {
    const inNew = demandByJr.has(jr);
    const inMaster = masterStatus.has(jr);
    const resolution = resolveExecutiveJobStatus({
      existsInNewSheet: inNew,
      existsInMasterSheet: inMaster,
      existingMasterStatus: masterStatus.get(jr) ?? null,
    });
    if (!resolution) continue;

    if (!inNew) {
      // Closed branch: master-only JR, no incoming data — status flip only.
      closedIds.push(jr);
      counts.closed += 1;
      continue;
    }

    const mapped = demandByJr.get(jr)!;
    planned.push({
      jobRequisitionId: jr,
      values: mapped.values,
      status: resolution.status,
      action: resolution.action,
      dateIso:
        resolution.createRow || resolution.updateDateOfNewJr
          ? processingDateIso
          : null,
    });

    if (resolution.action === "Added") counts.added += 1;
    else if (resolution.action === "Reopened") counts.reopened += 1;
    else if (resolution.action === "Activated") counts.activated += 1;
    else counts.unchanged += 1;
  }

  const syncIso = new Date().toISOString();

  try {
    await sql.begin(async (tx) => {
      const BATCH = 200;
      for (let i = 0; i < planned.length; i += BATCH) {
        const chunk = planned.slice(i, i + BATCH);
        const values = chunk.map((row) => [
          row.jobRequisitionId,
          row.values.market_map,
          row.values.primary_skills,
          row.values.primary_location,
          row.values.job_management_level,
          row.values.must_have_skills,
          row.values.location_flex,
          row.values.skill_categorization,
          row.values.job_description,
          normalizeExecutivePriority(row.values.priority),
          row.status,
          "-", // posted default for brand-new rows only; never touched on conflict
          row.dateIso,
          syncIso,
          syncIso,
          syncIso,
        ]);

        await tx`
          INSERT INTO executive_master (
            job_requisition_id,
            market_map,
            primary_skills,
            primary_location,
            job_management_level,
            must_have_skills,
            location_flex,
            skill_categorization,
            job_description,
            priority,
            job_status,
            posted,
            date,
            created_at,
            updated_at,
            last_seen_at
          )
          SELECT
            v.job_requisition_id,
            v.market_map,
            v.primary_skills,
            v.primary_location,
            v.job_management_level,
            v.must_have_skills,
            v.location_flex,
            v.skill_categorization,
            v.job_description,
            v.priority,
            v.job_status,
            v.posted,
            v.date::date,
            v.created_at::timestamptz,
            v.updated_at::timestamptz,
            v.last_seen_at::timestamptz
          FROM (VALUES ${tx(values as never)}) AS v(
            job_requisition_id,
            market_map,
            primary_skills,
            primary_location,
            job_management_level,
            must_have_skills,
            location_flex,
            skill_categorization,
            job_description,
            priority,
            job_status,
            posted,
            date,
            created_at,
            updated_at,
            last_seen_at
          )
          ON CONFLICT (job_requisition_id) DO UPDATE SET
            market_map = EXCLUDED.market_map,
            primary_skills = EXCLUDED.primary_skills,
            primary_location = EXCLUDED.primary_location,
            job_management_level = EXCLUDED.job_management_level,
            must_have_skills = EXCLUDED.must_have_skills,
            location_flex = EXCLUDED.location_flex,
            skill_categorization = EXCLUDED.skill_categorization,
            job_description = EXCLUDED.job_description,
            priority = EXCLUDED.priority,
            job_status = EXCLUDED.job_status,
            date = COALESCE(EXCLUDED.date, executive_master.date),
            updated_at = EXCLUDED.updated_at,
            last_seen_at = EXCLUDED.last_seen_at
        `;
      }

      if (closedIds.length > 0) {
        await tx`
          UPDATE executive_master
          SET job_status = 'Closed', updated_at = NOW()
          WHERE job_requisition_id = ANY(${closedIds})
            AND job_status IS DISTINCT FROM 'Closed'
        `;
      }
    });
  } catch (error) {
    return {
      ok: false,
      error: `executive_master write failed (rolled back): ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  const masterAfterRows = await sql<{ c: string }[]>`
    SELECT COUNT(*)::text AS c FROM executive_master
  `;
  counts.masterJrCountAfter = Number(masterAfterRows[0]?.c ?? 0);

  return {
    ok: true,
    counts,
    processingDateIso,
    cellErrorWarnings,
    headerWarnings: headerIndex.missingHeaders,
    message: `Reconciled ${counts.uniqueDemandJrCount} demand-sheet JR(s): added ${counts.added}, reopened ${counts.reopened}, activated ${counts.activated}, unchanged ${counts.unchanged}; closed ${counts.closed} master-only JR(s). executive_master ${counts.masterJrCountBefore} → ${counts.masterJrCountAfter}.`,
  };
}
