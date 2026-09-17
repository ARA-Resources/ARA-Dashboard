/**
 * Executive Master Workbook writer — mutates a LOCAL copy of the real
 * "Copy of ATCI Exec Job Reqs Master Sheet ...xlsm" in place:
 *  - clears New Sheet's data rows (keeps the header row) and repopulates
 *    them from this run's Base DS data (per executive-new-sheet-mapping.ts)
 *  - writes Job Status / Posted / other decided fields onto Master Sheet,
 *    matched by Job Requisition ID (column resolved by header name, never
 *    by hardcoded position)
 *
 * Uses Python/openpyxl with keep_vba=True, matching Lateral's
 * `master-reconcile.ts` convention, to avoid corrupting the workbook's VBA
 * project. Confirmed by direct testing (2026-09-17) against the real
 * workbook fixture: `keep_vba=True` round-trips `xl/vbaProject.bin`
 * byte-identical, including with real edits applied elsewhere in the file.
 *
 * Two real, non-obvious things this module handles that a naive
 * openpyxl-save would get wrong, both confirmed empirically against the
 * real fixture before being relied upon here (not assumed):
 *
 * 1. openpyxl unconditionally drops ALL worksheet drawing/shape content on
 *    save (confirmed even for a real, non-empty synthetic shape injected
 *    for testing, not just the empty drawings this file happens to have
 *    today). This means the plan's "remove the legacy Update-Job-Status
 *    button" mitigation happens automatically as a side effect of using
 *    openpyxl for the required cell writes — no separate removal code is
 *    needed or written here.
 * 2. openpyxl writes at least one relationship Target (Master Sheet's
 *    Table1 relationship) in "package-absolute" form (`/xl/tables/table1.xml`)
 *    instead of the relative form (`../tables/table1.xml`) the original file
 *    used. Both forms are legal per the OPC spec, but this codebase's own
 *    ExcelJS-based readers (e.g. `read-executive-master-from-drive-xlsm.ts`)
 *    fail to resolve the absolute form and crash on read. This module
 *    always normalizes every `*.rels` part's non-external Targets back to
 *    relative form as a mandatory final step before returning — confirmed
 *    by direct before/after testing to be the exact and complete fix.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ExecutiveMasterSheetFieldUpdate {
  jobRequisitionId: string;
  /** Keyed by Master Sheet's real header names, e.g. "Job Status", "Posted". */
  fields: Record<string, string | null>;
}

export interface WriteExecutiveMasterWorkbookOptions {
  /** Local path to the .xlsm to mutate IN PLACE. Caller owns download/upload. */
  localPath: string;
  /** Ordered rows matching EXECUTIVE_NEW_SHEET_HEADERS column order. */
  newSheetRows: Array<Array<string | null>>;
  masterSheetUpdates: ExecutiveMasterSheetFieldUpdate[];
}

export type WriteExecutiveMasterWorkbookResult =
  | {
      ok: true;
      newSheetRowsWritten: number;
      masterUpdatesApplied: string[];
      masterUpdatesSkipped: string[];
    }
  | { ok: false; reason: string };

