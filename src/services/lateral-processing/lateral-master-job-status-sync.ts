/**
 * Postgres-primary Job Status reconciliation for Lateral Run All.
 *
 * Authority: New Sheet JRs ↔ PostgreSQL `lateral_master` (NOT Excel Column K).
 * Rules: `resolveLateralJobStatus` (New / Reopen / Active / Closed).
 *
 * Writes to `lateral_master`:
 *   - job_status
 *   - date (Reopen → processing date; New → New Sheet date)
 *   - INSERT full business fields for New JRs
 *   - updated_at
 *
 * Does NOT write posted. Does NOT delete Closed rows.
 * Drive XLSM Column K may still be updated separately for workbook
 * compatibility; dashboard Master Sheet reads Postgres only.
 *
 * TODO(next phase): migrate P-Roles pivot / Google P-Roles off XLSM and onto
 * Postgres `lateral_master` once New Sheet + status + posted are proven.
 */

import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getDbClient } from "@/lib/persistence/db-client";
import {
  resolveLateralJobStatus,
  type LateralMasterJobStatus,
} from "@/services/lateral-processing/lateral-job-status-rules";
import {
  normalizeOptionalText,
  parseExcelDateToIso,
} from "@/services/lateral-processing/lateral-master-pg-backfill";
import { LATERAL_MASTER_COLUMN_MAP } from "@/services/persistence/lateral-master-sheet-columns";
import { DEFAULT_LATERAL_NEW_SHEET } from "@/types/lateral-processing-setup";

const execFileAsync = promisify(execFile);

export interface NewSheetMasterFields {
  job_requisition_id: string;
  date: string | null;
  priority: string | null;
  job_description: string | null;
  skill_categorization: string | null;
  primary_skills: string | null;
  job_management_level: string | null;
  primary_location: string | null;
  market_map: string | null;
  poc: string | null;
}

export interface LateralPgJobStatusCounts {
  newSheetJrCount: number;
  masterJrCount: number;
  added: number;
  reopened: number;
  closed: number;
  activated: number;
  unchanged: number;
}

export type LateralPgJobStatusResult =
  | {
      ok: true;
      counts: LateralPgJobStatusCounts;
      processingDateIso: string;
    }
  | { ok: false; error: string };

