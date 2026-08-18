/**
 * STEP 9 — Isolated Posted Sheet A/B/C validation (FilterAndMatchJobsPosted).
 *
 * Copies a local XLSM (reference workbook, never production Drive) and runs
 * only applyPostedSheetMatchingToStagedWorkbook.
 *
 * Does NOT: Gmail sync, Drive upload, Run All, production Master, checkpoint.
 *
 * Run: npx tsx scripts/verify-lateral-posted-abc-step9.ts
 */
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  applyPostedSheetMatchingToStagedWorkbook,
  cleanPostedColumnAValue,
  extractPostedJobRequisitionId,
} from "../src/services/lateral-processing/lateral-posted-sheet-processor";
import { readLateralGmailCheckpoint } from "../src/services/lateral-processing/lateral-gmail-checkpoint-store";

const execFileAsync = promisify(execFile);

const REFERENCE_XLSM =
  "c:\\Users\\RODGE\\Dropbox\\Restricted Access\\ATCI Control Sheets\\ATCI Lateral\\ATCI Lateral DS AI MasterSheet Final 2026.xlsm";

const CASE1_A = "ATCI-5698629-S2063571 | Posting Date: 08/13/2026 | Pune";
const CASE1_JR = "ATCI-5698629-S2063571";
const CASE2_A = "ATCI-9999999-S9999999 | Posting Date: 08/17/2026 | Pune";
const CASE2_JR = "ATCI-9999999-S9999999";
const CASE3_RAW = "  ATCI-5698629-S2063571\n| Posting Date: 08/13/2026 | Pune  ";
const CASE5_JR = "ATCI-5432596-S1977432";

type Result = { id: string; name: string; ok: boolean; detail: string };
const results: Result[] = [];

