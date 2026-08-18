/**
 * STEP 9.1 — One-time production backfill of Posted Sheet B/C.
 *
 * Downloads the current Drive XLSM, fills B/C + recalculates Master M,
 * refreshes the existing P-Roles pivot, and uploads in place ONLY if
 * every safety check passes.
 *
 * Does NOT: Gmail search/sync, source download/upload, Run All,
 * checkpoint write, New Sheet edits, Column K recalculation.
 *
 * Run: npx tsx scripts/step91-production-posted-bc-backfill.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getAuthorizedGmailClient } from "../src/services/gmail/oauth";
import { readLateralGmailCheckpoint } from "../src/services/lateral-processing/lateral-gmail-checkpoint-store";
import { applyPostedSheetMatchingToStagedWorkbook } from "../src/services/lateral-processing/lateral-posted-sheet-processor";
import { refreshPRolesPivotOnStagedWorkbook } from "../src/services/lateral-processing/lateral-p-roles-pivot-refresh";
import { readHomeWidgetsMetricsSnapshot } from "../src/services/home/home-widgets-metrics-store";
import { refreshLateralHomeWidgetsMetricsFromFinalMaster } from "../src/services/home/refresh-lateral-home-widgets-metrics";

const execFileAsync = promisify(execFile);

const EXPECTED_FILE_ID = "1ztfWeVhDyzYOHlvA8ujzvtSapRDvvPw9";
const EXPECTED_NAME =
  "Copy of ATCI Lateral DS AI MasterSheet Final 2026.xlsm";
const EXPECTED_CHECKPOINT = "1a00f3102fe8594c";
const XLSM_MIME =
  "application/vnd.ms-excel.sheet.macroEnabled.12";
const BACKUP_ROOT = path.resolve(
  process.cwd(),
  "..",
  "backups",
  "lateral-step91"
);

type Stage =
  | "preflight"
  | "download"
  | "backup"
  | "inspect"
  | "posted-bc"
  | "column-k"
  | "cross-check"
  | "p-roles"
  | "safety-diff"
  | "upload"
  | "verify"
  | "home";

type Report = {
  ok: boolean;
  stage: Stage;
  failure?: string;
  productionModified: boolean;
  fileId: string;
  backupPath?: string;
  backupSha256?: string;
  backupMd5?: string;
  backupSize?: number;
  productionBefore?: Record<string, unknown>;
  productionAfter?: Record<string, unknown>;
  finalSha256?: string;
  checkpointBefore?: string | null;
  checkpointAfter?: string | null;
  inspect?: unknown;
  posted?: unknown;
  master?: unknown;
  pRoles?: unknown;
  unexpectedChanges?: string[];
  homeBefore?: unknown;
  homeAfter?: unknown;
};

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function hashFile(filePath: string, algo: "sha256" | "md5"): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash(algo);
    const stream = createReadStream(filePath);
    stream.on("data", (d) => hash.update(d));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function runPython(
  script: string,
  args: string[] = [],
  timeoutMs = 300_000
): Promise<unknown> {
  const scriptPath = path.join(
    os.tmpdir(),
    `step91-${Date.now()}-${Math.random().toString(16).slice(2)}.py`
  );
  await fs.writeFile(scriptPath, script, "utf8");
  try {
    const { stdout, stderr } = await execFileAsync("python", [scriptPath, ...args], {
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
    });
    const text = (stdout || "").trim();
    if (!text) {
      throw new Error(stderr || "Python produced no output");
    }
    return JSON.parse(text);
  } finally {
    await fs.unlink(scriptPath).catch(() => undefined);
  }
}

const INSPECT_PY = `
import json, sys, zipfile, hashlib
from collections import Counter
from openpyxl import load_workbook

path = sys.argv[1]
out = {"ok": True, "path": path}

with zipfile.ZipFile(path) as z:
    names = z.namelist()
    vba_names = [n for n in names if n.lower().endswith("vbaproject.bin")]
    out["vba"] = bool(vba_names)
    if vba_names:
        h = hashlib.sha256()
        h.update(z.read(vba_names[0]))
        out["vbaSha256"] = h.hexdigest()
    pivots = [n for n in names if n.lower().startswith("xl/pivottables/") and n.endswith(".xml") and "/_rels/" not in n]
    out["pivotXmlCount"] = len(pivots)
    out["xlsm"] = path.lower().endswith(".xlsm")

wb = load_workbook(path, read_only=False, data_only=False, keep_vba=True)
out["sheets"] = list(wb.sheetnames)
required = ["Master Sheet", "New Sheet", "Posted Sheet", "P-Roles"]
out["missingSheets"] = [s for s in required if s not in wb.sheetnames]

def col_vals(ws, col, last):
    vals = []
    for r in range(2, last + 1):
        v = ws.cell(r, col).value
        vals.append("" if v is None else str(v).strip())
    return vals

def last_row(ws, col=1):
    n = 1
    for i, row in enumerate(ws.iter_rows(min_col=col, max_col=col, min_row=2, values_only=True), start=2):
        if row[0] is not None and str(row[0]).strip() != "":
            n = i
    return n

if "Master Sheet" in wb.sheetnames:
    ms = wb["Master Sheet"]
    headers = []
    for c in range(1, 14):
        headers.append(str(ms.cell(1, c).value or "").strip())
    out["masterHeaders"] = headers
    out["colKHeader"] = headers[10] if len(headers) > 10 else ""
    out["colMHeader"] = headers[12] if len(headers) > 12 else ""
    last_m = last_row(ms, 2)
    out["masterDataRows"] = max(0, last_m - 1)
    k = col_vals(ms, 11, last_m)
    m = col_vals(ms, 13, last_m)
    jrs = col_vals(ms, 2, last_m)
    out["kCounts"] = dict(Counter(k))
    out["mCounts"] = dict(Counter(m))
    out["kSha256"] = hashlib.sha256("\\n".join(k).encode("utf-8")).hexdigest()
    out["jrSha256"] = hashlib.sha256("\\n".join(jrs).encode("utf-8")).hexdigest()
    out["mSha256"] = hashlib.sha256("\\n".join(m).encode("utf-8")).hexdigest()
    out["masterJrSetSize"] = len({j for j in jrs if j})

if "Posted Sheet" in wb.sheetnames:
    ps = wb["Posted Sheet"]
    out["postedHeaders"] = [str(ps.cell(1, c).value or "").strip() for c in range(1, 4)]
    last_p = last_row(ps, 1)
    a = col_vals(ps, 1, last_p)
    b = col_vals(ps, 2, last_p)
    c = col_vals(ps, 3, last_p)
    out["postedRowsRead"] = len(a)
    valid = []
    for i, av in enumerate(a):
        if av.startswith("ATCI"):
            valid.append({"a": av, "b": b[i] if i < len(b) else "", "c": c[i] if i < len(c) else ""})
    out["postedValidAtci"] = len(valid)
    out["postedNonAtci"] = sum(1 for av in a if av and not av.startswith("ATCI"))
    out["blankB"] = sum(1 for row in valid if not row["b"])
    out["blankC"] = sum(1 for row in valid if not row["c"])
    out["cYes"] = sum(1 for row in valid if row["c"] == "Yes")
    out["cNo"] = sum(1 for row in valid if row["c"] == "No")
    out["bPopulated"] = sum(1 for row in valid if row["b"])
    out["aSha256"] = hashlib.sha256("\\n".join(a).encode("utf-8")).hexdigest()
    out["bSha256"] = hashlib.sha256("\\n".join(b).encode("utf-8")).hexdigest()
    out["cSha256"] = hashlib.sha256("\\n".join(c).encode("utf-8")).hexdigest()

if "New Sheet" in wb.sheetnames:
    ns = wb["New Sheet"]
    last_n = last_row(ns, 2)
    nh = [str(ns.cell(1, c).value or "").strip() for c in range(1, 11)]
    out["newHeaders"] = nh
    out["newDataRows"] = max(0, last_n - 1)
    nd = []
    for r in range(1, last_n + 1):
        nd.append("|".join(str(ns.cell(r, c).value or "").strip() for c in range(1, 11)))
    out["newSha256"] = hashlib.sha256("\\n".join(nd).encode("utf-8")).hexdigest()

if "P-Roles" in wb.sheetnames:
    pr = wb["P-Roles"]
    out["pRolesA1"] = str(pr.cell(1, 1).value or "")
    out["pRolesMaxRow"] = pr.max_row

wb.close()
print(json.dumps(out))
`.trim();

const CROSS_PY = `
import json, sys
from openpyxl import load_workbook

path = sys.argv[1]
wb = load_workbook(path, read_only=False, data_only=False, keep_vba=True)
ms = wb["Master Sheet"]
ps = wb["Posted Sheet"]

jr_col = None
for c in range(1, 20):
    if str(ms.cell(1, c).value or "").strip().lower() == "job requisition id":
        jr_col = c
        break
if jr_col is None:
    print(json.dumps({"ok": False, "error": "Master Job Requisition ID header missing"}))
    raise SystemExit(0)

master_jrs = set()
master_m = {}
k_counts = {}
m_counts = {"Yes": 0, "-": 0, "other": 0}
last_m = 1
for r in range(2, (ms.max_row or 1) + 1):
    jr = str(ms.cell(r, jr_col).value or "").strip()
    if not jr:
        continue
    last_m = r
    master_jrs.add(jr)
    mv = str(ms.cell(r, 13).value or "").strip()
    master_m[jr] = mv
    if mv == "Yes":
        m_counts["Yes"] += 1
    elif mv == "-":
        m_counts["-"] += 1
    else:
        m_counts["other"] += 1
    kv = str(ms.cell(r, 11).value or "").strip()
    k_counts[kv] = k_counts.get(kv, 0) + 1

mismatches = []
posted_yes_jrs = set()
posted_all_jrs = set()
valid = 0
blank_b = 0
blank_c = 0
c_yes = 0
c_no = 0
b_in_master = 0
b_not_in_master = 0
extract_mismatch = 0
malformed = []

def extract_jr(a):
    s = (a or "").strip()
    if not s:
        return ""
    for i, ch in enumerate(s):
        if ch in (" ", "|"):
            return s[:i].strip()
    return s

for r in range(2, (ps.max_row or 1) + 1):
    a = str(ps.cell(r, 1).value or "").strip()
    b = str(ps.cell(r, 2).value or "").strip()
    c = str(ps.cell(r, 3).value or "").strip()
    if not a:
        continue
    if not a.startswith("ATCI"):
        malformed.append({"row": r, "reason": "non-ATCI-remaining", "a": a[:80]})
        continue
    valid += 1
    expected_b = extract_jr(a)
    if b != expected_b:
        extract_mismatch += 1
        if len(mismatches) < 25:
            mismatches.append({"row": r, "type": "B-extract", "a": a[:80], "b": b, "expected": expected_b})
    if not b:
        blank_b += 1
        continue
    posted_all_jrs.add(b)
    in_master = b in master_jrs
    if in_master:
        b_in_master += 1
        posted_yes_jrs.add(b)
        if c != "Yes":
            if len(mismatches) < 25:
                mismatches.append({"row": r, "type": "C-should-Yes", "b": b, "c": c})
        mm = master_m.get(b)
        if mm != "Yes":
            if len(mismatches) < 25:
                mismatches.append({"row": r, "type": "Master-M-should-Yes", "b": b, "m": mm})
    else:
        b_not_in_master += 1
        if c != "No":
            if len(mismatches) < 25:
                mismatches.append({"row": r, "type": "C-should-No", "b": b, "c": c})
    if not c:
        blank_c += 1
    elif c == "Yes":
        c_yes += 1
    elif c == "No":
        c_no += 1
    else:
        if len(mismatches) < 25:
            mismatches.append({"row": r, "type": "C-invalid", "b": b, "c": c})

master_m_wrong_dash = 0
for jr, mv in master_m.items():
    if jr not in posted_all_jrs and mv != "-":
        master_m_wrong_dash += 1
        if len(mismatches) < 25:
            mismatches.append({"type": "Master-M-should-dash", "jr": jr, "m": mv})

headers = [str(ps.cell(1, c).value or "").strip() for c in range(1, 4)]
wb.close()
print(json.dumps({
    "ok": extract_mismatch == 0 and len(mismatches) == 0 and blank_b == 0 and blank_c == 0 and master_m_wrong_dash == 0,
    "postedHeaders": headers,
    "validAtci": valid,
    "blankB": blank_b,
    "blankC": blank_c,
    "cYes": c_yes,
    "cNo": c_no,
    "bPopulated": valid - blank_b,
    "bInMasterRows": b_in_master,
    "bNotInMasterRows": b_not_in_master,
    "uniquePostedJrs": len(posted_all_jrs),
    "uniquePostedJrsInMaster": len(posted_yes_jrs),
    "masterMYes": m_counts["Yes"],
    "masterMDash": m_counts["-"],
    "masterMOther": m_counts["other"],
    "kCounts": k_counts,
    "extractMismatch": extract_mismatch,
    "masterMWrongDash": master_m_wrong_dash,
    "malformed": malformed[:20],
    "mismatchCount": len(mismatches),
    "mismatches": mismatches[:25],
}))
`.trim();

const DIFF_PY = `
import json, sys, zipfile, hashlib
from openpyxl import load_workbook

before_path = sys.argv[1]
after_path = sys.argv[2]
skip_proles = sys.argv[3] == "1"

def vba_hash(p):
    with zipfile.ZipFile(p) as z:
        names = [n for n in z.namelist() if n.lower().endswith("vbaproject.bin")]
        if not names:
            return None
        h = hashlib.sha256()
        h.update(z.read(names[0]))
        return h.hexdigest()

def sheets(p):
    wb = load_workbook(p, read_only=False, data_only=False, keep_vba=True)
    names = list(wb.sheetnames)
    wb.close()
    return names

unexpected = []
vb0 = vba_hash(before_path)
vb1 = vba_hash(after_path)
if vb0 != vb1:
    unexpected.append(f"VBA project hash changed ({vb0} -> {vb1})")

s0 = sheets(before_path)
s1 = sheets(after_path)
if s0 != s1:
    unexpected.append(f"Sheet structure changed: {s0} -> {s1}")

wb0 = load_workbook(before_path, read_only=False, data_only=False, keep_vba=True)
wb1 = load_workbook(after_path, read_only=False, data_only=False, keep_vba=True)

def header_row(ws, n=20):
    return [str(ws.cell(1, c).value or "").strip() for c in range(1, n + 1)]

# Master: headers, row count, all columns except M (13)
ms0 = wb0["Master Sheet"]
ms1 = wb1["Master Sheet"]
h0 = header_row(ms0, 13)
h1 = header_row(ms1, 13)
if h0 != h1:
    unexpected.append(f"Master headers changed: {h0} -> {h1}")

def last_jr(ws):
    last = 1
    for i, row in enumerate(ws.iter_rows(min_col=2, max_col=2, min_row=2, values_only=True), start=2):
        if row[0] is not None and str(row[0]).strip() != "":
            last = i
    return last

l0 = last_jr(ms0)
l1 = last_jr(ms1)
if l0 != l1:
    unexpected.append(f"Master row count changed: {l0-1} -> {l1-1}")

changed_master_cols = {}
max_l = max(l0, l1)
for r in range(1, max_l + 1):
    for c in range(1, 14):
        if c == 13 and r > 1:
            continue
        v0 = str(ms0.cell(r, c).value or "")
        v1 = str(ms1.cell(r, c).value or "")
        if v0 != v1:
            changed_master_cols[c] = changed_master_cols.get(c, 0) + 1
            if sum(changed_master_cols.values()) <= 8:
                unexpected.append(f"Master unexpected cell R{r}C{c}: {v0[:60]!r} -> {v1[:60]!r}")
if changed_master_cols:
    unexpected.append(f"Master unexpected column diffs (excluding M data): {changed_master_cols}")

# New Sheet full A-J compare
ns0 = wb0["New Sheet"]
ns1 = wb1["New Sheet"]
if header_row(ns0, 10) != header_row(ns1, 10):
    unexpected.append("New Sheet headers changed")
new_diffs = 0
max_n = max(ns0.max_row or 1, ns1.max_row or 1)
for r in range(1, max_n + 1):
    for c in range(1, 11):
        v0 = str(ns0.cell(r, c).value or "")
        v1 = str(ns1.cell(r, c).value or "")
        if v0 != v1:
            new_diffs += 1
            if new_diffs <= 5:
                unexpected.append(f"New Sheet R{r}C{c} changed")
if new_diffs:
    unexpected.append(f"New Sheet cell diffs: {new_diffs}")

# Posted Column A must remain
ps0 = wb0["Posted Sheet"]
ps1 = wb1["Posted Sheet"]
a_diffs = 0
max_p = max(ps0.max_row or 1, ps1.max_row or 1)
# headers A preserved; B/C headers expected to change
a0h = str(ps0.cell(1, 1).value or "")
a1h = str(ps1.cell(1, 1).value or "")
if a0h != a1h:
    unexpected.append(f"Posted A1 header changed: {a0h!r} -> {a1h!r}")
for r in range(2, max_p + 1):
    v0 = str(ps0.cell(r, 1).value or "").strip()
    v1 = str(ps1.cell(r, 1).value or "").strip()
    if v0 != v1:
        a_diffs += 1
        if a_diffs <= 5:
            unexpected.append(f"Posted A changed at row {r}: {v0[:70]!r} -> {v1[:70]!r}")
if a_diffs:
    unexpected.append(f"Posted Column A data diffs: {a_diffs}")

# Other sheets except P-Roles (openpyxl/COM may rewrite P-Roles)
if not skip_proles:
    for name in s0:
        if name in ("Master Sheet", "New Sheet", "Posted Sheet", "P-Roles"):
            continue
        if name not in wb1.sheetnames:
            unexpected.append(f"Sheet missing after edit: {name}")
            continue
        w0 = wb0[name]
        w1 = wb1[name]
        diffs = 0
        mr = max(w0.max_row or 1, w1.max_row or 1)
        mc = max(w0.max_column or 1, w1.max_column or 1)
        cap_c = min(mc, 20)
        cap_r = min(mr, 200)
        for r in range(1, cap_r + 1):
            for c in range(1, cap_c + 1):
                if str(w0.cell(r, c).value or "") != str(w1.cell(r, c).value or ""):
                    diffs += 1
        if diffs:
            unexpected.append(f"Sheet '{name}' cell diffs (sampled): {diffs}")

wb0.close()
wb1.close()
print(json.dumps({"ok": len(unexpected) == 0, "unexpected": unexpected}))
`.trim();

const P_ROLES_INSPECT_ONLY_PY = `
import json, sys, traceback, re
path = sys.argv[1]
XL_ROW_FIELD = 1
XL_COLUMN_FIELD = 2
XL_PAGE_FIELD = 3
JML_CANONICAL = [
    "8-Associate Manager",
    "9-Team Lead/Consultant",
    "10-Senior Analyst",
    "11-Analyst",
    "12-Associate",
]
try:
    import pythoncom
    import win32com.client
    pythoncom.CoInitialize()
    excel = win32com.client.DispatchEx("Excel.Application")
    excel.Visible = False
    excel.DisplayAlerts = False
    excel.AskToUpdateLinks = False
    excel.EnableEvents = False
    wb = excel.Workbooks.Open(path, UpdateLinks=0, ReadOnly=True, IgnoreReadOnlyRecommended=True)
    p_roles = wb.Worksheets("P-Roles")
    count = int(p_roles.PivotTables().Count)
    if count != 1:
        raise RuntimeError(f"P-Roles must contain exactly one PivotTable (found {count}).")
    pt = p_roles.PivotTables(1)
    name = str(pt.Name)
    posted = []
    for item in pt.PivotFields("Posted").PivotItems():
        n = str(item.Name)
        if not n.startswith("("):
            posted.append(n)
    jml = []
    for item in pt.PivotFields("Job Management Level").PivotItems():
        n = str(item.Name)
        if n.startswith("("):
            continue
        try:
            pos = int(item.Position)
        except Exception:
            pos = 10_000
        jml.append((pos, n))
    jml.sort()
    jml_names = [n for _, n in jml]
    canon = [n for n in JML_CANONICAL if n in jml_names]
    jml_ok = canon == [n for n in jml_names if n in JML_CANONICAL]
    try:
        src = str(pt.PivotCache().SourceData)
    except Exception:
        src = ""
    rows = []
    cols = []
    pages = []
    for f in pt.PivotFields():
        try:
            o = int(f.Orientation)
        except Exception:
            continue
        fn = str(f.Name)
        if o == XL_ROW_FIELD:
            rows.append(fn)
        elif o == XL_COLUMN_FIELD:
            cols.append(fn)
        elif o == XL_PAGE_FIELD:
            pages.append(fn)
    data = [str(df.Name) for df in pt.DataFields]
    wb.Close(False)
    excel.Quit()
    pythoncom.CoUninitialize()
    print(json.dumps({
        "ok": True,
        "refreshed": False,
        "pivotName": name,
        "pivotCount": count,
        "postedFilterItems": posted,
        "jmlOrderPivotItems": jml_names,
        "jmlOrderOk": jml_ok,
        "jmlRenderedHeaders": [],
        "sourceA1": src,
        "rowFields": rows,
        "columnField": cols,
        "filters": pages,
        "valueFieldsActive": data,
        "notes": ["Read-only inspect; workbook was not saved."],
    }))
except Exception as exc:
    print(json.dumps({"ok": False, "error": str(exc), "traceback": traceback.format_exc()}))
`.trim();

async function writeReport(dir: string, report: Report) {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "step91-report.json"),
    JSON.stringify(report, null, 2),
    "utf8"
  );
}

async function fail(report: Report, backupDir: string): Promise<never> {
  report.ok = false;
  if (!report.checkpointAfter) {
    const cp = await readLateralGmailCheckpoint().catch(() => null);
    report.checkpointAfter = cp?.messageId ?? report.checkpointBefore ?? null;
  }
  await writeReport(backupDir, report);
  console.error("\n=== STEP 9.1 FAILED ===");
  console.error("Stage:", report.stage);
  console.error("Failure:", report.failure);
  console.error("Production modified:", report.productionModified ? "YES" : "NO");
  console.error("Backup:", report.backupPath || "(none yet)");
  console.error("Checkpoint before/after:", report.checkpointBefore, "→", report.checkpointAfter);
  process.exit(1);
}

async function downloadDriveFile(
  drive: Awaited<ReturnType<typeof getAuthorizedGmailClient>>["drive"],
  dest: string
) {
  const media = await drive.files.get(
    { fileId: EXPECTED_FILE_ID, alt: "media", supportsAllDrives: true },
    { responseType: "arraybuffer" }
  );
  await fs.writeFile(dest, Buffer.from(media.data as ArrayBuffer));
}

async function main() {
  console.log("=== STEP 9.1 — Production Posted B/C backfill (no Run All / no Gmail) ===\n");

  const backupDir = path.join(BACKUP_ROOT, stamp());
  await fs.mkdir(backupDir, { recursive: true });
  const report: Report = {
    ok: false,
    stage: "preflight",
    productionModified: false,
    fileId: EXPECTED_FILE_ID,
    backupPath: backupDir,
  };

  const checkpointBefore = await readLateralGmailCheckpoint();
  report.checkpointBefore = checkpointBefore.messageId;
  if (checkpointBefore.messageId !== EXPECTED_CHECKPOINT) {
    report.failure = `Gmail checkpoint is ${checkpointBefore.messageId}, expected ${EXPECTED_CHECKPOINT}. Refusing to continue.`;
    return fail(report, backupDir);
  }
  console.log("Checkpoint (read-only):", checkpointBefore.messageId);

  const homeBefore = await readHomeWidgetsMetricsSnapshot();
  report.homeBefore = homeBefore.units.lateral || null;
  console.log(
    "Home Lateral before:",
    homeBefore.units.lateral
      ? `${homeBefore.units.lateral.totals}/${homeBefore.units.lateral.active}/${homeBefore.units.lateral.posted}/${homeBefore.units.lateral.fresh}`
      : "(none)"
  );

  const { drive } = await getAuthorizedGmailClient();
  const beforeMeta = await drive.files.get({
    fileId: EXPECTED_FILE_ID,
    fields: "id,name,size,modifiedTime,md5Checksum,mimeType,trashed",
    supportsAllDrives: true,
  });
  report.productionBefore = beforeMeta.data as Record<string, unknown>;
  console.log("Production before:", JSON.stringify(beforeMeta.data, null, 2));

  if (beforeMeta.data.trashed) {
    report.failure = "Production Master is trashed.";
    return fail(report, backupDir);
  }
  if (beforeMeta.data.id !== EXPECTED_FILE_ID) {
    report.failure = "Drive file ID mismatch.";
    return fail(report, backupDir);
  }
  if ((beforeMeta.data.name || "") !== EXPECTED_NAME) {
    report.failure = `Unexpected production name: ${beforeMeta.data.name}`;
    return fail(report, backupDir);
  }

  report.stage = "download";
  const workPath = path.join(os.tmpdir(), `step91-work-${Date.now()}.xlsm`);
  await downloadDriveFile(drive, workPath);
  console.log("Downloaded to", workPath);

  report.stage = "backup";
  const backupFile = path.join(backupDir, EXPECTED_NAME);
  await fs.copyFile(workPath, backupFile);
  const backupSha = await hashFile(backupFile, "sha256");
  const backupMd5 = await hashFile(backupFile, "md5");
  const backupStat = await fs.stat(backupFile);
  report.backupSha256 = backupSha;
  report.backupMd5 = backupMd5;
  report.backupSize = backupStat.size;
  console.log("Backup SHA256:", backupSha);
  console.log("Backup MD5:   ", backupMd5);
  console.log("Backup size:  ", backupStat.size);
  console.log("Backup path:  ", backupFile);

  report.stage = "inspect";
  const inspect = (await runPython(INSPECT_PY, [backupFile], 180_000)) as {
    ok?: boolean;
    xlsm?: boolean;
    vba?: boolean;
    missingSheets?: string[];
    pivotXmlCount?: number;
    sheets?: string[];
    colKHeader?: string;
    colMHeader?: string;
    kCounts?: Record<string, number>;
    mCounts?: Record<string, number>;
    kSha256?: string;
    jrSha256?: string;
    mSha256?: string;
    masterDataRows?: number;
    postedValidAtci?: number;
    postedRowsRead?: number;
    blankB?: number;
    blankC?: number;
    cYes?: number;
    cNo?: number;
    postedHeaders?: string[];
    newDataRows?: number;
    newSha256?: string;
    aSha256?: string;
    vbaSha256?: string;
  };
  report.inspect = inspect;
  console.log("Inspect:", JSON.stringify({
    sheets: inspect.sheets,
    vba: inspect.vba,
    pivotXmlCount: inspect.pivotXmlCount,
    K: inspect.colKHeader,
    M: inspect.colMHeader,
    kCounts: inspect.kCounts,
    mCounts: inspect.mCounts,
    postedValidAtci: inspect.postedValidAtci,
    postedRowsRead: inspect.postedRowsRead,
    blankB: inspect.blankB,
    blankC: inspect.blankC,
    postedHeaders: inspect.postedHeaders,
  }, null, 2));

  const inspectOk =
    inspect.xlsm === true &&
    inspect.vba === true &&
    (inspect.missingSheets?.length ?? 1) === 0 &&
    (inspect.pivotXmlCount ?? 0) === 1 &&
    inspect.colKHeader === "Job Status" &&
    inspect.colMHeader === "Posted";
  if (!inspectOk) {
    report.failure = `Pre-modification structure check failed: ${JSON.stringify(inspect)}`;
    return fail(report, backupDir);
  }

  const knownK = { Active: 5149, New: 98, Reopen: 82, Closed: 17815 };
  const kDiffs: string[] = [];
  for (const [status, count] of Object.entries(knownK)) {
    if ((inspect.kCounts?.[status] ?? 0) !== count) {
      kDiffs.push(`${status} actual=${inspect.kCounts?.[status] ?? 0} expected=${count}`);
    }
  }
  if (kDiffs.length) {
    console.log("NOTE: Column K counts differ from 17 Aug reference:", kDiffs.join("; "));
  } else {
    console.log("Column K counts match 17 Aug reference.");
  }
  if ((inspect.postedValidAtci ?? 0) !== 5912) {
    console.log(
      `NOTE: Posted valid ATCI rows=${inspect.postedValidAtci} (17 Aug reference was 5912)`
    );
  }

  report.stage = "posted-bc";
  const postedResult = await applyPostedSheetMatchingToStagedWorkbook({
    localWorkbookPath: workPath,
  });
  report.posted = postedResult;
  if (!postedResult.ok) {
    report.failure = postedResult.error;
    return fail(report, backupDir);
  }
  console.log("Posted processor:", JSON.stringify(postedResult.counts, null, 2));

  report.stage = "column-k";
  const afterPostedInspect = (await runPython(INSPECT_PY, [workPath], 180_000)) as typeof inspect;
  if (afterPostedInspect.kSha256 !== inspect.kSha256) {
    report.failure = "Column K fingerprint changed after Posted B/C processing. Production commit aborted.";
    report.inspect = { before: inspect, afterPosted: afterPostedInspect };
    return fail(report, backupDir);
  }
  if (afterPostedInspect.jrSha256 !== inspect.jrSha256) {
    report.failure = "Master Job Requisition IDs changed. Production commit aborted.";
    return fail(report, backupDir);
  }
  if (afterPostedInspect.newSha256 !== inspect.newSha256) {
    report.failure = "New Sheet changed. Production commit aborted.";
    return fail(report, backupDir);
  }
  if (afterPostedInspect.aSha256 !== inspect.aSha256) {
    report.failure = "Posted Column A changed during B/C backfill. Production commit aborted.";
    return fail(report, backupDir);
  }
  console.log("Column K unchanged. New Sheet unchanged. Posted A unchanged.");
  const mUnchanged = afterPostedInspect.mSha256 === inspect.mSha256;
  const vbaUnchangedAfterPosted = afterPostedInspect.vbaSha256 === inspect.vbaSha256;
  console.log(
    `Master M fingerprint ${mUnchanged ? "UNCHANGED" : "CHANGED"}; VBA after Posted ${vbaUnchangedAfterPosted ? "unchanged" : "CHANGED"}`
  );
  if (!vbaUnchangedAfterPosted) {
    report.failure = "VBA project hash changed during Posted B/C processing (openpyxl). Production commit aborted.";
    return fail(report, backupDir);
  }

  report.stage = "cross-check";
  const cross = (await runPython(CROSS_PY, [workPath], 180_000)) as {
    ok?: boolean;
    validAtci?: number;
    blankB?: number;
    blankC?: number;
    cYes?: number;
    cNo?: number;
    bPopulated?: number;
    masterMYes?: number;
    masterMDash?: number;
    mismatches?: unknown[];
    mismatchCount?: number;
    postedHeaders?: string[];
    kCounts?: Record<string, number>;
  };
  report.master = cross;
  console.log("Cross-check:", JSON.stringify({
    ok: cross.ok,
    validAtci: cross.validAtci,
    bPopulated: cross.bPopulated,
    blankB: cross.blankB,
    blankC: cross.blankC,
    cYes: cross.cYes,
    cNo: cross.cNo,
    masterMYes: cross.masterMYes,
    masterMDash: cross.masterMDash,
    mismatchCount: cross.mismatchCount,
    headers: cross.postedHeaders,
  }, null, 2));
  if (!cross.ok) {
    report.failure = `B/C/M cross-check failed: ${JSON.stringify(cross.mismatches || cross)}`;
    return fail(report, backupDir);
  }

  report.stage = "safety-diff";
  const diffAfterPosted = (await runPython(DIFF_PY, [backupFile, workPath, "1"], 300_000)) as {
    ok?: boolean;
    unexpected?: string[];
  };
  if (!diffAfterPosted.ok) {
    report.unexpectedChanges = diffAfterPosted.unexpected;
    report.failure = `Unexpected workbook changes after Posted processing: ${(diffAfterPosted.unexpected || []).join(" | ")}`;
    return fail(report, backupDir);
  }
  console.log("Safety diff after Posted: only B/C (and allowed Master M) changed.");

  report.stage = "p-roles";
  type PRolesInfo = {
    ok: boolean;
    refreshed: boolean;
    pivotName?: string;
    pivotCount?: number;
    postedFilterItems?: string[];
    jmlRenderedHeaders?: string[];
    jmlOrderPivotItems?: string[];
    jmlOrderOk?: boolean;
    sourceA1?: string;
    notes?: string[];
    error?: string;
  };
  let pRoles: PRolesInfo;

  if (mUnchanged) {
    console.log("Master Column M values unchanged — skipping P-Roles refresh (not necessary).");
    if ((afterPostedInspect.pivotXmlCount ?? 0) !== 1) {
      report.failure = `P-Roles PivotTable count after Posted processing is ${afterPostedInspect.pivotXmlCount}, expected 1.`;
      return fail(report, backupDir);
    }
    const inspectedPRoles = (await runPython(P_ROLES_INSPECT_ONLY_PY, [workPath], 180_000)) as PRolesInfo;
    pRoles = { ...inspectedPRoles, refreshed: false };
    report.pRoles = pRoles;
    if (!pRoles.ok) {
      report.failure = `P-Roles read-only inspect failed: ${pRoles.error}`;
      return fail(report, backupDir);
    }
  } else {
    console.log("Master Column M changed — refreshing existing P-Roles PivotTable.");
    const refreshed = await refreshPRolesPivotOnStagedWorkbook({ localWorkbookPath: workPath });
    pRoles = {
      ok: refreshed.ok,
      refreshed: refreshed.ok,
      ...(refreshed.ok
        ? {
            pivotName: refreshed.pivotName,
            pivotCount: refreshed.pivotCount,
            postedFilterItems: refreshed.postedFilterItems,
            jmlRenderedHeaders: refreshed.jmlRenderedHeaders,
            jmlOrderOk: refreshed.jmlOrderOk,
            sourceA1: refreshed.sourceA1,
            notes: refreshed.notes,
          }
        : { error: refreshed.error }),
    };
    report.pRoles = pRoles;
    if (!refreshed.ok) {
      report.failure = `P-Roles refresh failed: ${refreshed.error}`;
      return fail(report, backupDir);
    }
    const afterPRolesInspect = (await runPython(INSPECT_PY, [workPath], 180_000)) as typeof inspect;
    if (afterPRolesInspect.kSha256 !== inspect.kSha256) {
      report.failure = "Column K changed during P-Roles refresh. Production commit aborted.";
      return fail(report, backupDir);
    }
    if (afterPRolesInspect.newSha256 !== inspect.newSha256) {
      report.failure = "New Sheet changed during P-Roles refresh. Production commit aborted.";
      return fail(report, backupDir);
    }
    if (!afterPRolesInspect.vba) {
      report.failure = "VBA project missing after P-Roles refresh. Production commit aborted.";
      return fail(report, backupDir);
    }
    if ((afterPRolesInspect.pivotXmlCount ?? 0) !== 1) {
      report.failure = `P-Roles PivotTable count is ${afterPRolesInspect.pivotXmlCount}, expected 1.`;
      return fail(report, backupDir);
    }
  }

  const postedItems = pRoles.postedFilterItems || [];
  const postedFilterOk = postedItems.includes("-") && postedItems.includes("Yes");
  if (pRoles.pivotCount !== 1 || !postedFilterOk) {
    report.failure = `P-Roles validation failed: count=${pRoles.pivotCount} posted=${postedItems.join(",")} jmlOk=${pRoles.jmlOrderOk} items=${(pRoles.jmlOrderPivotItems || []).join("|")}`;
    return fail(report, backupDir);
  }
  if (pRoles.refreshed && pRoles.jmlOrderOk === false) {
    report.failure = `P-Roles JML order invalid after refresh: ${(pRoles.jmlOrderPivotItems || pRoles.jmlRenderedHeaders || []).join(" | ")}`;
    return fail(report, backupDir);
  }
  if (!pRoles.refreshed && pRoles.jmlOrderOk === false) {
    console.log(
      "NOTE: existing P-Roles JML Position order did not match 8→9→10→11→12:",
      (pRoles.jmlOrderPivotItems || []).join(" | ")
    );
  }
  console.log("P-Roles:", JSON.stringify({
    refreshed: pRoles.refreshed,
    name: pRoles.pivotName,
    count: pRoles.pivotCount,
    postedFilter: pRoles.postedFilterItems,
    jmlItems: pRoles.jmlOrderPivotItems,
    jmlRendered: pRoles.jmlRenderedHeaders,
    jmlOk: pRoles.jmlOrderOk,
    source: pRoles.sourceA1,
  }, null, 2));

  const diffFinal = (await runPython(DIFF_PY, [backupFile, workPath, "1"], 300_000)) as {
    ok?: boolean;
    unexpected?: string[];
  };
  const unexpected = (diffFinal.unexpected || []).filter((msg) => {
    if (!pRoles.refreshed) return true;
    return !msg.startsWith("VBA project hash changed");
  });
  report.unexpectedChanges = unexpected;
  if (unexpected.length) {
    report.failure = `Unexpected workbook changes: ${unexpected.join(" | ")}`;
    return fail(report, backupDir);
  }

  const checkpointMid = await readLateralGmailCheckpoint();
  if (checkpointMid.messageId !== EXPECTED_CHECKPOINT) {
    report.checkpointAfter = checkpointMid.messageId;
    report.failure = "Gmail checkpoint changed before upload. Production commit aborted.";
    return fail(report, backupDir);
  }

  report.stage = "upload";
  console.log("\nAll safety checks passed. Uploading to the same Drive file ID…");
  await drive.files.update({
    fileId: EXPECTED_FILE_ID,
    requestBody: {
      name: EXPECTED_NAME,
      mimeType: XLSM_MIME,
    },
    media: {
      mimeType: XLSM_MIME,
      body: createReadStream(workPath),
    },
    fields: "id,name,size,modifiedTime,md5Checksum,mimeType",
    supportsAllDrives: true,
  });
  report.productionModified = true;

  report.stage = "verify";
  const afterMeta = await drive.files.get({
    fileId: EXPECTED_FILE_ID,
    fields: "id,name,size,modifiedTime,md5Checksum,mimeType",
    supportsAllDrives: true,
  });
  report.productionAfter = afterMeta.data as Record<string, unknown>;
  if (afterMeta.data.id !== EXPECTED_FILE_ID) {
    report.failure = "Drive file ID changed after upload.";
    return fail(report, backupDir);
  }
  if ((afterMeta.data.name || "") !== EXPECTED_NAME) {
    report.failure = `Filename changed after upload: ${afterMeta.data.name}`;
    return fail(report, backupDir);
  }

  const verifyPath = path.join(os.tmpdir(), `step91-verify-${Date.now()}.xlsm`);
  await downloadDriveFile(drive, verifyPath);
  const finalSha = await hashFile(verifyPath, "sha256");
  const finalMd5 = await hashFile(verifyPath, "md5");
  report.finalSha256 = finalSha;
  const verifyInspect = (await runPython(INSPECT_PY, [verifyPath], 180_000)) as typeof inspect;
  const verifyCross = (await runPython(CROSS_PY, [verifyPath], 180_000)) as typeof cross;

  console.log("Re-downloaded SHA256:", finalSha);
  console.log("Re-downloaded MD5:   ", finalMd5);
  console.log("Verify inspect VBA:", verifyInspect.vba, "pivotXml:", verifyInspect.pivotXmlCount);
  console.log("Verify B/C:", {
    valid: verifyCross.validAtci,
    b: verifyCross.bPopulated,
    blankB: verifyCross.blankB,
    blankC: verifyCross.blankC,
    cYes: verifyCross.cYes,
    cNo: verifyCross.cNo,
    mYes: verifyCross.masterMYes,
    mDash: verifyCross.masterMDash,
  });

  if (!verifyInspect.vba || verifyInspect.pivotXmlCount !== 1 || !verifyInspect.xlsm) {
    report.failure = "Post-upload workbook is not XLSM+VBA with exactly one P-Roles pivot.";
    report.inspect = verifyInspect;
    return fail(report, backupDir);
  }
  if (verifyInspect.kSha256 !== inspect.kSha256) {
    report.failure = "Post-upload Column K fingerprint does not match pre-backfill.";
    return fail(report, backupDir);
  }
  if (!verifyCross.ok || (verifyCross.blankB ?? 1) !== 0 || (verifyCross.blankC ?? 1) !== 0) {
    report.failure = `Post-upload B/C/M cross-check failed: ${JSON.stringify(verifyCross)}`;
    return fail(report, backupDir);
  }

  const checkpointAfter = await readLateralGmailCheckpoint();
  report.checkpointAfter = checkpointAfter.messageId;
  if (checkpointAfter.messageId !== EXPECTED_CHECKPOINT) {
    report.failure = `Gmail checkpoint changed to ${checkpointAfter.messageId}`;
    return fail(report, backupDir);
  }

  report.stage = "home";
  const mChanged = afterPostedInspect.mSha256 !== inspect.mSha256;
  try {
    if (mChanged) {
      const homeResult = await refreshLateralHomeWidgetsMetricsFromFinalMaster({
        filePath: workPath,
        fileName: EXPECTED_NAME,
      });
      report.homeAfter = homeResult;
      console.log("Home metrics refresh:", homeResult);
    } else {
      report.homeAfter = { skipped: true, reason: "Master Column M fingerprint unchanged" };
      console.log("Home metrics not refreshed — Column M unchanged.");
    }
  } catch (homeErr) {
    report.homeAfter = {
      ok: false,
      error: homeErr instanceof Error ? homeErr.message : String(homeErr),
    };
    console.log("Home metrics refresh failed (production B/C already committed):", report.homeAfter);
  }
  const homeAfterSnap = await readHomeWidgetsMetricsSnapshot();
  console.log(
    "Home Lateral after:",
    homeAfterSnap.units.lateral
      ? `${homeAfterSnap.units.lateral.totals}/${homeAfterSnap.units.lateral.active}/${homeAfterSnap.units.lateral.posted}/${homeAfterSnap.units.lateral.fresh}`
      : "(none)"
  );

  report.ok = true;
  report.posted = { processor: postedResult, cross: verifyCross, before: inspect };
  report.pRoles = pRoles;
  await writeReport(backupDir, report);
  await fs.unlink(workPath).catch(() => undefined);
  await fs.unlink(verifyPath).catch(() => undefined);

  console.log("\n=== STEP 9.1 PASS ===");
  console.log("1. Production file ID:", EXPECTED_FILE_ID);
  console.log("2. Backup SHA256:", backupSha);
  console.log("3. Final production SHA256:", finalSha);
  console.log("4. Posted valid rows:", verifyCross.validAtci);
  console.log("5. Column B populated:", verifyCross.bPopulated);
  console.log("6. Column C Yes:", verifyCross.cYes);
  console.log("7. Column C No:", verifyCross.cNo);
  console.log("8. Master M Yes:", verifyCross.masterMYes);
  console.log("9. Master M -:", verifyCross.masterMDash);
  console.log("10. Column K before/after:", inspect.kSha256, "===", verifyInspect.kSha256);
  console.log("11. P-Roles refresh:", pRoles.refreshed ? `YES COM name=${pRoles.pivotName}` : `SKIPPED (M unchanged); inspect name=${pRoles.pivotName}`);
  console.log("12. P-Roles PivotTable count:", pRoles.pivotCount);
  console.log("13. Posted filter:", (pRoles.postedFilterItems || []).join(", "));
  console.log("14. JML order:", (pRoles.jmlOrderPivotItems || pRoles.jmlRenderedHeaders || []).join(" | "));
  console.log("15. Gmail checkpoint:", checkpointBefore.messageId, "→", checkpointAfter.messageId);
  console.log("16. Unexpected columns changed:", (report.unexpectedChanges || []).length ? report.unexpectedChanges : "none");
  console.log("17. Overall: PASS");
  console.log("Backup kept at:", backupFile);
}

void main().catch((err) => {
  console.error("STEP 9.1 crashed:", err);
  process.exit(1);
});