function buildWriterScript(): string {
  return `
import json, sys
from openpyxl import load_workbook

def main():
    local_path = sys.argv[1]
    payload_path = sys.argv[2]
    with open(payload_path, "r", encoding="utf-8") as f:
        payload = json.load(f)

    wb = load_workbook(local_path, keep_vba=True, data_only=False)

    if "New Sheet" not in wb.sheetnames:
        print(json.dumps({"ok": False, "error": 'Worksheet "New Sheet" not found.'}))
        return
    if "Master Sheet" not in wb.sheetnames:
        print(json.dumps({"ok": False, "error": 'Worksheet "Master Sheet" not found.'}))
        return

    ws_new = wb["New Sheet"]
    if ws_new.max_row > 1:
        ws_new.delete_rows(2, ws_new.max_row - 1)
    for i, row in enumerate(payload["newSheetRows"], start=2):
        for j, value in enumerate(row, start=1):
            ws_new.cell(row=i, column=j, value=value)

    ws_master = wb["Master Sheet"]
    header_row = ws_master[1]
    col_index = {}
    for cell in header_row:
        name = cell.value
        if name:
            col_index[str(name).strip()] = cell.column

    if "Job Requisition ID" not in col_index:
        print(json.dumps({"ok": False, "error": 'Master Sheet is missing "Job Requisition ID" column.'}))
        return
    jr_col = col_index["Job Requisition ID"]

    jr_to_row = {}
    for r in range(2, ws_master.max_row + 1):
        jr_value = ws_master.cell(row=r, column=jr_col).value
        if jr_value:
            jr_to_row[str(jr_value).strip()] = r

    applied = []
    skipped = []
    for update in payload["masterSheetUpdates"]:
        jr = update["jobRequisitionId"]
        row = jr_to_row.get(jr)
        if row is None:
            skipped.append(jr)
            continue
        for field_name, value in update["fields"].items():
            col = col_index.get(field_name)
            if col:
                ws_master.cell(row=row, column=col, value=value)
        applied.append(jr)

    wb.save(local_path)

    # Mandatory post-process: openpyxl writes some relationship Targets in
    # package-absolute form ("/xl/...") instead of the relative form the
    # original file used; this codebase's ExcelJS-based readers only
    # resolve the relative form. Normalize every non-external Target in
    # every *.rels part before returning. Confirmed necessary and
    # sufficient by direct testing against this exact file (2026-09-17).
    import zipfile
    import posixpath
    import re

    with zipfile.ZipFile(local_path, "r") as zin:
        names = zin.namelist()
        data = {n: zin.read(n) for n in names}

    changed = False
    rels_pattern = re.compile(r"_rels/[^/]+\\.rels$")
    for name in names:
        if not rels_pattern.search(name):
            continue
        content = data[name].decode("utf-8")

        # Owning part's directory: strip the trailing "_rels/<file>.rels".
        owning_dir = posixpath.dirname(posixpath.dirname(name))

        # Only touch Target="..." attributes that start with "/" (package-
        # absolute form), leaving External (hyperlink-style) targets and
        # already-relative ones untouched.
        def fix_target_simple(m):
            nonlocal changed
            target = m.group(1)
            if not target.startswith("/"):
                return m.group(0)
            tag_start = content.rfind("<Relationship", 0, m.start())
            tag_end = content.find("/>", m.start())
            tag = content[tag_start:tag_end]
            if "TargetMode=\\"External\\"" in tag:
                return m.group(0)
            absolute_no_slash = target.lstrip("/")
            relative = posixpath.relpath(absolute_no_slash, owning_dir)
            changed = True
            return f'Target="{relative}"'

        patched = re.sub(r'Target="(/[^"]*)"', fix_target_simple, content)
        if patched != content:
            data[name] = patched.encode("utf-8")

    if changed:
        with zipfile.ZipFile(local_path, "w", zipfile.ZIP_DEFLATED) as zout:
            for n in names:
                zout.writestr(n, data[n])

    print(json.dumps({
        "ok": True,
        "newSheetRowsWritten": len(payload["newSheetRows"]),
        "masterUpdatesApplied": applied,
        "masterUpdatesSkipped": skipped,
    }))

main()
`.trim();
}

/**
 * Apply New Sheet clear+repopulate and Master Sheet field updates to a local
 * .xlsm file in place. Caller is responsible for downloading the file first
 * and re-uploading it afterward — this function never touches Drive.
 */
export async function writeExecutiveMasterWorkbookUpdates(
  options: WriteExecutiveMasterWorkbookOptions
): Promise<WriteExecutiveMasterWorkbookResult> {
  const scriptPath = path.join(
    os.tmpdir(),
    `executive-master-workbook-writer-${Date.now()}.py`
  );
  const payloadPath = path.join(
    os.tmpdir(),
    `executive-master-workbook-writer-payload-${Date.now()}.json`
  );

  await fs.writeFile(scriptPath, buildWriterScript(), "utf8");
  await fs.writeFile(
    payloadPath,
    JSON.stringify({
      newSheetRows: options.newSheetRows,
      masterSheetUpdates: options.masterSheetUpdates,
    }),
    "utf8"
  );

  try {
    const { stdout } = await execFileAsync(
      "python3",
      [scriptPath, options.localPath, payloadPath],
      { windowsHide: true, timeout: 300_000, maxBuffer: 256 * 1024 * 1024 }
    );
    const parsed = JSON.parse((stdout || "").trim()) as
      | {
          ok: true;
          newSheetRowsWritten: number;
          masterUpdatesApplied: string[];
          masterUpdatesSkipped: string[];
        }
      | { ok: false; error: string };
    if (!parsed.ok) return { ok: false, reason: parsed.error };
    return {
      ok: true,
      newSheetRowsWritten: parsed.newSheetRowsWritten,
      masterUpdatesApplied: parsed.masterUpdatesApplied,
      masterUpdatesSkipped: parsed.masterUpdatesSkipped,
    };
  } catch (error) {
    return {
      ok: false,
      reason:
        error instanceof Error
          ? `Failed to write Master Workbook updates: ${error.message}`
          : "Failed to write Master Workbook updates.",
    };
  } finally {
    await fs.unlink(scriptPath).catch(() => undefined);
    await fs.unlink(payloadPath).catch(() => undefined);
  }
}
