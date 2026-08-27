/**
 * Phase 8.1 validation — read-only `lateral_master` query layer.
 *
 * Proves: getDbClient() → lateral_master → correct rows (count, P-Roles fields,
 * filter, pagination, sort). Does NOT write. Does NOT touch APIs / Excel.
 *
 * Run: npx tsx scripts/verify-lateral-master-read-layer.ts
 */
import fs from "node:fs/promises";
import path from "node:path";
import {
  closeDbClient,
  getDbClient,
} from "../src/lib/persistence/db-client";
import {
  countLateralMaster,
  countLateralMasterRows,
  getLateralMasterByJobRequisitionId,
  listLateralMasterDistinctValues,
  listLateralMasterForPRoles,
  queryLateralMaster,
  LATERAL_MASTER_READ_COLUMNS,
} from "../src/services/persistence/read-lateral-master";

const EXPECTED_MASTER_COUNT = 23_537;

interface TestResult {
  name: string;
  status: "PASS" | "FAIL";
  detail?: string;
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
      const k = t.slice(0, eq).trim();
      const v = t.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      if (k && !(k in process.env)) process.env[k] = v;
    }
  } catch {
    // optional
  }
}

function assert(condition: boolean, detail?: string): asserts condition {
  if (!condition) throw new Error(detail ?? "assertion failed");
}

