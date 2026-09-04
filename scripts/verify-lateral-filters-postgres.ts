/**
 * Phase 8.3 validation — Lateral Dashboard filters from PostgreSQL.
 *
 * Proves `/api/excel/lateral/filters` path (via getDynamicFilterSchema)
 * is PostgreSQL-backed, preserves DynamicFilterSchema contract, returns
 * Job Status / Posted / Market Map for P-Roles, performs no writes, and
 * has no Excel/Drive dependency on the Lateral branch.
 *
 * Also documents which other Lateral Dashboard endpoints remain Excel-backed
 * (Master Sheet, Allocations) by design.
 *
 * Run: npx tsx scripts/verify-lateral-filters-postgres.ts
 */
import fs from "node:fs/promises";
import path from "node:path";
import {
  closeDbClient,
  getDbClient,
} from "../src/lib/persistence/db-client";
import { countLateralMasterRows } from "../src/services/persistence/read-lateral-master";
import { getDynamicFilterSchema } from "../src/services/excel/filter-schema";
import { getLateralDashboardFilterSchemaFromPostgres } from "../src/services/persistence/lateral-dashboard-filter-schema";
import { resolveDefaultsFromSchema } from "../src/constants/default-filters";
import { extractPRolesFilters } from "../src/services/lateral-processing/lateral-p-roles-service";

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

  console.log("========== PHASE 8.3 — LATERAL FILTERS → POSTGRESQL ==========\n");

  const masterBefore = await countLateralMasterRows();
  let schema = await getDynamicFilterSchema("lateral");

  await run("1. getDynamicFilterSchema(lateral) uses PostgreSQL sourceFile", async () => {
    assert(schema.sourceFile === "lateral_master", schema.sourceFile);
    assert(schema.businessUnitId === "lateral");
    assert(schema.sheetName === "Master Sheet", schema.sheetName);
  });

  await run("2. DynamicFilterSchema contract (fields shape)", async () => {
    assert(Array.isArray(schema.fields) && schema.fields.length > 0);
    for (const field of schema.fields) {
      assert(typeof field.column === "string" && field.column.length > 0);
      assert(Array.isArray(field.values));
      assert(field.valueCount === field.values.length);
      assert(field.kind === "categorical" || field.kind === "numeric");
    }
  });

  await run("3. Required P-Roles filter columns present with Excel labels", async () => {
    const byName = new Map(schema.fields.map((f) => [f.column, f]));
    for (const required of ["Job Status", "Posted", "Market Map"]) {
      assert(byName.has(required), `missing filter column: ${required}`);
    }
    const status = byName.get("Job Status")!;
    assert(status.values.some((v) => v.toLowerCase() === "active"));
    assert(status.values.some((v) => v.toLowerCase() === "closed"));
    assert(status.values.some((v) => v.toLowerCase() === "new"));
    // Preferred order: Active, Reopen, New before Closed
    assert(
      status.values[0]?.toLowerCase() === "active",
      `Job Status order starts with ${status.values[0]}`
    );
    const posted = byName.get("Posted")!;
    assert(posted.values.some((v) => v.toLowerCase() === "yes"));
    assert(posted.values[0]?.toLowerCase() === "yes", "Posted preferred Yes first");
  });

  await run("4. No Excel-only columns (Team*, Opened on Oorwin)", async () => {
    for (const field of schema.fields) {
      assert(!/team\s*member|team\s*lead|opened\s*on\s*oorwin/i.test(field.column), field.column);
    }
  });

  await run("5. resolveDefaultsFromSchema + extractPRolesFilters still work", async () => {
    const defaults = resolveDefaultsFromSchema("lateral", schema);
    assert(
      (defaults.columnFilters["Job Status"]?.length ?? 0) > 0,
      "default Job Status empty"
    );
    assert(
      defaults.columnFilters["Posted"]?.includes("Yes") ||
        defaults.columnFilters["Posted"]?.some((v) => v.toLowerCase() === "yes"),
      "default Posted missing Yes"
    );
    const pRoles = extractPRolesFilters(defaults);
    assert((pRoles.jobStatus?.length ?? 0) > 0);
    assert((pRoles.posted?.length ?? 0) > 0);
  });

  await run("6. Direct PG builder matches getDynamicFilterSchema(lateral)", async () => {
    const direct = await getLateralDashboardFilterSchemaFromPostgres();
    assert(direct.sourceFile === schema.sourceFile);
    assert(direct.fields.length === schema.fields.length);
    assert(
      direct.fields.map((f) => f.column).join("|") ===
        schema.fields.map((f) => f.column).join("|")
    );
  });

  await run("7. Distinct values match live SQL for Job Status", async () => {
    const sql = getDbClient();
    const rows = await sql<{ value: string }[]>`
      SELECT DISTINCT job_status AS value FROM lateral_master
      WHERE job_status IS NOT NULL AND btrim(job_status) <> ''
      ORDER BY value ASC
    `;
    const sqlSet = new Set(rows.map((r) => r.value.toLowerCase()));
    const field = schema.fields.find((f) => f.column === "Job Status")!;
    for (const v of field.values) {
      assert(sqlSet.has(v.toLowerCase()) || ["active", "reopen", "new", "closed"].includes(v.toLowerCase()),
        `schema value not in SQL: ${v}`);
    }
    for (const v of rows) {
      assert(
        field.values.some((x) => x.toLowerCase() === v.value.toLowerCase()),
        `SQL value missing from schema: ${v.value}`
      );
    }
  });

  await run("8. filter-schema Lateral branch returns PG before Excel read", async () => {
    const src = await fs.readFile(
      path.join(process.cwd(), "src/services/excel/filter-schema.ts"),
      "utf8"
    );
    assert(src.includes("getLateralDashboardFilterSchemaFromPostgres"));
    assert(
      /if\s*\(\s*businessUnitId\s*===\s*"lateral"\s*\)\s*\{[\s\S]*?return getLateralDashboardFilterSchemaFromPostgres\(\)/.test(
        src
      ),
      "lateral early-return to PostgreSQL missing"
    );
    // Excel reader remains for executive/consulting only (after lateral return)
    assert(src.includes("readFilterSourceSheet"));
  });

  await run("9. PG filter schema module has no Excel/Drive imports", async () => {
    const src = await fs.readFile(
      path.join(
        process.cwd(),
        "src/services/persistence/lateral-dashboard-filter-schema.ts"
      ),
      "utf8"
    );
    assert(!/readFilterSourceSheet|read-lateral-master-from-drive|googleapis|workbook|xlsm/i.test(src));
    assert(!/\bINSERT\b|\bUPDATE\b|\bDELETE\b|\bTRUNCATE\b/.test(src));
  });

  await run("10. No database writes", async () => {
    schema = await getDynamicFilterSchema("lateral");
    const after = await countLateralMasterRows();
    assert(
      after === masterBefore && after === EXPECTED_MASTER_COUNT,
      `count drifted ${masterBefore} → ${after}`
    );
  });

  await run("11. Scope check: only Lateral Dashboard filter path migrated", async () => {
    // Document intentional non-migrations (static presence of Excel paths)
    const masterRoute = await fs.readFile(
      path.join(
        process.cwd(),
        "src/app/api/excel/lateral-master-sheet/route.ts"
      ),
      "utf8"
    );
    assert(
      masterRoute.includes("queryLateralMasterSheet") ||
        masterRoute.includes("read-lateral-master-sheet"),
      "Master Sheet API route should still call queryLateralMasterSheet"
    );
    const clustersRoute = await fs.readFile(
      path.join(
        process.cwd(),
        "src/app/api/excel/[businessUnitId]/skill-clusters/route.ts"
      ),
      "utf8"
    );
    assert(
      clustersRoute.includes("extractSkillClusters"),
      "Skill Clusters should remain Excel-backed"
    );
    const pRolesRoute = await fs.readFile(
      path.join(
        process.cwd(),
        "src/app/api/dataset/lateral/p-roles/route.ts"
      ),
      "utf8"
    );
    assert(
      pRolesRoute.includes('source: "postgres"'),
      "P-Roles (8.2) should remain postgres"
    );
  });

  console.log("\n------- Migrated Lateral Dashboard read paths -------");
  console.log("  ✓ GET /api/excel/lateral/filters     → PostgreSQL (8.3)");
  console.log("  ✓ GET /api/dataset/lateral/p-roles   → PostgreSQL (8.2)");
  console.log("------- Intentionally still Excel/Drive -------");
  console.log("  · GET /api/excel/lateral-master-sheet (+ export)");
  console.log("  · GET /api/excel/lateral/skill-clusters (Allocations)");
  console.log("  · GET /api/excel/lateral/opening-skills (unused UI)");
  console.log("  · GET /api/home/widgets (Phase 8.4)");

  await closeDbClient();

  const failed = results.filter((r) => r.status === "FAIL");
  console.log("\n---------- SUMMARY ----------");
  console.log(`Passed: ${results.length - failed.length}/${results.length}`);
  if (failed.length) {
    for (const f of failed) console.log(`  FAIL: ${f.name} — ${f.detail}`);
    process.exitCode = 1;
  } else {
    console.log("Phase 8.3 Lateral filters → PostgreSQL validation: ALL PASS");
  }
}

main().catch(async (error) => {
  console.error(error);
  process.exitCode = 1;
  await closeDbClient();
});
