/**
 * Executive Master Sheet reconciliation engine — DRY-RUN / in-memory only.
 *
 * Field classes:
 * A. Incoming (from New Sheet) — Market, JR, skills, Level, category, location,
 *    Must Have, Location Flex, JD, Priority
 * B. System — Job Status, Posted
 * C. Historical / preserved — Date of New JR (except New insert / Closed→Reopen),
 *    Opened on Oorwin, Team*, Active Pipeline, yrs of Experience, Ageing Slab,
 *    Niche Roles, historical Z column (never treated as live status)
 */

import {
  EXECUTIVE_MASTER_LIVE_COLUMNS,
  type ExecutiveMasterLiveColumn,
  type ExecutiveMasterSheetRow,
} from "@/services/excel/executive-master-sheet";
import {
  formatExecutiveProcessingDateDDMMYYYY,
  normalizeExecutiveJobRequisitionId,
  resolveExecutiveJobStatus,
  type ExecutiveMasterJobStatus,
  type ExecutiveStatusAction,
} from "@/services/executive-processing/executive-job-status-rules";
import {
  buildExecutivePostedJrSet,
  resolveExecutivePostedValue,
  type ExecutivePostedValue,
} from "@/services/executive-processing/executive-posted-rules";

/** New Sheet header → Master Sheet header (confirmed + Phase 4B). */
export const EXECUTIVE_NEW_TO_MASTER_FIELD_MAP = {
  Market: "Market",
  "Job requisition ID": "Job Requisition ID",
  "Primary Skill": "Primary skills",
  Level: "Level",
  "Skill category": "Skill category",
  "Primary Location": "Primary Location",
  "Must Have skills": "Must Have skills",
  "Location Flex": "Location Flex",
  "Job Description": "Job Description",
  Priority: "Priority",
} as const;

export type ExecutiveNewSheetRow = Record<string, unknown> & {
  id?: string;
};

export interface ExecutivePostedSheetRow {
  jobRequisitionId?: string;
  postingText?: string;
}

export interface ExecutiveReconcileDuplicate {
  sheet: "New Sheet" | "Master Sheet";
  jobRequisitionId: string;
  occurrences: number;
}

export interface ExecutiveReconcileChange {
  jobRequisitionId: string;
  action: ExecutiveStatusAction;
  previousStatus: string | null;
  nextStatus: ExecutiveMasterJobStatus;
  previousPosted: string | null;
  nextPosted: ExecutivePostedValue;
  createRow: boolean;
  updateDateOfNewJr: boolean;
}

export interface ExecutiveReconcileDryRunResult {
  ok: boolean;
  dryRun: true;
  masterSheetWritePerformed: false;
  blockers: string[];
  duplicates: ExecutiveReconcileDuplicate[];
  counts: {
    newSheetRows: number;
    masterSheetRows: number;
    postedSheetRows: number;
    uniqueNewJrIds: number;
    uniqueMasterJrIds: number;
    uniquePostedJrIds: number;
    new: number;
    reopen: number;
    active: number;
    closed: number;
    unchanged: number;
    postedYes: number;
    postedDash: number;
  };
  changes: ExecutiveReconcileChange[];
  /** Projected Master rows after reconcile (in memory only). */
  projectedMasterRows: ExecutiveMasterSheetRow[];
  processingDate: string;
  notes: string[];
}

