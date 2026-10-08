/**
 * "Every OTHER tab must be unchanged" safety net for the Posted button.
 *
 * Hashes every sheet NOT in `excludeSheetNames` (read-only, calculated
 * values) before and after the local edit; the caller aborts the upload if
 * any hash differs. Hashing (not storing full grids) keeps this cheap on
 * large workbooks. `excludeSheetNames` is the set of tabs this run
 * INTENDS to change (the Posted Sheet itself, plus Master Sheet when the
 * Lateral master-column write is active) — everything else must be
 * byte-for-byte identical.
 *
 * Known limitation, not solved here: a volatile formula elsewhere in the
 * workbook (e.g. TODAY()) could recalculate differently between the two
 * reads and trip a false-positive mismatch unrelated to this feature's own
 * edit. Not seen in any file this codebase currently touches; flagged
 * rather than guarded against, since building formula-awareness here would
 * be solving a problem that hasn't been observed.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type OtherTabsSnapshot = Record<string, string>;

export type OtherTabsSnapshotResult =
  | { ok: true; hashes: OtherTabsSnapshot }
  | { ok: false; reason: string };

export async function snapshotOtherTabs(
  localPath: string,
  excludeSheetNames: string[]
): Promise<OtherTabsSnapshotResult> {
  const scriptPath = path.join(os.tmpdir(), `posted-sheet-snapshot-${Date.now()}.py`);
  const script = `
import json, sys, hashlib
from openpyxl import load_workbook
local_path, exclude_json = sys.argv[1], sys.argv[2]
exclude = set(json.loads(exclude_json))
wb = load_workbook(local_path, read_only=True, data_only=True)
result = {}
for name in wb.sheetnames:
    if name in exclude:
        continue
    ws = wb[name]
    h = hashlib.sha256()
    for row in ws.iter_rows(values_only=True):
        h.update(repr(row).encode("utf-8", errors="replace"))
    result[name] = h.hexdigest()
wb.close()
print(json.dumps({"ok": True, "hashes": result}))
`.trim();

  await fs.writeFile(scriptPath, script, "utf8");
  try {
    const { stdout } = await execFileAsync("python3", [scriptPath, localPath, JSON.stringify(excludeSheetNames)], {
      windowsHide: true,
      timeout: 300_000,
      maxBuffer: 256 * 1024 * 1024,
    });
    const parsed = JSON.parse((stdout || "").trim()) as { ok: true; hashes: OtherTabsSnapshot } | { ok: false; error: string };
    if (!("ok" in parsed) || !parsed.ok) {
      return { ok: false, reason: (parsed as { error: string }).error ?? "Failed to snapshot other tabs." };
    }
    return { ok: true, hashes: parsed.hashes };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? `Failed to snapshot other tabs: ${error.message}` : "Failed to snapshot other tabs.",
    };
  } finally {
    await fs.unlink(scriptPath).catch(() => undefined);
  }
}

export function findUnexpectedTabChanges(before: OtherTabsSnapshot, after: OtherTabsSnapshot): string[] {
  const changed: string[] = [];
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const name of names) {
    if (before[name] !== after[name]) changed.push(name);
  }
  return changed;
}
