/**
 * NEW Master Sheet row insertion for JRs present in New Sheet but absent from Master.
 *
 * - Read Master Sheet headers first (destination column order is source of truth)
 * - Map New Sheet → Master Sheet by HEADER NAME (never by position)
 * - Append only — never overwrite existing Master rows
 * - Master Sheet Column K = New
 * - Master-only columns (no New Sheet match) left empty on the new row
 */
import {
  JOB_REQUISITION_ID_HEADER,
  MASTER_DATE_HEADER,
  MASTER_JOB_STATUS_COLUMN_K,
  MASTER_JOB_STATUS_HEADER,
} from "@/services/lateral-processing/lateral-job-status-rules";

export interface HeaderNameMapping {
  /** Master Sheet header (destination) */
  masterHeader: string;
  /** 1-based Master column */
  masterCol: number;
  /** Matching New Sheet header, if any */
  newSheetHeader: string | null;
  /** 1-based New Sheet column, if any */
  newSheetCol: number | null;
  /** True when Master column has no New Sheet counterpart — leave blank on insert */
  leaveBlank: boolean;
}

/** Known New Sheet ↔ Master Sheet header aliases (name match, not position). */
const HEADER_ALIASES: Record<string, string[]> = {
  "Primary Location/Office Locate": [
    "Primary Location/Office Locate",
    "Primary Location/Office locate",
    "Primary Location",
  ],
  "Primary Location": [
    "Primary Location",
    "Primary Location/Office Locate",
    "Primary Location/Office locate",
  ],
};