function asText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function findDuplicates(
  ids: string[],
  sheet: "New Sheet" | "Master Sheet"
): ExecutiveReconcileDuplicate[] {
  const counts = new Map<string, number>();
  for (const id of ids) {
    if (!id) continue;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const out: ExecutiveReconcileDuplicate[] = [];
  for (const [jobRequisitionId, occurrences] of counts) {
    if (occurrences > 1) {
      out.push({ sheet, jobRequisitionId, occurrences });
    }
  }
  return out.sort((a, b) =>
    a.jobRequisitionId.localeCompare(b.jobRequisitionId)
  );
}

function emptyMasterRow(
  id: string,
  jr: string
): ExecutiveMasterSheetRow {
  const row = { id } as ExecutiveMasterSheetRow;
  for (const column of EXECUTIVE_MASTER_LIVE_COLUMNS) {
    row[column] = null;
  }
  row["Job Requisition ID"] = jr;
  return row;
}

function applyIncomingFields(
  target: ExecutiveMasterSheetRow,
  newRow: ExecutiveNewSheetRow
): void {
  for (const [newHeader, masterHeader] of Object.entries(
    EXECUTIVE_NEW_TO_MASTER_FIELD_MAP
  )) {
    const raw = newRow[newHeader];
    if (raw === undefined) continue;
    const text = asText(raw);
    target[masterHeader as ExecutiveMasterLiveColumn] =
      text === "" ? null : (raw as ExecutiveMasterSheetRow[ExecutiveMasterLiveColumn]);
    // Prefer trimmed text for string-like fields
    if (typeof raw === "string" || typeof raw === "number") {
      target[masterHeader as ExecutiveMasterLiveColumn] =
        text === "" ? null : text;
    }
  }
}

/**
 * Pure dry-run reconciliation. Never writes workbooks.
 */
export function runExecutiveMasterReconcileDryRun(options: {
  masterRows: ExecutiveMasterSheetRow[];
  newSheetRows: ExecutiveNewSheetRow[];
  postedSheetRows: ExecutivePostedSheetRow[];
  processingDate?: Date;
}): ExecutiveReconcileDryRunResult {
  const processingDate = formatExecutiveProcessingDateDDMMYYYY(
    options.processingDate ?? new Date()
  );
  const notes: string[] = [
    "DRY-RUN only — Executive Master Sheet is NOT modified.",
    "Status rules are Lateral-parity (New/Reopen sticky; Closed keeps rows).",
    "Excel VBA historically used Active/Closed only; Phase 4C adopts Lateral-parity including New/Reopen.",
    "Posted: JR in Posted Sheet → Yes, else → - (never converts - to No).",
    "Date of New JR updated only on Closed→Reopen; set on NEW inserts.",
  ];

  const blockers: string[] = [];

  const newIds = options.newSheetRows.map((row) =>
    normalizeExecutiveJobRequisitionId(
      row["Job requisition ID"] ?? row["Job Requisition ID"]
    )
  );
  const masterIds = options.masterRows.map((row) =>
    normalizeExecutiveJobRequisitionId(row["Job Requisition ID"])
  );

  const duplicates = [
    ...findDuplicates(newIds.filter(Boolean), "New Sheet"),
    ...findDuplicates(masterIds.filter(Boolean), "Master Sheet"),
  ];

  if (duplicates.length > 0) {
    blockers.push(
      `Duplicate Job Requisition IDs block write: ${duplicates
        .slice(0, 8)
        .map((d) => `${d.sheet} ${d.jobRequisitionId}×${d.occurrences}`)
        .join("; ")}`
    );
  }

  if (newIds.filter(Boolean).length === 0) {
    blockers.push("New Sheet has no Job Requisition ID values.");
  }

  const newById = new Map<string, ExecutiveNewSheetRow>();
  for (let i = 0; i < options.newSheetRows.length; i += 1) {
    const id = newIds[i];
    if (!id) continue;
    if (!newById.has(id)) newById.set(id, options.newSheetRows[i]);
  }

  const masterById = new Map<string, ExecutiveMasterSheetRow>();
  for (let i = 0; i < options.masterRows.length; i += 1) {
    const id = masterIds[i];
    if (!id) continue;
    if (!masterById.has(id)) masterById.set(id, options.masterRows[i]);
  }

  const postedJrSet = buildExecutivePostedJrSet(options.postedSheetRows);

  const changes: ExecutiveReconcileChange[] = [];
  const projected: ExecutiveMasterSheetRow[] = [];

  let countNew = 0;
  let countReopen = 0;
  let countActive = 0;
  let countClosed = 0;
  let countUnchanged = 0;
  let postedYes = 0;
  let postedDash = 0;

  // Preserve Master row order for existing IDs; append news at end.
  const orderedIds: string[] = [];
  for (const id of masterIds) {
    if (id && !orderedIds.includes(id)) orderedIds.push(id);
  }
  for (const id of newById.keys()) {
    if (!orderedIds.includes(id)) orderedIds.push(id);
  }

  let newRowSeq = 0;
  for (const jr of orderedIds) {
    const inNew = newById.has(jr);
    const inMaster = masterById.has(jr);
    const existing = masterById.get(jr);
    const previousStatus = existing
      ? asText(existing["Job Status"]) || null
      : null;
    const previousPosted = existing
      ? asText(existing.Posted) || null
      : null;

    const resolution = resolveExecutiveJobStatus({
      existsInNewSheet: inNew,
      existsInMasterSheet: inMaster,
      existingMasterStatus: previousStatus,
    });
    if (!resolution) continue;

    let row: ExecutiveMasterSheetRow;
    if (resolution.createRow) {
      newRowSeq += 1;
      row = emptyMasterRow(`executive-new-${newRowSeq}`, jr);
      const source = newById.get(jr)!;
      applyIncomingFields(row, source);
      row["Date of New JR"] = processingDate;
    } else {
      row = { ...existing! };
      if (inNew) {
        applyIncomingFields(row, newById.get(jr)!);
      }
      if (resolution.updateDateOfNewJr) {
        row["Date of New JR"] = processingDate;
      }
    }

    row["Job Status"] = resolution.status;
    const nextPosted = resolveExecutivePostedValue(jr, postedJrSet);
    row.Posted = nextPosted;

    if (nextPosted === "Yes") postedYes += 1;
    else postedDash += 1;

    if (resolution.action === "Added") countNew += 1;
    else if (resolution.action === "Reopened") countReopen += 1;
    else if (resolution.action === "Activated") countActive += 1;
    else if (resolution.action === "Closed") countClosed += 1;
    else countUnchanged += 1;

    changes.push({
      jobRequisitionId: jr,
      action: resolution.action,
      previousStatus,
      nextStatus: resolution.status,
      previousPosted,
      nextPosted,
      createRow: resolution.createRow,
      updateDateOfNewJr: resolution.updateDateOfNewJr,
    });

    projected.push(row);
  }

  // Final status tallies on projected rows
  const statusTotals = {
    New: 0,
    Reopen: 0,
    Active: 0,
    Closed: 0,
  };
  for (const row of projected) {
    const st = asText(row["Job Status"]) as keyof typeof statusTotals;
    if (st in statusTotals) statusTotals[st] += 1;
  }

  return {
    ok: blockers.length === 0,
    dryRun: true,
    masterSheetWritePerformed: false,
    blockers,
    duplicates,
    counts: {
      newSheetRows: options.newSheetRows.length,
      masterSheetRows: options.masterRows.length,
      postedSheetRows: options.postedSheetRows.length,
      uniqueNewJrIds: newById.size,
      uniqueMasterJrIds: masterById.size,
      uniquePostedJrIds: postedJrSet.size,
      new: countNew,
      reopen: countReopen,
      active: countActive,
      closed: countClosed,
      unchanged: countUnchanged,
      postedYes,
      postedDash,
    },
    changes,
    projectedMasterRows: projected,
    processingDate,
    notes: [
      ...notes,
      `Projected status totals: New=${statusTotals.New}, Reopen=${statusTotals.Reopen}, Active=${statusTotals.Active}, Closed=${statusTotals.Closed}`,
    ],
  };
}
