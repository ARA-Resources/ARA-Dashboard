/**
 * Refresh existing P-Roles PivotTable1 after Posted matching (Step 4).
 *
 * - Uses Excel COM on the staged local XLSM
 * - Does NOT rebuild/delete PivotTable1
 * - Does NOT modify Master Sheet data (Column K preserved)
 * - Extends pivot source to current Master Sheet A1:M{lastRow}
 * - Re-applies JML numeric order after RefreshTable
 */

import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const P_ROLES_SHEET_NAME = "P-Roles";
/** OOXML part name is often pivotTable1.xml — that is NOT the COM PivotTable.Name. */
export const P_ROLES_PIVOT_OOXML_PART = "PivotTable1";

export interface PRolesPivotRefreshSuccess {
  ok: true;
  pivotName: string;
  pivotCount: 1;
  sourceA1: string;
  postedFilterItems: string[];
  jmlOrderOk: boolean;
  jmlRenderedHeaders: string[];
  masterSheetRows: number;
  postedYesCount: number;
  postedDashCount: number;
  columnKModified: false;
  masterSheetModified: false;
  excelVersion: string | null;
  notes: string[];
}

export interface PRolesPivotRefreshFailure {
  ok: false;
  error: string;
  columnKModified: false;
  masterSheetModified: false;
  unavailable?: boolean;
}

export type PRolesPivotRefreshResult =
  | PRolesPivotRefreshSuccess
  | PRolesPivotRefreshFailure;

async function environmentSupportsExcelCom(): Promise<
  { ok: true; excelVersion: string } | { ok: false; reason: string }
> {
  if (process.platform !== "win32") {
    return {
      ok: false,
      reason:
        "P-Roles pivot refresh requires Windows with Microsoft Excel. Current platform is not Windows.",
    };
  }

  const probe = `
import json, sys
try:
    import pythoncom
    import win32com.client
except ImportError:
    print(json.dumps({"ok": False, "reason": "pywin32 is not installed. Install with: pip install pywin32"}))
    sys.exit(0)
pythoncom.CoInitialize()
excel = None
try:
    excel = win32com.client.DispatchEx("Excel.Application")
    excel.Visible = False
    excel.DisplayAlerts = False
    version = str(excel.Version)
    print(json.dumps({"ok": True, "excelVersion": version}))
except Exception as e:
    print(json.dumps({"ok": False, "reason": f"Microsoft Excel COM is not available: {e}"}))
finally:
    try:
        if excel is not None:
            excel.Quit()
    except Exception:
        pass
    try:
        pythoncom.CoUninitialize()
    except Exception:
        pass
`.trim();

  const probePath = path.join(os.tmpdir(), `excel-com-probe-${Date.now()}.py`);
  try {
    await fs.writeFile(probePath, probe, "utf8");
    const { stdout } = await execFileAsync("python", [probePath], {
      windowsHide: true,
      timeout: 60_000,
    });
    const parsed = JSON.parse((stdout || "").trim() || "{}") as {
      ok?: boolean;
      excelVersion?: string;
      reason?: string;
    };
    if (!parsed.ok) {
      return { ok: false, reason: parsed.reason || "Excel COM unavailable." };
    }
    return { ok: true, excelVersion: parsed.excelVersion || "unknown" };
  } catch (err) {
    return {
      ok: false,
      reason:
        err instanceof Error
          ? err.message
          : "Failed to probe Excel COM availability.",
    };
  } finally {
    await fs.unlink(probePath).catch(() => undefined);
  }
}

/**
 * Refresh the only PivotTable on P-Roles of the staged workbook in place.
 * COM Name may be "P-Roles" or "PivotTable1"; discovery is by count === 1.
 * Caller must ensure Posted matching already succeeded.
 */
export async function refreshPRolesPivotOnStagedWorkbook(options: {
  localWorkbookPath: string;
}): Promise<PRolesPivotRefreshResult> {
  const workbookPath = options.localWorkbookPath;
  if (!workbookPath || !existsSync(workbookPath)) {
    return {
      ok: false,
      error:
        "Staged Master Workbook was not found for P-Roles refresh. Pivot was not modified.",
      columnKModified: false,
      masterSheetModified: false,
    };
  }

  const env = await environmentSupportsExcelCom();
  if (!env.ok) {
    return {
      ok: false,
      error: env.reason,
      columnKModified: false,
      masterSheetModified: false,
      unavailable: true,
    };
  }

  const scriptPath = path.join(
    process.cwd(),
    "scripts",
    "_refresh-p-roles-pivot.py"
  );
  if (!existsSync(scriptPath)) {
    return {
      ok: false,
      error: `P-Roles refresh script missing: ${scriptPath}`,
      columnKModified: false,
      masterSheetModified: false,
    };
  }

  try {
    const { stdout } = await execFileAsync(
      "python",
      [scriptPath, workbookPath],
      {
        windowsHide: true,
        timeout: 600_000,
        maxBuffer: 8 * 1024 * 1024,
      }
    );

    const payload = JSON.parse((stdout || "").trim() || "{}") as {
      ok?: boolean;
      error?: string;
      pivotName?: string;
      pivotCount?: number;
      sourceA1?: string;
      postedFilterItems?: string[];
      jmlOrderOk?: boolean;
      jmlRenderedHeaders?: string[];
      masterSheetRows?: number;
      postedYesCount?: number;
      postedDashCount?: number;
      excelVersion?: string;
      notes?: string[];
    };

    if (!payload.ok) {
      return {
        ok: false,
        error:
          payload.error ||
          "P-Roles PivotTable refresh failed. Master Sheet was not modified and the pivot was not rebuilt.",
        columnKModified: false,
        masterSheetModified: false,
      };
    }

    if (payload.pivotCount !== 1) {
      return {
        ok: false,
        error: `P-Roles must contain exactly one PivotTable (found ${payload.pivotCount ?? "unknown"}).`,
        columnKModified: false,
        masterSheetModified: false,
      };
    }

    if (!payload.pivotName) {
      return {
        ok: false,
        error: "P-Roles PivotTable was discovered but returned no COM name.",
        columnKModified: false,
        masterSheetModified: false,
      };
    }

    return {
      ok: true,
      pivotName: payload.pivotName,
      pivotCount: 1,
      sourceA1: payload.sourceA1 || "",
      postedFilterItems: payload.postedFilterItems ?? [],
      jmlOrderOk: payload.jmlOrderOk === true,
      jmlRenderedHeaders: payload.jmlRenderedHeaders ?? [],
      masterSheetRows: payload.masterSheetRows ?? 0,
      postedYesCount: payload.postedYesCount ?? 0,
      postedDashCount: payload.postedDashCount ?? 0,
      columnKModified: false,
      masterSheetModified: false,
      excelVersion: payload.excelVersion ?? env.excelVersion,
      notes: payload.notes ?? [],
    };
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof Error
          ? `P-Roles pivot refresh failed: ${err.message}`
          : "P-Roles pivot refresh failed unexpectedly.",
      columnKModified: false,
      masterSheetModified: false,
    };
  }
}