function record(id: string, name: string, ok: boolean, detail: string) {
  results.push({ id, name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${id} — ${name}`);
  console.log(`      ${detail}\n`);
}

async function runPython(script: string, args: string[] = []): Promise<unknown> {
  const scriptPath = path.join(os.tmpdir(), `step9-${Date.now()}-${Math.random().toString(16).slice(2)}.py`);
  await fs.writeFile(scriptPath, script, "utf8");
  try {
    const { stdout, stderr } = await execFileAsync("python", [scriptPath, ...args], {
      windowsHide: true,
      timeout: 300_000,
      maxBuffer: 32 * 1024 * 1024,
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

async function injectFixtures(filePath: string) {
  return runPython(
    `
import json, sys
from openpyxl import load_workbook, Workbook

path = sys.argv[1]
create = sys.argv[2] == "1"

if create:
    wb = Workbook()
    default = wb.active
    wb.remove(default)
    ms = wb.create_sheet("Master Sheet")
    headers = [
        "Date", "Job Requisition ID", "Priority", "Job Description",
        "Skill Categorization", "Primary Skills", "Job Management Level",
        "Primary Location/Office locate", "Market Map", "POC",
        "Job Status", "Opened on Oorwin", "Posted",
    ]
    for c, h in enumerate(headers, start=1):
        ms.cell(1, c, h)
    ms.append(["01-01-2026", "ATCI-5698629-S2063571", "P1", "Role match", "Tech", "Java",
               "11-Analyst", "Pune", "India", "POC", "Active", "", "-"])
    ms.append(["01-01-2026", "ATCI-1001-ACTIVE", "P1", "Unposted", "Tech", "Java",
               "11-Analyst", "BLR", "India", "POC", "Closed", "", "Yes"])
    wb.create_sheet("New Sheet")
    wb.create_sheet("Posted Sheet")
    wb.create_sheet("P-Roles")
    wb.save(path)
    wb.close()

wb = load_workbook(path, keep_vba=True, data_only=False)
if "Master Sheet" not in wb.sheetnames:
    print(json.dumps({"ok": False, "error": "Master Sheet missing"}))
    raise SystemExit(0)
if "Posted Sheet" not in wb.sheetnames:
    wb.create_sheet("Posted Sheet")
ms = wb["Master Sheet"]
ps = wb["Posted Sheet"]
a1_before = ps.cell(1, 1).value
if a1_before is None or str(a1_before).strip() == "":
    ps.cell(1, 1, "Demand")
    a1_before = "Demand"
# Keep existing Column A header; clear data rows only.
if ps.max_row and ps.max_row > 1:
    ps.delete_rows(2, ps.max_row - 1)
ps.cell(2, 1, "ATCI-5698629-S2063571 | Posting Date: 08/13/2026 | Pune")
ps.cell(3, 1, "ATCI-9999999-S9999999 | Posting Date: 08/17/2026 | Pune")
ps.cell(4, 1, "  ATCI-5698629-S2063571\\n| Posting Date: 08/13/2026 | Pune  ")
ps.cell(5, 1, "NON-ATCI-INVALID-ROW")
ps.cell(6, 1, "ATCI-5432596-S1977432\\n\\n| Posting Date: 08/07/2026 | Bengaluru")

k_before = []
jr_set = set()
last = ms.max_row or 1
for r in range(2, last + 1):
    jr = str(ms.cell(r, 2).value or "").strip()
    if not jr:
        continue
    jr_set.add(jr)
    k_before.append({"jr": jr, "k": str(ms.cell(r, 11).value or "")})

p_roles_a1 = None
p_roles_count = None
if "P-Roles" in wb.sheetnames:
    pr = wb["P-Roles"]
    p_roles_a1 = str(pr.cell(1, 1).value or "")
    p_roles_count = pr.max_row

wb.save(path)
wb.close()
print(json.dumps({
    "ok": True,
    "postedA1": str(a1_before or ""),
    "kFingerprint": k_before,
    "masterHasCase1": "ATCI-5698629-S2063571" in jr_set,
    "masterHasCase2": "ATCI-9999999-S9999999" in jr_set,
    "pRolesA1": p_roles_a1,
    "pRolesMaxRow": p_roles_count,
}))
`,
    [filePath, existsSync(filePath) ? "0" : "1"]
  );
}

async function readResults(filePath: string) {
  return runPython(
    `
import json, sys
from openpyxl import load_workbook
path = sys.argv[1]
wb = load_workbook(path, keep_vba=True, data_only=False)
ps = wb["Posted Sheet"]
ms = wb["Master Sheet"]
headers = [str(ps.cell(1, c).value or "") for c in range(1, 4)]
rows = []
for r in range(2, (ps.max_row or 1) + 1):
    a = str(ps.cell(r, 1).value or "").strip()
    b = str(ps.cell(r, 2).value or "").strip()
    c = str(ps.cell(r, 3).value or "").strip()
    if a or b or c:
        rows.append({"a": a, "b": b, "c": c})
k_after = []
m_rows = []
for r in range(2, (ms.max_row or 1) + 1):
    jr = str(ms.cell(r, 2).value or "").strip()
    if not jr:
        continue
    k_after.append({"jr": jr, "k": str(ms.cell(r, 11).value or "")})
    m_rows.append({"jr": jr, "m": str(ms.cell(r, 13).value or "").strip(), "k": str(ms.cell(r, 11).value or "").strip()})
p_roles_a1 = None
p_roles_count = None
if "P-Roles" in wb.sheetnames:
    pr = wb["P-Roles"]
    p_roles_a1 = str(pr.cell(1, 1).value or "")
    p_roles_count = pr.max_row
has_vba = getattr(wb, "vba_archive", None) is not None
wb.close()
print(json.dumps({
    "headers": headers,
    "rows": rows,
    "kFingerprint": k_after,
    "master": m_rows,
    "pRolesA1": p_roles_a1,
    "pRolesMaxRow": p_roles_count,
    "hasVba": has_vba,
}))
`,
    [filePath]
  );
}

type InjectPayload = {
  ok?: boolean;
  error?: string;
  postedA1?: string;
  kFingerprint?: Array<{ jr: string; k: string }>;
  masterHasCase1?: boolean;
  masterHasCase2?: boolean;
  pRolesA1?: string | null;
  pRolesMaxRow?: number | null;
};

type ReadPayload = {
  headers?: string[];
  rows?: Array<{ a: string; b: string; c: string }>;
  kFingerprint?: Array<{ jr: string; k: string }>;
  master?: Array<{ jr: string; m: string; k: string }>;
  pRolesA1?: string | null;
  pRolesMaxRow?: number | null;
  hasVba?: boolean;
};

async function main() {
  const checkpointBefore = await readLateralGmailCheckpoint();

  record(
    "U1",
    "Column A cleaner keeps posting text",
    cleanPostedColumnAValue(CASE3_RAW) === CASE1_A,
    cleanPostedColumnAValue(CASE3_RAW)
  );
  record(
    "U2",
    "JR extraction is prefix only",
    extractPostedJobRequisitionId(CASE1_A) === CASE1_JR,
    extractPostedJobRequisitionId(CASE1_A)
  );

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lateral-step9-"));
  const usedReference = existsSync(REFERENCE_XLSM);
  const filePath = path.join(
    dir,
    usedReference ? "posted-abc-copy.xlsm" : "posted-abc-synthetic.xlsx"
  );
  if (usedReference) {
    await fs.copyFile(REFERENCE_XLSM, filePath);
  }

  const injected = (await injectFixtures(filePath)) as InjectPayload;
  record(
    "COPY",
    usedReference
      ? "Temporary copy of reference XLSM (not production Drive)"
      : "Synthetic workbook fallback (reference XLSM not found)",
    injected.ok === true,
    injected.ok
      ? `${filePath} A1="${injected.postedA1}" case1InMaster=${injected.masterHasCase1}`
      : injected.error || "inject failed"
  );
  if (!injected.ok) {
    throw new Error(injected.error || "Fixture inject failed");
  }

  const result = await applyPostedSheetMatchingToStagedWorkbook({
    localWorkbookPath: filePath,
  });
  record(
    "P0",
    "Posted processor succeeded",
    result.ok === true,
    result.ok
      ? `A/B/C written=${result.helperColumnsWritten} demandYes=${result.counts.demandYesCount} demandNo=${result.counts.demandNoCount} removedNonAtci=${result.counts.removedNonAtciRows}`
      : result.error
  );
  if (!result.ok) {
    throw new Error(result.error);
  }

  const after = (await readResults(filePath)) as ReadPayload;
  const headers = after.headers || [];
  const rows = after.rows || [];
  const master = after.master || [];

  record(
    "H-A",
    "Column A header preserved",
    headers[0] === injected.postedA1,
    `A1="${headers[0]}" (expected "${injected.postedA1}")`
  );
  record(
    "H-BC",
    "Posted headers B/C",
    headers[1] === "Job Requisition ID" && headers[2] === "Demand",
    headers.join(" | ")
  );

  const case1 = rows.find((r) => r.a === CASE1_A && r.b === CASE1_JR);
  const expectedC1 = injected.masterHasCase1 ? "Yes" : "No";
  record(
    "C1",
    "Case 1 — A stays posting text, B=JR, C=Master match",
    Boolean(case1 && case1.c === expectedC1 && case1.a.includes("Posting Date")),
    case1
      ? JSON.stringify(case1) + ` expectedC=${expectedC1}`
      : "row missing"
  );

  const case2 = rows.find((r) => r.b === CASE2_JR);
  record(
    "C2",
    "Case 2 — absent from Master → C=No",
    Boolean(
      case2 &&
        case2.a.startsWith(`${CASE2_JR} |`) &&
        case2.c === "No" &&
        injected.masterHasCase2 === false
    ),
    case2 ? JSON.stringify(case2) : "row missing"
  );

  const dupes = rows.filter((r) => r.b === CASE1_JR);
  record(
    "C3",
    "Case 3 — messy whitespace cleaned; duplicate JR kept",
    dupes.length === 2 &&
      dupes.every((r) => r.a === CASE1_A && r.c === expectedC1 && r.b === CASE1_JR),
    `count=${dupes.length} ${dupes.map((r) => r.a).join(" || ")}`
  );

  record(
    "C4",
    "Case 4 — non-ATCI removed",
    !rows.some((r) => r.a.includes("NON-ATCI")) &&
      result.counts.removedNonAtciRows >= 1,
    rows.map((r) => r.b).join(", ")
  );

  const extra = rows.find((r) => r.b === CASE5_JR);
  record(
    "C3b",
    "Newline posting cleaned; B is JR only",
    Boolean(
      extra &&
        extra.a.startsWith(`${CASE5_JR} |`) &&
        extra.b === CASE5_JR &&
        (extra.c === "Yes" || extra.c === "No")
    ),
    extra ? JSON.stringify(extra) : "row missing"
  );

  const mMatch = master.find((r) => r.jr === CASE1_JR);
  const mFake = master.find((r) => r.jr === CASE2_JR);
  const mUnposted = master.find((r) => r.jr === "ATCI-1001-ACTIVE");
  const case1DemandYes = rows.some((r) => r.b === CASE1_JR && r.c === "Yes");
  record(
    "M",
    "Master Column M agrees with Posted B/C",
    Boolean(
      (case1DemandYes ? mMatch?.m === "Yes" : !mMatch || mMatch.m === "-") &&
        !mFake &&
        (mUnposted ? mUnposted.m === "-" : true)
    ),
    `case1MasterM=${mMatch?.m ?? "(absent)"} unposted=${mUnposted?.m ?? "(n/a)"} postedC=${expectedC1}`
  );

  const kBefore = JSON.stringify(injected.kFingerprint);
  const kAfter = JSON.stringify(after.kFingerprint);
  record(
    "K",
    "Column K unchanged",
    kBefore === kAfter,
    kBefore === kAfter
      ? `fingerprint rows=${after.kFingerprint?.length}`
      : "Column K fingerprint changed"
  );

  record(
    "P-ROLES",
    "P-Roles sheet untouched by Posted processor",
    after.pRolesA1 === injected.pRolesA1 &&
      after.pRolesMaxRow === injected.pRolesMaxRow,
    `A1="${after.pRolesA1}" maxRow=${after.pRolesMaxRow}`
  );

  if (usedReference) {
    record(
      "VBA",
      "Copy remains macro-enabled (vba_archive present)",
      after.hasVba === true,
      `hasVba=${after.hasVba}`
    );
  }

  const checkpointAfter = await readLateralGmailCheckpoint();
  record(
    "GMAIL",
    "Gmail checkpoint unchanged",
    checkpointBefore.messageId === checkpointAfter.messageId &&
      checkpointBefore.attachmentId === checkpointAfter.attachmentId &&
      checkpointBefore.processingResult === checkpointAfter.processingResult,
    `messageId=${checkpointAfter.messageId} result=${checkpointAfter.processingResult}`
  );
  record(
    "PROD",
    "Production workbook not used",
    !filePath.toLowerCase().includes("dashboard new\\backups") &&
      filePath.startsWith(dir),
    filePath
  );

  const failed = results.filter((r) => !r.ok);
  console.log("---");
  console.log(
    failed.length === 0
      ? `All ${results.length} Step 9 checks passed.`
      : `${failed.length}/${results.length} FAILED.`
  );
  process.exit(failed.length === 0 ? 0 : 1);
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
