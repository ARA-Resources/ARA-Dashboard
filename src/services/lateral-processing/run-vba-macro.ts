/**
 * run-vba-macro.ts
 *
 * Excel COM helpers for the Lateral Master .xlsm.
 *
 * Job Status (Active | Closed | Reopen | New) is owned by the Dataset backend
 * (Master Sheet Column K). The old UpdateJobRequisitionsStatusLateral body
 * conflicts with that engine and must not run blindly after reconcile.
 *
 * This module can:
 *   - Neutralize Module11 to a safe stub (same Sub name, no status writes)
 *   - Run unrelated VBA macros by name when explicitly requested
 *   - Upload .xlsm to Drive (preserves VBA project; never converts to xlsx)
 *
 * Requires (for COM paths):
 *   - Windows
 *   - Microsoft Excel installed
 *   - pywin32 (win32com)
 *   - "Trust access to the VBA project object model" for stub neutralization
 */

import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  LATERAL_CONFLICTING_STATUS_MACRO,
  LATERAL_STATUS_VBA_MODULE_NAME,
  STATUS_LOGIC_OWNER,
  VBA_STATUS_INTEGRATION_POLICY,
  buildSafeStatusMacroStubSource,
  vbaSourceLooksLikeConflictingStatusLogic,
  vbaSourceLooksLikeSafeStatusStub,
} from "@/services/lateral-processing/lateral-vba-status-integration";
import { updateConfiguredMasterWorkbookInPlace } from "@/services/lateral-processing/lateral-master-drive-update";

const execFileAsync = promisify(execFile);

export const LATERAL_STATUS_MACRO = LATERAL_CONFLICTING_STATUS_MACRO;

export interface MacroExecutionResult {
  ok: boolean;
  macroName: string;
  startTime: string;
  endTime: string;
  durationMs: number;
  /**
   * success — macro ran (legacy path)
   * skipped_superseded — conflicting status macro not executed; Dataset owns status
   * failed / unavailable — error paths
   */
  result:
    | "success"
    | "failed"
    | "unavailable"
    | "skipped_superseded";
  errorMessage: string | null;
  excelVersion: string | null;
  /** Dataset backend owns Job Status Column K */
  statusLogicOwner?: typeof STATUS_LOGIC_OWNER;
  /** True when Module11 was replaced with the safe stub */
  conflictingMacroNeutralized?: boolean;
  neutralizationNote?: string | null;
}

