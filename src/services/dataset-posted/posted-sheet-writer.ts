/**
 * Shared "Posted" button local-file editor — mutates a LOCAL downloaded
 * copy of a dataset's master .xlsm in place. Never touches Drive; the
 * caller owns download/upload (see `posted-sheet-reader.ts` for download,
 * the per-dataset run service for the single final `drive.files.update`).
 *
 * Deliberately independent of `lateral-posted-sheet-processor.ts` (Step 18)
 * and `executive-master-workbook-writer.ts` — those are untouched by this
 * feature. The optional Master-Sheet "Posted" column write (Lateral only,
 * for now) resolves its column by HEADER NAME at write time rather than a
 * hardcoded index — a deliberately more defensive choice than Step 18's
 * fixed `MASTER_POSTED_COLUMN_M = 13`, since this is new, independent code
 * with no existing track record to lean on.
 *
 * Edit order inside the single script (one `wb.load` / one `wb.save`, so
 * only one upload is ever needed):
 *   1. Detect the most common existing data-row font/size on column A
 *      (BEFORE any edits — this is what "most common existing" means).
 *   2. Write surviving rows' values, using ORIGINAL row numbers (nothing
 *      has shifted yet).
 *   3. Delete rows, in descending row-number order (so each delete only
 *      ever shifts rows BELOW it, never invalidating a pending delete).
 *   4. Re-apply the detected font/size to columns A/B/C of every surviving
 *      data row, preserving each cell's own other font attributes (bold,
 *      italic, color, ...) — the spec asks only for name+size.
 *   5. Re-point the header's AutoFilter at the new last row, preserving
 *      whatever column span it already had (never invents one if none
 *      existed, never assumes a hardcoded "A:D" — this file has no way to
 *      verify a real workbook's current filter range without live Drive
 *      access, so it reads and preserves whatever is actually there).
 *   6. Optional Master Sheet Posted-column write, matched by Job
 *      Requisition ID, column resolved by header name — same values/match
 *      semantics as Step 18, applied to no other cell on that tab.
 *   7. The same package-relationship-Target normalization
 *      `executive-master-workbook-writer.ts` already applies after every
 *      openpyxl save on this family of files (confirmed necessary there
 *      for Table1's relationship) — applied defensively here too; a no-op
 *      if no absolute-form targets exist.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface PostedSheetWriteRowInstruction {
  rowNumber: number;
  /** null = leave Column A completely untouched (needsLook rows). */
  columnA: string | null;
  columnB: string;
  columnC: string;
}

export interface PostedSheetMasterColumnWrite {
  sheetName: string;
  jrHeader: string;
  postedHeader: string;
  matchedJrIds: string[];
}

export interface WritePostedSheetLocalOptions {
  localPath: string;
  postedSheetName: string;
  rowsToDelete: number[];
  rowsToWrite: PostedSheetWriteRowInstruction[];
  masterColumnWrite?: PostedSheetMasterColumnWrite;
}

export type WritePostedSheetLocalResult =
  | { ok: true; finalDataRowCount: number; masterRowsUpdated: number }
  | { ok: false; reason: string };

