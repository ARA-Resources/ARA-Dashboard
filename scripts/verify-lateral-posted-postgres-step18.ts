import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";

import {
  applyPostedSheetMatchingToStagedWorkbook,
  cleanPostedColumnAValue,
  extractPostedJobRequisitionId,
} from "../src/services/lateral-processing/lateral-posted-sheet-processor";
import { getDbClient, closeDbClient } from "../src/lib/persistence/db-client";

type Result = {
  id: string;
  ok: boolean;
  detail: string;
};

const results: Result[] = [];

function record(id: string, ok: boolean, detail: string) {
  results.push({ id, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${id}`);
  console.log(`     ${detail}`);
}

async function loadEnvLocal() {
  try {
    const content = await fs.readFile(
      path.join(process.cwd(), ".env.local"),
      "utf8"
    );
    for (const line of content.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq < 1) continue;
      const key = t.slice(0, eq).trim();
      const val = t.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      if (key && !(key in process.env)) process.env[key] = val;
    }
  } catch {
    // rely on environment
  }
}

async function createWorkbook(
  filePath: string,
  realJr: string,
  otherJr: string
) {
  const wb = new ExcelJS.Workbook();

  const posted = wb.addWorksheet("Posted Sheet");
  posted.getCell("A1").value = "Posting";

  posted.getCell("A2").value =
    `${realJr} | Posting Date: 08/13/2026 | Pune`;

  posted.getCell("A3").value =
    `${otherJr} | Posting Date: 08/17/2026 | Pune`;

  posted.getCell("A4").value =
    `  ${realJr}\n| Posting Date: 08/13/2026 | Pune  `;

  posted.getCell("A5").value =
    "NON-ATCI-INVALID-ROW";

  const pRoles = wb.addWorksheet("P-Roles");
  pRoles.getCell("A1").value = "";

  const master = wb.addWorksheet("Master Sheet");
  master.getRow(1).values = [
    "Date",
    "Job Requisition ID",
    "Priority",
    "Job Description",
    "Skill Categorization",
    "Primary Skills",
    "Job Management Level",
    "Primary Location/Office locate",
    "Market Map",
    "POC",
    "Job Status",
    "Opened on Oorwin",
    "Posted",
  ];

  master.getRow(2).values = [
    "01-01-2026",
    "LOCAL-TEST-ROW",
    "P1",
    "Test",
    "Tech",
    "Java",
    "11-Analyst",
    "Pune",
    "India",
    "POC",
    "Active",
    "",
    "-",
  ];

  await wb.xlsx.writeFile(filePath);
}

async function main() {
  await loadEnvLocal();
  console.log("==============================================");
  console.log("STEP 18 — POSTGRESQL-NATIVE POSTED TEST");
  console.log("==============================================");

  const sql = getDbClient();

  /*
   * Pick a REAL JR from PostgreSQL.
   * We deliberately do not hard-code an Excel-era JR.
   */
  const seed = await sql<{
    job_requisition_id: string;
    posted: string | null;
    job_status: string | null;
  }[]>`
    SELECT
      job_requisition_id,
      posted,
      job_status
    FROM lateral_master
    WHERE job_requisition_id IS NOT NULL
      AND TRIM(job_requisition_id) <> ''
    ORDER BY job_requisition_id
    LIMIT 1
  `;

  if (seed.length !== 1) {
    throw new Error(
      "Could not find a real Job Requisition ID in PostgreSQL lateral_master."
    );
  }

  const realJr = seed[0].job_requisition_id;
  const fakeJr = "ATCI-9999999-S9999999";

  console.log(`Real PostgreSQL JR: ${realJr}`);
  console.log(`Existing Posted value: ${seed[0].posted ?? "(NULL)"}`);
  console.log(`Job Status: ${seed[0].job_status ?? "(NULL)"}`);
  console.log();

  /*
   * U1/U2 — pure utility functions.
   */
  const messy =
    `  ${realJr}\n| Posting Date: 08/13/2026 | Pune  `;

  const cleaned = cleanPostedColumnAValue(messy);
  const extracted = extractPostedJobRequisitionId(cleaned);

  record(
    "U1",
    cleaned === `${realJr} | Posting Date: 08/13/2026 | Pune`,
    cleaned
  );

  record(
    "U2",
    extracted === realJr,
    extracted
  );

  /*
   * Create a completely temporary workbook.
   */
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "lateral-step18-postgres-")
  );

  const workbookPath = path.join(
    dir,
    "posted-postgres-test.xlsx"
  );

  await createWorkbook(workbookPath, realJr, fakeJr);

  /*
   * IMPORTANT:
   * persistDatabase=false means this test reads PostgreSQL,
   * but DOES NOT modify lateral_master.
   */
  const beforeReal = await sql<{
    posted: string | null;
    updated_at: string | null;
  }[]>`
    SELECT posted, updated_at::text
    FROM lateral_master
    WHERE job_requisition_id = ${realJr}
  `;

  const beforeCount = await sql<{
    count: string;
  }[]>`
    SELECT COUNT(*)::text AS count
    FROM lateral_master
    WHERE posted = 'Yes'
  `;

  const result = await applyPostedSheetMatchingToStagedWorkbook({
    localWorkbookPath: workbookPath,
    postedSheetName: "Posted Sheet",
    persistDatabase: false,
  });

  record(
    "P0",
    result.ok === true,
    result.ok
      ? `processor succeeded; Yes=${result.counts.demandYesCount}; No=${result.counts.demandNoCount}; removed=${result.counts.removedNonAtciRows}`
      : result.error
  );

  if (!result.ok) {
    await closeDbClient();
    process.exit(1);
  }

  /*
   * Read workbook result.
   */
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(workbookPath);

  const ws = wb.getWorksheet("Posted Sheet");

  if (!ws) {
    throw new Error("Posted Sheet disappeared.");
  }

  const headers = [
    String(ws.getCell(1, 1).value ?? ""),
    String(ws.getCell(1, 2).value ?? ""),
    String(ws.getCell(1, 3).value ?? ""),
  ];

  record(
    "H",
    headers[0] === "Posting" &&
      headers[1] === "Job Requisition ID" &&
      headers[2] === "Demand",
    headers.join(" | ")
  );

  const rows: Array<{
    a: string;
    b: string;
    c: string;
  }> = [];

  for (let r = 2; r <= (ws.rowCount || 1); r++) {
    const a = String(ws.getCell(r, 1).value ?? "").trim();
    const b = String(ws.getCell(r, 2).value ?? "").trim();
    const c = String(ws.getCell(r, 3).value ?? "").trim();

    if (a || b || c) {
      rows.push({ a, b, c });
    }
  }

  const realRows = rows.filter((r) => r.b === realJr);
  const fakeRows = rows.filter((r) => r.b === fakeJr);
  const invalidRows = rows.filter((r) =>
    r.a.includes("NON-ATCI")
  );

  record(
    "C1",
    realRows.length === 2 &&
      realRows.every(
        (r) =>
          r.b === realJr &&
          r.c === "Yes" &&
          r.a.includes("Posting Date")
      ),
    JSON.stringify(realRows)
  );

  record(
    "C2",
    fakeRows.length === 1 &&
      fakeRows[0].c === "No",
    JSON.stringify(fakeRows)
  );

  record(
    "C3",
    invalidRows.length === 0,
    `remaining rows=${rows.length}`
  );

  /*
   * Verify PostgreSQL was READ but NOT modified.
   */
  const afterReal = await sql<{
    posted: string | null;
    updated_at: string | null;
  }[]>`
    SELECT posted, updated_at::text
    FROM lateral_master
    WHERE job_requisition_id = ${realJr}
  `;

  const afterCount = await sql<{
    count: string;
  }[]>`
    SELECT COUNT(*)::text AS count
    FROM lateral_master
    WHERE posted = 'Yes'
  `;

  record(
    "DB-SAFE",
    JSON.stringify(beforeReal) === JSON.stringify(afterReal) &&
      beforeCount[0].count === afterCount[0].count,
    `real JR posted=${afterReal[0]?.posted ?? "(NULL)"}; Yes count=${afterCount[0].count}`
  );

  /*
   * Verify temporary workbook only.
   */
  record(
    "TEMP",
    workbookPath.startsWith(dir),
    workbookPath
  );

  await wb.xlsx.writeFile(workbookPath);

  await closeDbClient();

  const failed = results.filter((r) => !r.ok);

  console.log();
  console.log("==============================================");

  if (failed.length === 0) {
    console.log(`STEP 18 TEST PASSED — ${results.length} checks`);
    console.log("==============================================");
    process.exit(0);
  }

  console.log(
    `STEP 18 TEST FAILED — ${failed.length}/${results.length} checks failed`
  );
  console.log("==============================================");

  process.exit(1);
}

void main().catch(async (err) => {
  console.error(err);
  await closeDbClient().catch(() => undefined);
  process.exit(1);
});