async function environmentSupportsExcelVba(): Promise<{
  ok: true;
  excelVersion: string;
} | { ok: false; reason: string }> {
  if (process.platform !== "win32") {
    return {
      ok: false,
      reason:
        "VBA macro execution requires Windows with Microsoft Excel. Current platform is not Windows.",
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
    # DispatchEx + CoInitialize is required for reliable Excel COM from Node/hidden Python.
    # Plain Dispatch() often yields a broken proxy (Excel.Application.Version AttributeError).
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

  const probePath = path.join(os.tmpdir(), `excel-probe-${Date.now()}.py`);
  try {
    await fs.writeFile(probePath, probe, "utf8");
    const { stdout } = await execFileAsync("python", [probePath], {
      windowsHide: true,
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    });
    const parsed = JSON.parse((stdout || "").trim() || "{}") as {
      ok?: boolean;
      excelVersion?: string;
      reason?: string;
    };
    if (!parsed.ok) {
      return { ok: false, reason: parsed.reason || "Excel COM probe failed." };
    }
    return { ok: true, excelVersion: parsed.excelVersion || "unknown" };
  } catch (err) {
    return {
      ok: false,
      reason:
        err instanceof Error
          ? `Excel environment check failed: ${err.message}`
          : "Excel environment check failed.",
    };
  } finally {
    await fs.unlink(probePath).catch(() => undefined);
  }
}

function buildMacroRunnerScript(): string {
  return `
import json, sys, time, threading
from pathlib import Path

workbook_path = str(Path(sys.argv[1]).resolve())
macro_name = sys.argv[2]
timeout_sec = int(sys.argv[3]) if len(sys.argv) > 3 else 180

def auto_dismiss_msgboxes(stop_event):
    """Dismiss VBA MsgBox dialogs so headless automation can complete."""
    try:
        import win32gui
        import win32con
    except ImportError:
        return
    while not stop_event.is_set():
        try:
            def enum_handler(hwnd, _):
                try:
                    if not win32gui.IsWindowVisible(hwnd):
                        return
                    class_name = win32gui.GetClassName(hwnd)
                    if class_name != "#32770":
                        return
                    # Prefer a button labeled OK / Yes
                    for label in ("OK", "Yes", "&OK", "&Yes"):
                        btn = win32gui.FindWindowEx(hwnd, 0, "Button", label)
                        if btn:
                            win32gui.PostMessage(btn, win32con.WM_LBUTTONDOWN, 0, 0)
                            win32gui.PostMessage(btn, win32con.WM_LBUTTONUP, 0, 0)
                            return
                    # Fallback: default button ID 1 (OK)
                    win32gui.PostMessage(hwnd, win32con.WM_COMMAND, 1, 0)
                except Exception:
                    pass
            win32gui.EnumWindows(enum_handler, None)
        except Exception:
            pass
        time.sleep(0.35)

stop_event = threading.Event()
dismiss_thread = threading.Thread(target=auto_dismiss_msgboxes, args=(stop_event,), daemon=True)
dismiss_thread.start()

excel = None
wb = None
start = time.time()
try:
    import pythoncom
    import win32com.client
    pythoncom.CoInitialize()

    excel = win32com.client.DispatchEx("Excel.Application")
    excel.Visible = False
    excel.DisplayAlerts = False
    excel.AskToUpdateLinks = False
    try:
        # msoAutomationSecurityLow = 1 — allow macros for automation
        excel.AutomationSecurity = 1
    except Exception:
        pass
    try:
        excel.EnableEvents = False
    except Exception:
        pass
    try:
        excel.ScreenUpdating = False
    except Exception:
        pass

    version = str(excel.Version)
    # Positional args only — keyword ReadOnly=/SaveChanges= can raise "'bool' object is not callable"
    wb = excel.Workbooks.Open(workbook_path, 0, False)

    # Run the existing workbook macro by name — do not reimplement it.
    macro_ran = False
    try:
        excel.Run(macro_name)
        macro_ran = True
    except Exception:
        book_name = Path(workbook_path).name
        excel.Run("'" + book_name + "'!" + macro_name)
        macro_ran = True

    if macro_ran:
        # Late-bound Workbook.Save is sometimes a bool property, not a method.
        try:
            wb.Save()
        except TypeError:
            excel.ActiveWorkbook.Save()

    elapsed_ms = int((time.time() - start) * 1000)
    print(json.dumps({
        "ok": True,
        "excelVersion": version,
        "durationMs": elapsed_ms,
        "message": f"Macro {macro_name} completed successfully.",
    }))
except Exception as e:
    elapsed_ms = int((time.time() - start) * 1000)
    print(json.dumps({
        "ok": False,
        "excelVersion": None,
        "durationMs": elapsed_ms,
        "error": str(e),
    }))
finally:
    stop_event.set()
    try:
        if wb is not None:
            wb.Close(False)
    except Exception:
        pass
    try:
        if excel is not None:
            excel.Quit()
    except Exception:
        pass
    try:
        import pythoncom
        pythoncom.CoUninitialize()
    except Exception:
        pass
`.trim();
}

async function uploadLocalExcelToDrive(
  fileId: string,
  localPath: string,
  fileName: string
): Promise<void> {
  // Legacy helper — Master updates must go through updateConfiguredMasterWorkbookInPlace
  // so we never files.create a second Master and always verify XLSM/VBA/content.
  const result = await updateConfiguredMasterWorkbookInPlace({
    localWorkbookPath: localPath,
    masterFileId: fileId,
    masterFileName: fileName,
  });
  if (!result.ok) {
    throw new Error(result.error);
  }
}

/**
 * Run UpdateJobRequisitionsStatusLateral (or another named macro) on a local .xlsm.
 * Mutates the local file in place (Excel Save). Caller uploads afterward if needed.
 */
export async function runWorkbookVbaMacro(options: {
  localWorkbookPath: string;
  macroName?: string;
  timeoutMs?: number;
}): Promise<MacroExecutionResult> {
  const macroName = options.macroName || LATERAL_STATUS_MACRO;
  const timeoutMs = options.timeoutMs ?? 180_000;
  const startTime = new Date();
  const startIso = startTime.toISOString();

  const fail = (
    result: MacroExecutionResult["result"],
    errorMessage: string,
    excelVersion: string | null = null
  ): MacroExecutionResult => {
    const endTime = new Date();
    return {
      ok: false,
      macroName,
      startTime: startIso,
      endTime: endTime.toISOString(),
      durationMs: endTime.getTime() - startTime.getTime(),
      result,
      errorMessage,
      excelVersion,
    };
  };

  if (!existsSync(options.localWorkbookPath)) {
    return fail("failed", `Workbook not found: ${options.localWorkbookPath}`);
  }

  const lower = options.localWorkbookPath.toLowerCase();
  if (!lower.endsWith(".xlsm") && !lower.endsWith(".xls")) {
    return fail(
      "unavailable",
      `VBA macros require a macro-enabled workbook (.xlsm). Got: ${path.extname(options.localWorkbookPath)}`
    );
  }

  const env = await environmentSupportsExcelVba();
  if (!env.ok) {
    return fail("unavailable", env.reason);
  }

  const scriptPath = path.join(os.tmpdir(), `run-vba-${Date.now()}.py`);
  try {
    await fs.writeFile(scriptPath, buildMacroRunnerScript(), "utf8");
    const { stdout, stderr } = await execFileAsync(
      "python",
      [
        scriptPath,
        options.localWorkbookPath,
        macroName,
        String(Math.ceil(timeoutMs / 1000)),
      ],
      {
        windowsHide: true,
        timeout: timeoutMs + 15_000,
        maxBuffer: 4 * 1024 * 1024,
      }
    );

    const parsed = JSON.parse((stdout || "").trim() || "{}") as {
      ok?: boolean;
      excelVersion?: string | null;
      durationMs?: number;
      error?: string;
      message?: string;
    };

    const endTime = new Date();
    if (!parsed.ok) {
      return {
        ok: false,
        macroName,
        startTime: startIso,
        endTime: endTime.toISOString(),
        durationMs: parsed.durationMs ?? endTime.getTime() - startTime.getTime(),
        result: "failed",
        errorMessage:
          parsed.error ||
          stderr?.trim() ||
          `Macro ${macroName} failed.`,
        excelVersion: parsed.excelVersion ?? env.excelVersion,
      };
    }

    return {
      ok: true,
      macroName,
      startTime: startIso,
      endTime: endTime.toISOString(),
      durationMs: parsed.durationMs ?? endTime.getTime() - startTime.getTime(),
      result: "success",
      errorMessage: null,
      excelVersion: parsed.excelVersion ?? env.excelVersion,
    };
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Macro execution failed.";
    const timedOut = /TIMEOUT|timed out/i.test(message);
    return fail(
      "failed",
      timedOut
        ? `Macro ${macroName} timed out after ${timeoutMs}ms. Excel may be blocked by a MsgBox or dialog.`
        : message,
      env.excelVersion
    );
  } finally {
    await fs.unlink(scriptPath).catch(() => undefined);
  }
}

/**
 * After reconciled Master is saved: DO NOT run conflicting status VBA.
 * Neutralize Module11 to a safe stub (when Excel VBA trust allows), then upload.
 * Dataset backend status on Column K is preserved.
 */
export async function finalizeReconciledWorkbookWithoutConflictingStatusVba(options: {
  localWorkbookPath: string;
  masterFileId: string;
  masterFileName: string;
}): Promise<MacroExecutionResult> {
  const macroName = LATERAL_STATUS_MACRO;
  const startTime = new Date();
  const startIso = startTime.toISOString();

  if (!VBA_STATUS_INTEGRATION_POLICY.runConflictingStatusMacroAfterReconcile) {
    // Explicit: never Application.Run the old Active/Closed/New merger after reconcile.
  }

  const neutralization = await neutralizeConflictingStatusMacroInWorkbook(
    options.localWorkbookPath
  );

  try {
    await uploadLocalExcelToDrive(
      options.masterFileId,
      options.localWorkbookPath,
      options.masterFileName
    );
  } catch (err) {
    const endTime = new Date();
    return {
      ok: false,
      macroName,
      startTime: startIso,
      endTime: endTime.toISOString(),
      durationMs: endTime.getTime() - startTime.getTime(),
      result: "failed",
      errorMessage:
        err instanceof Error
          ? `Status-safe finalize upload failed: ${err.message}`
          : "Status-safe finalize upload to Drive failed.",
      excelVersion: neutralization.excelVersion,
      statusLogicOwner: STATUS_LOGIC_OWNER,
      conflictingMacroNeutralized: neutralization.neutralized,
      neutralizationNote: neutralization.note,
    };
  }

  const endTime = new Date();
  return {
    ok: true,
    macroName,
    startTime: startIso,
    endTime: endTime.toISOString(),
    durationMs: endTime.getTime() - startTime.getTime(),
    result: "skipped_superseded",
    errorMessage: null,
    excelVersion: neutralization.excelVersion,
    statusLogicOwner: STATUS_LOGIC_OWNER,
    conflictingMacroNeutralized: neutralization.neutralized,
    neutralizationNote: neutralization.note,
  };
}

/**
 * Replace Module11 body with the safe stub. Does not delete the VBA project
 * or other modules. Fails soft if VBA project trust is disabled.
 */
export async function neutralizeConflictingStatusMacroInWorkbook(
  localWorkbookPath: string
): Promise<{
  neutralized: boolean;
  note: string;
  excelVersion: string | null;
}> {
  if (!existsSync(localWorkbookPath)) {
    return {
      neutralized: false,
      note: `Workbook not found for neutralization: ${localWorkbookPath}`,
      excelVersion: null,
    };
  }

  if (process.platform !== "win32") {
    return {
      neutralized: false,
      note:
        "VBA neutralization skipped on non-Windows host. Conflicting status macro was NOT run; Dataset Column K status preserved.",
      excelVersion: null,
    };
  }

  const stub = buildSafeStatusMacroStubSource();
  // Strip Attribute line for CodeModule.AddFromString (Excel adds module name separately)
  const stubBody = stub
    .split(/\r?\n/)
    .filter((line) => !/^Attribute\s+VB_Name\s*=/i.test(line))
    .join("\r\n")
    .trimEnd();

  const script = `
import json, sys
from pathlib import Path

workbook_path = str(Path(sys.argv[1]).resolve())
module_name = sys.argv[2]
stub_path = sys.argv[3]

stub_body = Path(stub_path).read_text(encoding="utf-8")

try:
    import pythoncom
    import win32com.client
except ImportError:
    print(json.dumps({"ok": False, "neutralized": False, "note": "pywin32 not installed", "excelVersion": None}))
    sys.exit(0)

pythoncom.CoInitialize()
excel = None
wb = None
try:
    excel = win32com.client.DispatchEx("Excel.Application")
    excel.Visible = False
    excel.DisplayAlerts = False
    excel.AskToUpdateLinks = False
    try:
        excel.AutomationSecurity = 1
    except Exception:
        pass
    version = str(excel.Version)
    wb = excel.Workbooks.Open(workbook_path, UpdateLinks=0, ReadOnly=False)

    try:
        vbproj = wb.VBProject
    except Exception as e:
        print(json.dumps({
            "ok": True,
            "neutralized": False,
            "excelVersion": version,
            "note": (
                "Could not access VBA project (enable Trust access to the VBA project object model). "
                f"Conflicting status macro was NOT executed. Dataset Column K status preserved. Detail: {e}"
            ),
        }))
        sys.exit(0)

    target = None
    for i in range(1, vbproj.VBComponents.Count + 1):
        comp = vbproj.VBComponents(i)
        if str(comp.Name) == module_name:
            target = comp
            break

    if target is None:
        # Create standard module if missing — keep project; do not remove others
        target = vbproj.VBComponents.Add(1)  # vbext_ct_StdModule = 1
        target.Name = module_name

    code = target.CodeModule
    line_count = int(code.CountOfLines)
    if line_count > 0:
        code.DeleteLines(1, line_count)
    code.AddFromString(stub_body)

    wb.Save()
    print(json.dumps({
        "ok": True,
        "neutralized": True,
        "excelVersion": version,
        "note": (
            f"Module {module_name} neutralized to safe stub. "
            "Conflicting Active/Closed/New/append logic removed. "
            "Unrelated VBA modules preserved. Dataset owns Job Status Column K."
        ),
    }))
except Exception as e:
    print(json.dumps({
        "ok": False,
        "neutralized": False,
        "excelVersion": None,
        "note": f"Neutralization failed: {e}. Conflicting macro was still NOT run; Dataset status preserved.",
    }))
finally:
    try:
        if wb is not None:
            wb.Close(SaveChanges=False)
    except Exception:
        pass
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

  const stubPath = path.join(os.tmpdir(), `lateral-status-stub-${Date.now()}.bas.txt`);
  const scriptPath = path.join(os.tmpdir(), `lateral-neutralize-vba-${Date.now()}.py`);

  try {
    await fs.writeFile(stubPath, stubBody, "utf8");
    await fs.writeFile(scriptPath, script, "utf8");
    const { stdout } = await execFileAsync(
      "python",
      [scriptPath, localWorkbookPath, LATERAL_STATUS_VBA_MODULE_NAME, stubPath],
      {
        windowsHide: true,
        timeout: 180_000,
        maxBuffer: 4 * 1024 * 1024,
      }
    );
    const parsed = JSON.parse((stdout || "").trim() || "{}") as {
      neutralized?: boolean;
      note?: string;
      excelVersion?: string | null;
    };
    return {
      neutralized: Boolean(parsed.neutralized),
      note:
        parsed.note ||
        "Conflicting status macro was not executed. Dataset Column K status preserved.",
      excelVersion: parsed.excelVersion ?? null,
    };
  } catch (err) {
    return {
      neutralized: false,
      note:
        err instanceof Error
          ? `Neutralization skipped (${err.message}). Conflicting status macro was NOT run; Dataset Column K status preserved.`
          : "Neutralization skipped. Conflicting status macro was NOT run; Dataset Column K status preserved.",
      excelVersion: null,
    };
  } finally {
    await fs.unlink(stubPath).catch(() => undefined);
    await fs.unlink(scriptPath).catch(() => undefined);
  }
}

/**
 * @deprecated Prefer finalizeReconciledWorkbookWithoutConflictingStatusVba.
 * Legacy path that ran UpdateJobRequisitionsStatusLateral — unsafe after Dataset status engine.
 * Kept for explicit opt-in only; Dataset confirm flow must not call this.
 */
export async function runLateralStatusMacroAndUpload(options: {
  localWorkbookPath: string;
  masterFileId: string;
  masterFileName: string;
}): Promise<MacroExecutionResult> {
  // Hard redirect: never blindly run conflicting status VBA after reconcile.
  return finalizeReconciledWorkbookWithoutConflictingStatusVba(options);
}

export {
  buildSafeStatusMacroStubSource,
  vbaSourceLooksLikeConflictingStatusLogic,
  vbaSourceLooksLikeSafeStatusStub,
  VBA_STATUS_INTEGRATION_POLICY,
};