function buildWriterScript(): string {
  return `
import json, sys
from openpyxl import load_workbook
from openpyxl.styles import Font
from collections import Counter

def main():
    local_path = sys.argv[1]
    payload_path = sys.argv[2]
    with open(payload_path, "r", encoding="utf-8") as f:
        payload = json.load(f)

    sheet_name = payload["postedSheetName"]
    wb = load_workbook(local_path, keep_vba=True, data_only=False)
    if sheet_name not in wb.sheetnames:
        print(json.dumps({"ok": False, "error": 'Worksheet "%s" not found.' % sheet_name}))
        return
    ws = wb[sheet_name]

    # Step 1: font mode, BEFORE any edits.
    last_row = ws.max_row or 1
    font_counts = Counter()
    for r in range(2, last_row + 1):
        cell = ws.cell(r, 1)
        if cell.value is None or str(cell.value).strip() == "":
            continue
        font_counts[(cell.font.name, cell.font.size)] += 1
    mode_font = font_counts.most_common(1)[0][0] if font_counts else None

    # Step 2: write surviving rows (original row numbers — nothing shifted yet).
    for row in payload["rowsToWrite"]:
        r = row["rowNumber"]
        if row["columnA"] is not None:
            ws.cell(r, 1).value = row["columnA"]
        ws.cell(r, 2).value = row["columnB"]
        ws.cell(r, 3).value = row["columnC"]

    # Step 3: delete rows, descending order.
    for r in sorted(payload["rowsToDelete"], reverse=True):
        ws.delete_rows(r, 1)

    new_last_row = ws.max_row or 1

    # Step 4: re-apply detected font/size to surviving data rows, columns A-C only.
    if mode_font and mode_font[0] is not None:
        name, size = mode_font
        for r in range(2, new_last_row + 1):
            for col in (1, 2, 3):
                cell = ws.cell(r, col)
                existing = cell.font
                cell.font = Font(
                    name=name, size=size,
                    bold=existing.bold, italic=existing.italic,
                    color=existing.color, underline=existing.underline,
                    strike=existing.strike, vertAlign=existing.vertAlign,
                )

    # Step 5: AutoFilter — preserve existing column span, update row count only.
    existing_ref = ws.auto_filter.ref
    if existing_ref:
        import re
        m = re.match(r"^([A-Za-z]+)\\d+:([A-Za-z]+)\\d+$", existing_ref)
        if m:
            start_col, end_col = m.group(1), m.group(2)
            ws.auto_filter.ref = "%s1:%s%d" % (start_col, end_col, new_last_row)

    # Step 6: optional Master Sheet Posted-column write, resolved by header name.
    master_rows_updated = 0
    master_cfg = payload.get("masterColumnWrite")
    if master_cfg:
        m_sheet_name = master_cfg["sheetName"]
        if m_sheet_name not in wb.sheetnames:
            print(json.dumps({"ok": False, "error": 'Worksheet "%s" not found for master column write.' % m_sheet_name}))
            return
        m_ws = wb[m_sheet_name]
        col_index = {}
        for cell in m_ws[1]:
            name = cell.value
            if name:
                col_index[str(name).strip()] = cell.column
        jr_header = master_cfg["jrHeader"]
        posted_header = master_cfg["postedHeader"]
        if jr_header not in col_index or posted_header not in col_index:
            print(json.dumps({"ok": False, "error": 'Master Sheet is missing "%s" or "%s" column.' % (jr_header, posted_header)}))
            return
        jr_col = col_index[jr_header]
        posted_col = col_index[posted_header]
        matched = set(master_cfg["matchedJrIds"])
        for r in range(2, (m_ws.max_row or 1) + 1):
            jr_value = m_ws.cell(r, jr_col).value
            if not jr_value:
                continue
            jr = str(jr_value).strip()
            m_ws.cell(r, posted_col).value = "Yes" if jr in matched else "-"
            master_rows_updated += 1

    wb.save(local_path)

    # Step 7: normalize package-absolute relationship Targets (same fix as
    # executive-master-workbook-writer.ts — confirmed necessary there, harmless
    # no-op here if no absolute-form targets exist).
    import zipfile
    import posixpath
    import re as re2

    with zipfile.ZipFile(local_path, "r") as zin:
        names = zin.namelist()
        data = {n: zin.read(n) for n in names}

    changed = False
    rels_pattern = re2.compile(r"_rels/[^/]+\\.rels$")
    for name in names:
        if not rels_pattern.search(name):
            continue
        content = data[name].decode("utf-8")
        owning_dir = posixpath.dirname(posixpath.dirname(name))

        def fix_target_simple(m):
            nonlocal changed
            target = m.group(1)
            if not target.startswith("/"):
                return m.group(0)
            tag_start = content.rfind("<Relationship", 0, m.start())
            tag_end = content.find("/>", m.start())
            tag = content[tag_start:tag_end]
            if 'TargetMode="External"' in tag:
                return m.group(0)
            absolute_no_slash = target.lstrip("/")
            relative = posixpath.relpath(absolute_no_slash, owning_dir)
            changed = True
            return 'Target="%s"' % relative

        patched = re2.sub(r'Target="(/[^"]*)"', fix_target_simple, content)
        if patched != content:
            data[name] = patched.encode("utf-8")

    if changed:
        with zipfile.ZipFile(local_path, "w", zipfile.ZIP_DEFLATED) as zout:
            for n in names:
                zout.writestr(n, data[n])

    print(json.dumps({
        "ok": True,
        "finalDataRowCount": max(0, new_last_row - 1),
        "masterRowsUpdated": master_rows_updated,
    }))

main()
`.trim();
}

export async function writePostedSheetLocal(
  options: WritePostedSheetLocalOptions
): Promise<WritePostedSheetLocalResult> {
  const scriptPath = path.join(os.tmpdir(), `posted-sheet-writer-${Date.now()}.py`);
  const payloadPath = path.join(os.tmpdir(), `posted-sheet-writer-payload-${Date.now()}.json`);

  await fs.writeFile(scriptPath, buildWriterScript(), "utf8");
  await fs.writeFile(
    payloadPath,
    JSON.stringify({
      postedSheetName: options.postedSheetName,
      rowsToDelete: options.rowsToDelete,
      rowsToWrite: options.rowsToWrite,
      masterColumnWrite: options.masterColumnWrite ?? null,
    }),
    "utf8"
  );

  try {
    const { stdout } = await execFileAsync("python3", [scriptPath, options.localPath, payloadPath], {
      windowsHide: true,
      timeout: 300_000,
      maxBuffer: 256 * 1024 * 1024,
    });
    const parsed = JSON.parse((stdout || "").trim()) as
      | { ok: true; finalDataRowCount: number; masterRowsUpdated: number }
      | { ok: false; error: string };
    if (!parsed.ok) return { ok: false, reason: parsed.error };
    return { ok: true, finalDataRowCount: parsed.finalDataRowCount, masterRowsUpdated: parsed.masterRowsUpdated };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? `Failed to write Posted Sheet changes: ${error.message}` : "Failed to write Posted Sheet changes.",
    };
  } finally {
    await fs.unlink(scriptPath).catch(() => undefined);
    await fs.unlink(payloadPath).catch(() => undefined);
  }
}