function todayIsoLocal(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function normalizeHeaderKey(h: string): string {
  return String(h ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

async function readNewSheetRows(
  filePath: string,
  sheetName: string
): Promise<{ headers: string[]; dataRows: string[][] }> {
  const scriptPath = path.join(
    os.tmpdir(),
    `lateral-pg-status-read-${Date.now()}.py`
  );
  const script = `
import json, sys
from openpyxl import load_workbook
path, sheet_name = sys.argv[1], sys.argv[2]
wb = load_workbook(path, read_only=True, data_only=True, keep_vba=True)
if sheet_name not in wb.sheetnames:
    print(json.dumps({"ok": False, "error": 'Worksheet "%s" not found. Available: %s' % (sheet_name, ", ".join(wb.sheetnames))}))
    wb.close()
    raise SystemExit(0)
ws = wb[sheet_name]
headers = []
header_seen = False
data_rows = []
for row in ws.iter_rows(values_only=True):
    values = [("" if c is None else str(c)) for c in row]
    if not header_seen:
        if any(str(v).strip() for v in values):
            headers = [str(v).strip() for v in values]
            while headers and not headers[-1]:
                headers.pop()
            header_seen = True
        continue
    if not any(str(v).strip() for v in values):
        continue
    data_rows.append([(values[i] if i < len(values) else "") for i in range(len(headers))])
wb.close()
if not header_seen or not headers:
    print(json.dumps({"ok": False, "error": 'Worksheet "%s" appears empty.' % sheet_name}))
else:
    print(json.dumps({"ok": True, "headers": headers, "dataRows": data_rows}))
`.trim();

  await fs.writeFile(scriptPath, script, "utf8");
  try {
    const { stdout } = await execFileAsync(
      "python",
      [scriptPath, filePath, sheetName],
      { windowsHide: true, timeout: 300_000, maxBuffer: 256 * 1024 * 1024 }
    );
    const parsed = JSON.parse((stdout || "").trim()) as
      | { ok: true; headers: string[]; dataRows: string[][] }
      | { ok: false; error: string };
    if (!parsed.ok) throw new Error(parsed.error);
    return { headers: parsed.headers, dataRows: parsed.dataRows };
  } finally {
    await fs.unlink(scriptPath).catch(() => undefined);
  }
}

function mapNewSheetHeaders(headers: string[]): Record<string, number> {
  const fieldToIndex: Record<string, number> = {};
  const claimed = new Set<number>();

  for (const mapping of LATERAL_MASTER_COLUMN_MAP) {
    // New Sheet does not carry Job Status / Posted / Opened on Oorwin
    if (
      mapping.dbColumn === "job_status" ||
      mapping.dbColumn === "posted" ||
      mapping.dbColumn === "opened_on_oorwin"
    ) {
      continue;
    }
    let found = -1;
    for (const alias of mapping.importAliases) {
      found = headers.findIndex((h) => h === alias);
      if (found >= 0) break;
    }
    if (found < 0) {
      const aliasNorms = mapping.importAliases.map(normalizeHeaderKey);
      found = headers.findIndex((h) =>
        aliasNorms.includes(normalizeHeaderKey(h))
      );
    }
    if (found < 0) continue;
    if (claimed.has(found)) continue;
    claimed.add(found);
    fieldToIndex[mapping.dbColumn] = found;
  }
  return fieldToIndex;
}

function buildNewSheetFieldMap(
  headers: string[],
  dataRows: string[][]
): Map<string, NewSheetMasterFields> {
  const idx = mapNewSheetHeaders(headers);
  const jrCol = idx.job_requisition_id;
  if (jrCol == null) {
    throw new Error(
      'New Sheet is missing "Job Requisition ID" — cannot reconcile Postgres job_status.'
    );
  }

  const out = new Map<string, NewSheetMasterFields>();
  for (const row of dataRows) {
    const jr = String(row[jrCol] ?? "").trim();
    if (!jr) continue;
    if (out.has(jr)) {
      throw new Error(
        `Duplicate Job Requisition ID in New Sheet: "${jr}". Reconciliation stopped.`
      );
    }
    const rawDate = idx.date != null ? row[idx.date] : null;
    const dateParsed = parseExcelDateToIso(rawDate);
    out.set(jr, {
      job_requisition_id: jr,
      date: dateParsed.ok ? dateParsed.iso : null,
      priority:
        idx.priority != null ? normalizeOptionalText(row[idx.priority]) : null,
      job_description:
        idx.job_description != null
          ? normalizeOptionalText(row[idx.job_description])
          : null,
      skill_categorization:
        idx.skill_categorization != null
          ? normalizeOptionalText(row[idx.skill_categorization])
          : null,
      primary_skills:
        idx.primary_skills != null
          ? normalizeOptionalText(row[idx.primary_skills])
          : null,
      job_management_level:
        idx.job_management_level != null
          ? normalizeOptionalText(row[idx.job_management_level])
          : null,
      primary_location:
        idx.primary_location != null
          ? normalizeOptionalText(row[idx.primary_location])
          : null,
      market_map:
        idx.market_map != null
          ? normalizeOptionalText(row[idx.market_map])
          : null,
      poc: idx.poc != null ? normalizeOptionalText(row[idx.poc]) : null,
    });
  }
  return out;
}

/**
 * Reconcile Job Status against PostgreSQL `lateral_master` using New Sheet presence.
 */
export async function reconcileLateralMasterJobStatusFromNewSheet(options: {
  localWorkbookPath: string;
  newSheetName?: string;
  /** YYYY-MM-DD processing date for Reopen date updates */
  processingDateIso?: string;
}): Promise<LateralPgJobStatusResult> {
  const localPath = options.localWorkbookPath;
  if (!localPath || !existsSync(localPath)) {
    return {
      ok: false,
      error:
        "Staged workbook not found for Postgres Job Status reconciliation. lateral_master was not modified.",
    };
  }

  const newSheetName =
    options.newSheetName?.trim() || DEFAULT_LATERAL_NEW_SHEET;
  const processingDateIso = options.processingDateIso?.trim() || todayIsoLocal();

  let newByJr: Map<string, NewSheetMasterFields>;
  try {
    const sheet = await readNewSheetRows(localPath, newSheetName);
    newByJr = buildNewSheetFieldMap(sheet.headers, sheet.dataRows);
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof Error
          ? err.message
          : "Failed to read New Sheet for Postgres Job Status reconciliation.",
    };
  }

  const sql = getDbClient();
  const masterRows = await sql<
    { job_requisition_id: string; job_status: string | null }[]
  >`
    SELECT job_requisition_id, job_status
    FROM lateral_master
  `;

  const masterStatus = new Map<string, string | null>();
  for (const row of masterRows) {
    masterStatus.set(row.job_requisition_id, row.job_status);
  }

  const allIds = new Set<string>([
    ...newByJr.keys(),
    ...masterStatus.keys(),
  ]);

  const counts: LateralPgJobStatusCounts = {
    newSheetJrCount: newByJr.size,
    masterJrCount: masterStatus.size,
    added: 0,
    reopened: 0,
    closed: 0,
    activated: 0,
    unchanged: 0,
  };

  type PlannedUpdate = {
    jr: string;
    status: LateralMasterJobStatus;
    dateIso: string | null;
    updateDate: boolean;
  };
  type PlannedInsert = NewSheetMasterFields & {
    job_status: "New";
  };

  const updates: PlannedUpdate[] = [];
  const inserts: PlannedInsert[] = [];

  for (const jr of allIds) {
    const inNew = newByJr.has(jr);
    const inMaster = masterStatus.has(jr);
    const existing = masterStatus.get(jr) ?? null;
    const resolution = resolveLateralJobStatus({
      existsInNewSheet: inNew,
      existsInMasterSheet: inMaster,
      existingMasterStatus: existing,
    });
    if (!resolution) continue;

    if (resolution.action === "Unchanged") {
      counts.unchanged += 1;
      continue;
    }

    if (resolution.createRow) {
      const fields = newByJr.get(jr);
      if (!fields) {
        return {
          ok: false,
          error: `Internal error: New JR "${jr}" missing New Sheet fields.`,
        };
      }
      inserts.push({ ...fields, job_status: "New" });
      counts.added += 1;
      continue;
    }

    updates.push({
      jr,
      status: resolution.status,
      dateIso: resolution.updateDate ? processingDateIso : null,
      updateDate: resolution.updateDate,
    });
    if (resolution.action === "Reopened") counts.reopened += 1;
    else if (resolution.action === "Closed") counts.closed += 1;
    else if (resolution.action === "Activated") counts.activated += 1;
  }

  try {
    await sql.begin(async (tx) => {
      for (const row of inserts) {
        await tx`
          INSERT INTO lateral_master (
            job_requisition_id,
            date,
            priority,
            job_description,
            skill_categorization,
            primary_skills,
            job_management_level,
            primary_location,
            market_map,
            poc,
            job_status,
            posted,
            created_at,
            updated_at
          ) VALUES (
            ${row.job_requisition_id},
            ${row.date},
            ${row.priority},
            ${row.job_description},
            ${row.skill_categorization},
            ${row.primary_skills},
            ${row.job_management_level},
            ${row.primary_location},
            ${row.market_map},
            ${row.poc},
            ${"New"},
            ${"-"},
            NOW(),
            NOW()
          )
          ON CONFLICT (job_requisition_id) DO UPDATE SET
            date = EXCLUDED.date,
            priority = EXCLUDED.priority,
            job_description = EXCLUDED.job_description,
            skill_categorization = EXCLUDED.skill_categorization,
            primary_skills = EXCLUDED.primary_skills,
            job_management_level = EXCLUDED.job_management_level,
            primary_location = EXCLUDED.primary_location,
            market_map = EXCLUDED.market_map,
            poc = EXCLUDED.poc,
            job_status = ${"New"},
            updated_at = NOW()
        `;
      }

      for (const u of updates) {
        if (u.updateDate && u.dateIso) {
          await tx`
            UPDATE lateral_master
            SET
              job_status = ${u.status},
              date = ${u.dateIso}::date,
              updated_at = NOW()
            WHERE job_requisition_id = ${u.jr}
          `;
        } else {
          await tx`
            UPDATE lateral_master
            SET
              job_status = ${u.status},
              updated_at = NOW()
            WHERE job_requisition_id = ${u.jr}
          `;
        }
      }
    });
  } catch (err) {
    return {
      ok: false,
      error: `Postgres Job Status write failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  return { ok: true, counts, processingDateIso };
}