function normalizeHeader(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function findNewSheetColumnForMasterHeader(
  masterHeader: string,
  newHeaders: Array<{ col: number; header: string }>
): { header: string; col: number } | null {
  const trimmed = masterHeader.trim();
  if (!trimmed) return null;

  // Never map Job Status from New Sheet — Column K is set explicitly to "New".
  if (trimmed === MASTER_JOB_STATUS_HEADER) return null;

  const candidates = HEADER_ALIASES[trimmed] ?? [trimmed];

  for (const candidate of candidates) {
    const exact = newHeaders.find((h) => h.header === candidate);
    if (exact) return exact;
  }
  for (const candidate of candidates) {
    const lower = candidate.toLowerCase();
    const hit = newHeaders.find((h) => h.header.toLowerCase() === lower);
    if (hit) return hit;
  }
  const candNorms = candidates.map(normalizeHeader);
  for (const h of newHeaders) {
    const n = normalizeHeader(h.header);
    if (n && candNorms.includes(n)) return h;
  }
  return null;
}

/**
 * Build New → Master field mapping using Master Sheet header order.
 * Master-only columns are marked leaveBlank (not position-copied).
 */
export function buildNewToMasterHeaderMappings(options: {
  masterHeaders: string[];
  newSheetHeaders: string[];
}): HeaderNameMapping[] {
  const newHeaders = options.newSheetHeaders
    .map((header, idx) => ({ col: idx + 1, header: (header ?? "").trim() }))
    .filter((h) => h.header);

  const mappings: HeaderNameMapping[] = [];

  options.masterHeaders.forEach((raw, idx) => {
    const masterHeader = (raw ?? "").trim();
    const masterCol = idx + 1;
    if (!masterHeader) return;

    // Status column: never populated from New Sheet
    if (masterCol === MASTER_JOB_STATUS_COLUMN_K || masterHeader === MASTER_JOB_STATUS_HEADER) {
      mappings.push({
        masterHeader: masterHeader || MASTER_JOB_STATUS_HEADER,
        masterCol: MASTER_JOB_STATUS_COLUMN_K,
        newSheetHeader: null,
        newSheetCol: null,
        leaveBlank: true,
      });
      return;
    }

    const match = findNewSheetColumnForMasterHeader(masterHeader, newHeaders);
    mappings.push({
      masterHeader,
      masterCol,
      newSheetHeader: match?.header ?? null,
      newSheetCol: match?.col ?? null,
      leaveBlank: !match,
    });
  });

  return mappings;
}

export interface NewRowInsertPlan {
  jobRequisitionId: string;
  /** Exact stored JR value from New Sheet (not re-normalized for storage) */
  storedJobRequisitionId: string;
  /** 1-based New Sheet source row */
  newSheetRowNumber: number;
  /** 1-based Master Sheet append row */
  masterAppendRowNumber: number;
  fieldCopies: Array<{
    masterHeader: string;
    masterCol: number;
    newSheetHeader: string;
    newSheetCol: number;
  }>;
  leftBlankMasterHeaders: string[];
}

export function planNewMasterRowInsertion(options: {
  jobRequisitionId: string;
  storedJobRequisitionId: string;
  newSheetRowNumber: number;
  masterAppendRowNumber: number;
  mappings: HeaderNameMapping[];
}): NewRowInsertPlan {
  const fieldCopies: NewRowInsertPlan["fieldCopies"] = [];
  const leftBlankMasterHeaders: string[] = [];

  for (const m of options.mappings) {
    if (m.masterCol === MASTER_JOB_STATUS_COLUMN_K) continue;
    if (m.leaveBlank || m.newSheetCol == null || !m.newSheetHeader) {
      if (m.masterHeader) leftBlankMasterHeaders.push(m.masterHeader);
      continue;
    }
    fieldCopies.push({
      masterHeader: m.masterHeader,
      masterCol: m.masterCol,
      newSheetHeader: m.newSheetHeader,
      newSheetCol: m.newSheetCol,
    });
  }

  return {
    jobRequisitionId: options.jobRequisitionId,
    storedJobRequisitionId: options.storedJobRequisitionId,
    newSheetRowNumber: options.newSheetRowNumber,
    masterAppendRowNumber: options.masterAppendRowNumber,
    fieldCopies,
    leftBlankMasterHeaders,
  };
}

export interface NewRowInsertionValidationInput {
  /** Normalized JR ids that were supposed to be inserted */
  intendedNewIds: string[];
  /** After insert: normalized JR → list of master row numbers */
  masterRowsByNormalizedId: Record<string, number[]>;
  /** After insert: master row → Column K status */
  statusByMasterRow: Record<number, string>;
  /** After insert: master row → cell values by 1-based col */
  cellsByMasterRow: Record<number, Record<number, string>>;
  /** Snapshot of existing master rows before NEW inserts: row → cell map */
  existingRowsBeforeInsert: Record<number, Record<number, string>>;
  /** Plans used for insertion */
  plans: NewRowInsertPlan[];
  /** New Sheet cells: row → col → value */
  newSheetCells: Record<number, Record<number, string>>;
}

export interface NewRowInsertionValidationResult {
  ok: boolean;
  reasons: string[];
  checks: {
    jrIdInserted: boolean;
    correctColumnsPopulated: boolean;
    columnKIsNew: boolean;
    noDuplicateJrId: boolean;
    existingRowsUntouched: boolean;
  };
}

function cell(map: Record<number, string> | undefined, col: number): string {
  return (map?.[col] ?? "").trim();
}

/**
 * Validate NEW-row insertion results.
 */
export function validateNewRowInsertions(
  input: NewRowInsertionValidationInput
): NewRowInsertionValidationResult {
  const reasons: string[] = [];

  let jrIdInserted = true;
  let correctColumnsPopulated = true;
  let columnKIsNew = true;
  let noDuplicateJrId = true;

  for (const id of input.intendedNewIds) {
    const rows = input.masterRowsByNormalizedId[id] ?? [];
    if (rows.length === 0) {
      jrIdInserted = false;
      reasons.push(`JR ID "${id}" was not inserted into Master Sheet.`);
      continue;
    }
    if (rows.length > 1) {
      noDuplicateJrId = false;
      reasons.push(
        `Duplicate JR ID "${id}" after insert (rows ${rows.join(", ")}).`
      );
    }
    const row = rows[0];
    const status = (input.statusByMasterRow[row] ?? "").trim();
    if (status !== "New") {
      columnKIsNew = false;
      reasons.push(
        `Master Sheet Column K for JR "${id}" (row ${row}) must be "New" (found "${status || "(empty)"}").`
      );
    }

    const plan = input.plans.find((p) => p.jobRequisitionId === id);
    if (!plan) continue;
    const masterCells = input.cellsByMasterRow[row] ?? {};
    const newCells = input.newSheetCells[plan.newSheetRowNumber] ?? {};

    for (const copy of plan.fieldCopies) {
      const expected = (newCells[copy.newSheetCol] ?? "").trim();
      const actual = cell(masterCells, copy.masterCol);
      if (expected !== actual) {
        correctColumnsPopulated = false;
        reasons.push(
          `JR "${id}" column "${copy.masterHeader}" mismatch: expected "${expected}", got "${actual}".`
        );
      }
    }

    // JR column must contain the inserted id (allow stored whitespace variants via trim)
    const jrCols = plan.fieldCopies.filter(
      (c) => c.masterHeader === JOB_REQUISITION_ID_HEADER
    );
    if (jrCols.length === 0) {
      // JR might only be written via dedicated job col — check any cell equal to stored/normalized
      const hasJr = Object.values(masterCells).some(
        (v) => v.trim() === id || v.trim() === plan.storedJobRequisitionId.trim()
      );
      if (!hasJr) {
        jrIdInserted = false;
        reasons.push(`JR ID value missing on inserted Master row ${row}.`);
      }
    }
  }

  let existingRowsUntouched = true;
  for (const [rowStr, before] of Object.entries(input.existingRowsBeforeInsert)) {
    const row = Number(rowStr);
    const after = input.cellsByMasterRow[row] ?? {};
    const cols = new Set([
      ...Object.keys(before).map(Number),
      ...Object.keys(after).map(Number),
    ]);
    for (const col of cols) {
      // Status/Date may have been updated by Active/Reopen/Closed before NEW inserts.
      // For "NEW insertion must not overwrite existing rows", compare non-status if status changed
      // by earlier rules — user asked existing rows untouched by NEW insert specifically.
      // Snapshot is taken immediately before NEW loop, so ALL cells must match.
      const b = (before[col] ?? "").trim();
      const a = (after[col] ?? "").trim();
      if (b !== a) {
        existingRowsUntouched = false;
        reasons.push(
          `Existing Master row ${row} col ${col} was modified during NEW insert (before "${b}", after "${a}").`
        );
        break;
      }
    }
    if (!existingRowsUntouched) break;
  }

  const ok =
    jrIdInserted &&
    correctColumnsPopulated &&
    columnKIsNew &&
    noDuplicateJrId &&
    existingRowsUntouched;

  return {
    ok,
    reasons,
    checks: {
      jrIdInserted,
      correctColumnsPopulated,
      columnKIsNew,
      noDuplicateJrId,
      existingRowsUntouched,
    },
  };
}

export {
  JOB_REQUISITION_ID_HEADER,
  MASTER_DATE_HEADER,
  MASTER_JOB_STATUS_COLUMN_K,
  MASTER_JOB_STATUS_HEADER,
};