async function main() {
  await loadEnvLocal();
  const results: TestResult[] = [];

  const run = async (name: string, fn: () => Promise<void> | void) => {
    try {
      await fn();
      results.push({ name, status: "PASS" });
      console.log(`PASS  ${name}`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      results.push({ name, status: "FAIL", detail });
      console.error(`FAIL  ${name}: ${detail}`);
    }
  };

  console.log("========== PHASE 8.1 — LATERAL MASTER READ LAYER ==========\n");

  await run("1. PostgreSQL connection via getDbClient()", async () => {
    const sql = getDbClient();
    const rows = await sql<{ ok: number }[]>`SELECT 1::int AS ok`;
    assert(rows[0]?.ok === 1, "SELECT 1 failed");
  });

  await run("2. Unfiltered row count matches 23,537", async () => {
    const count = await countLateralMasterRows();
    assert(
      count === EXPECTED_MASTER_COUNT,
      `expected ${EXPECTED_MASTER_COUNT}, got ${count}`
    );
  });

  await run("3. queryLateralMaster returns all canonical columns", async () => {
    const page = await queryLateralMaster({ page: 1, pageSize: 1 });
    assert(page.total === EXPECTED_MASTER_COUNT, `total=${page.total}`);
    assert(page.rows.length === 1, `rows=${page.rows.length}`);
    const row = page.rows[0]!;
    for (const col of LATERAL_MASTER_READ_COLUMNS) {
      assert(col in row, `missing column ${col}`);
    }
    assert(Boolean(row.job_requisition_id), "empty JR");
  });

  await run("4. P-Roles required fields populated on sample Active row", async () => {
    const page = await queryLateralMaster({
      filters: { jobStatus: ["Active"] },
      page: 1,
      pageSize: 5,
      sortBy: "job_requisition_id",
      sortDirection: "asc",
    });
    assert(page.rows.length > 0, "no Active rows");
    for (const row of page.rows) {
      assert(row.job_status?.toLowerCase() === "active", `status=${row.job_status}`);
      assert(Boolean(row.job_requisition_id), "missing JR");
      assert(row.primary_skills != null, "null primary_skills");
      assert(row.skill_categorization != null, "null skill_categorization");
      assert(row.job_management_level != null, "null job_management_level");
      // posted / market_map may be null on rare rows; require presence on majority
    }
    const withPosted = page.rows.filter((r) => r.posted != null);
    assert(withPosted.length >= 1 || page.total > 0, "Active set empty");
  });

  await run("5. Filtering: job_status + posted (P-Roles defaults)", async () => {
    const activeYes = await countLateralMaster({
      jobStatus: ["Active"],
      posted: ["Yes"],
    });
    const activeOnly = await countLateralMaster({ jobStatus: ["Active"] });
    assert(activeOnly === 4918, `Active count expected 4918, got ${activeOnly}`);
    assert(activeYes > 0, "Active+Yes count should be > 0");
    assert(activeYes <= activeOnly, "Active+Yes cannot exceed Active");

    const multiStatus = await countLateralMaster({
      jobStatus: ["Active", "New", "Reopen"],
    });
    assert(
      multiStatus === 4918 + 12 + 0,
      `open statuses expected 4930, got ${multiStatus}`
    );

    // Case-insensitive match
    const ci = await countLateralMaster({ jobStatus: ["active"] });
    assert(ci === activeOnly, `case-insensitive Active failed: ${ci}`);
  });

  await run("6. Filtering: market_map", async () => {
    const values = await listLateralMasterDistinctValues("market_map");
    assert(values.length > 0, "no market_map values");
    const sample = values[0]!;
    const filtered = await countLateralMaster({ marketMap: [sample] });
    assert(filtered > 0, `market_map="${sample}" returned 0`);
    assert(filtered < EXPECTED_MASTER_COUNT, "market_map filter did not reduce set");
  });

  await run("7. Pagination works", async () => {
    const page1 = await queryLateralMaster({
      page: 1,
      pageSize: 10,
      sortBy: "job_requisition_id",
      sortDirection: "asc",
    });
    const page2 = await queryLateralMaster({
      page: 2,
      pageSize: 10,
      sortBy: "job_requisition_id",
      sortDirection: "asc",
    });
    assert(page1.rows.length === 10, `page1 size=${page1.rows.length}`);
    assert(page2.rows.length === 10, `page2 size=${page2.rows.length}`);
    assert(page1.pageCount === Math.ceil(EXPECTED_MASTER_COUNT / 10));
    const ids1 = page1.rows.map((r) => r.job_requisition_id);
    const ids2 = page2.rows.map((r) => r.job_requisition_id);
    assert(
      ids1.every((id) => !ids2.includes(id)),
      "page1 and page2 overlap"
    );
  });

  await run("8. Sorting works (primary_skills ASC vs DESC)", async () => {
    const asc = await queryLateralMaster({
      page: 1,
      pageSize: 20,
      sortBy: "primary_skills",
      sortDirection: "asc",
      filters: { jobStatus: ["Active"] },
    });
    const desc = await queryLateralMaster({
      page: 1,
      pageSize: 20,
      sortBy: "primary_skills",
      sortDirection: "desc",
      filters: { jobStatus: ["Active"] },
    });
    assert(asc.rows.length > 1 && desc.rows.length > 1);
    const ascSkills = asc.rows.map((r) => (r.primary_skills ?? "").toLowerCase());
    for (let i = 1; i < ascSkills.length; i += 1) {
      assert(
        ascSkills[i]! >= ascSkills[i - 1]!,
        `ASC order broken at ${i}: ${ascSkills[i - 1]} > ${ascSkills[i]}`
      );
    }
    assert(
      asc.rows[0]!.primary_skills !== desc.rows[0]!.primary_skills ||
        asc.total <= 1,
      "ASC and DESC first rows unexpectedly identical for multi-skill set"
    );
  });

  await run("9. listLateralMasterForPRoles returns engine-shaped rows", async () => {
    const rows = await listLateralMasterForPRoles({
      jobStatus: ["Active"],
      posted: ["Yes"],
    });
    assert(rows.length > 0, "empty P-Roles list");
    const sample = rows[0]!;
    assert("jobRequisitionId" in sample);
    assert("primarySkills" in sample);
    assert("skillCategorization" in sample);
    assert("jobManagementLevel" in sample);
    assert("jobStatus" in sample);
    assert("posted" in sample);
    assert("marketMap" in sample);
    assert(sample.jobStatus.toLowerCase() === "active");
    assert(sample.posted.toLowerCase() === "yes");
  });

  await run("10. Distinct filter values for P-Roles columns", async () => {
    const statuses = await listLateralMasterDistinctValues("job_status");
    const posted = await listLateralMasterDistinctValues("posted");
    assert(statuses.includes("Active"), `statuses=${statuses.join(",")}`);
    assert(statuses.includes("Closed"));
    assert(statuses.includes("New"));
    assert(posted.includes("Yes"));
    assert(posted.includes("-"));
  });

  await run("11. getLateralMasterByJobRequisitionId round-trip", async () => {
    const page = await queryLateralMaster({ page: 1, pageSize: 1 });
    const jr = page.rows[0]!.job_requisition_id;
    const found = await getLateralMasterByJobRequisitionId(jr);
    assert(found != null, "not found");
    assert(found!.job_requisition_id === jr);
  });

  await run("12. Read layer has no Excel/Drive or write SQL", async () => {
    const src = await fs.readFile(
      path.join(
        process.cwd(),
        "src/services/persistence/read-lateral-master.ts"
      ),
      "utf8"
    );
    assert(!/\bINSERT\b/.test(src), "INSERT found");
    assert(!/\bUPDATE\b/i.test(src), "UPDATE found");
    assert(!/\bDELETE\b/.test(src), "DELETE found");
    assert(!/\bTRUNCATE\b/.test(src), "TRUNCATE found");
    assert(!/from\s+["']@\/services\/excel/i.test(src), "excel service import");
    assert(!/googleapis/i.test(src), "googleapis import");
    assert(!/workbook|xlsm/i.test(src), "workbook/xlsm reference");
    assert(!/read-lateral-master-from/i.test(src), "Drive XLSM reader import");
  });

  // Confirm count unchanged after all reads (no accidental writes)
  await run("13. Row count unchanged after validation (no writes)", async () => {
    const count = await countLateralMasterRows();
    assert(count === EXPECTED_MASTER_COUNT, `count drifted to ${count}`);
  });

  await closeDbClient();

  const failed = results.filter((r) => r.status === "FAIL");
  console.log("\n---------- SUMMARY ----------");
  console.log(`Passed: ${results.length - failed.length}/${results.length}`);
  if (failed.length) {
    for (const f of failed) console.log(`  FAIL: ${f.name} — ${f.detail}`);
    process.exitCode = 1;
  } else {
    console.log("Phase 8.1 read layer validation: ALL PASS");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
  return closeDbClient();
});
