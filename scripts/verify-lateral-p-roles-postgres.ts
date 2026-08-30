/**
 * Phase 8.2 validation — P-Roles API path uses PostgreSQL `lateral_master`.
 *
 * Proves:
 *  - buildLateralPRolesOpenings (default) is PostgreSQL-backed
 *  - Response contract matches frontend ExcelOpeningsResult shape
 *  - Filters / sort / top-N still work
 *  - No DB writes
 *  - Static: API route + default service path have no Drive/XLSM dependency
 *  - Optional parity compare vs Drive/XLSM (same filters)
 *
 * Run: npx tsx scripts/verify-lateral-p-roles-postgres.ts
 */
import fs from "node:fs/promises";
import path from "node:path";
import {
  closeDbClient,
  getDbClient,
} from "../src/lib/persistence/db-client";
import { countLateralMasterRows } from "../src/services/persistence/read-lateral-master";
import { buildLateralPRolesOpenings } from "../src/services/lateral-processing/lateral-p-roles-service";
import type { ExcelDataRow, ExcelOpeningsResult } from "../src/types/excel";
import type { OpeningsFilters } from "../src/types/filters";

const EXPECTED_MASTER_COUNT = 23_537;

interface TestResult {
  name: string;
  status: "PASS" | "FAIL" | "SKIP";
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

function defaultDashboardFilters(): OpeningsFilters {
  return {
    columnFilters: {
      "Job Status": ["Active", "Reopen", "New"],
      Posted: ["Yes"],
    },
    sortBy: "Grand Total",
    sortDirection: "desc",
    topN: 10,
  };
}

function rowKey(row: ExcelDataRow): string {
  return `${String(row["Primary Skills"] ?? "")}\u0000${String(
    row["Skill Categorization"] ?? ""
  )}`;
}

function summarizeResult(result: ExcelOpeningsResult) {
  return {
    sourceFile: result.sourceFile,
    sourceLabel: result.sourceLabel,
    headers: result.headers,
    rowCount: result.rows.length,
    totalRows: result.meta.totalRows,
    filteredDetailCount: result.meta.filteredDetailCount,
    topN: result.meta.topN,
    hasColumnFilters: result.meta.hasColumnFilters,
    firstKeys: result.rows.slice(0, 5).map(rowKey),
    grandTotals: result.rows.slice(0, 5).map((r) => Number(r["Grand Total"] ?? 0)),
  };
}

function compareResults(
  pg: ExcelOpeningsResult,
  drive: ExcelOpeningsResult
): {
  equal: boolean;
  differences: string[];
} {
  const differences: string[] = [];

  if (pg.headers.join("|") !== drive.headers.join("|")) {
    differences.push(
      `headers differ\n  PG: ${pg.headers.join(" | ")}\n  Drive: ${drive.headers.join(" | ")}`
    );
  }

  if (pg.meta.filteredDetailCount !== drive.meta.filteredDetailCount) {
    differences.push(
      `filteredDetailCount PG=${pg.meta.filteredDetailCount} Drive=${drive.meta.filteredDetailCount}`
    );
  }

  if ((pg.meta.totalRows ?? 0) !== (drive.meta.totalRows ?? 0)) {
    differences.push(
      `totalRows (pre-topN) PG=${pg.meta.totalRows} Drive=${drive.meta.totalRows}`
    );
  }

  // Compare full aggregated tables before worrying about top-N slice identity
  const pgAll = new Map(
    // Rebuild without topN for fair set compare if both used topN —
    // here we compare the returned rows (with topN applied) as the API does.
    pg.rows.map((r) => [rowKey(r), r] as const)
  );
  const driveAll = new Map(drive.rows.map((r) => [rowKey(r), r] as const));

  if (pg.rows.length !== drive.rows.length) {
    differences.push(
      `returned row count PG=${pg.rows.length} Drive=${drive.rows.length}`
    );
  }

  for (const [key, pgRow] of pgAll) {
    const driveRow = driveAll.get(key);
    if (!driveRow) {
      differences.push(`PG row missing on Drive: ${key.replace("\u0000", " / ")}`);
      continue;
    }
    const gtPg = Number(pgRow["Grand Total"] ?? 0);
    const gtDrive = Number(driveRow["Grand Total"] ?? 0);
    if (gtPg !== gtDrive) {
      differences.push(
        `Grand Total mismatch for ${key.replace("\u0000", " / ")}: PG=${gtPg} Drive=${gtDrive}`
      );
    }
    for (const header of pg.headers) {
      if (
        header === "Primary Skills" ||
        header === "Skill Categorization" ||
        header === "id"
      ) {
        continue;
      }
      const a = Number(pgRow[header] ?? 0);
      const b = Number(driveRow[header] ?? 0);
      if (a !== b) {
        differences.push(
          `${header} mismatch for ${key.replace("\u0000", " / ")}: PG=${a} Drive=${b}`
        );
      }
    }
  }

  for (const key of driveAll.keys()) {
    if (!pgAll.has(key)) {
      differences.push(`Drive row missing on PG: ${key.replace("\u0000", " / ")}`);
    }
  }

  return { equal: differences.length === 0, differences };
}

async function main() {
  await loadEnvLocal();
  const results: TestResult[] = [];

  const run = async (
    name: string,
    fn: () => Promise<void> | void
  ) => {
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

  const skip = (name: string, detail: string) => {
    results.push({ name, status: "SKIP", detail });
    console.log(`SKIP  ${name}: ${detail}`);
  };

  console.log("========== PHASE 8.2 — P-ROLES → POSTGRESQL ==========\n");

  let pgDefault: ExcelOpeningsResult | null = null;
  let pgDashboard: ExcelOpeningsResult | null = null;
  const masterBefore = await countLateralMasterRows();

  await run("1. Default buildLateralPRolesOpenings uses PostgreSQL", async () => {
    pgDefault = await buildLateralPRolesOpenings();
    assert(pgDefault.sourceFile === "lateral_master", pgDefault.sourceFile);
    assert(
      pgDefault.meta.filePath === "postgres:lateral_master",
      String(pgDefault.meta.filePath)
    );
    assert(
      /postgresql lateral_master/i.test(pgDefault.sourceLabel),
      pgDefault.sourceLabel
    );
  });

  await run("2. Response contract (ExcelOpeningsResult shape)", async () => {
    const r = pgDefault!;
    assert(r.businessUnitId === "lateral");
    assert(r.sheetName === "P-Roles");
    assert(Array.isArray(r.headers) && r.headers.length >= 3);
    assert(r.headers[0] === "Primary Skills");
    assert(r.headers[1] === "Skill Categorization");
    assert(r.headers.includes("Grand Total"));
    assert(Array.isArray(r.rows));
    assert(typeof r.meta.rowCount === "number");
    assert(typeof r.meta.columnCount === "number");
    assert(typeof r.meta.filteredDetailCount === "number");
    assert(r.meta.name === "P-Roles");
    for (const row of r.rows.slice(0, 20)) {
      assert(typeof row.id === "string" && row.id.length > 0, "missing row id");
      assert("Primary Skills" in row);
      assert("Grand Total" in row);
    }
  });

  await run("3. Dashboard default filters + sort + topN", async () => {
    const filters = defaultDashboardFilters();
    pgDashboard = await buildLateralPRolesOpenings(filters, {
      source: "postgres",
    });
    assert(pgDashboard.rows.length <= 10, `topN broken: ${pgDashboard.rows.length}`);
    assert(pgDashboard.meta.topN === 10);
    assert(pgDashboard.meta.hasColumnFilters === true);
    assert(
      (pgDashboard.meta.filteredDetailCount ?? 0) > 0,
      "filteredDetailCount should be > 0 for Active/Reopen/New + Posted Yes"
    );
    // Grand Total sorted desc
    const totals = pgDashboard.rows.map((r) => Number(r["Grand Total"] ?? 0));
    for (let i = 1; i < totals.length; i += 1) {
      assert(
        totals[i]! <= totals[i - 1]!,
        `sort desc broken at ${i}: ${totals[i - 1]} < ${totals[i]}`
      );
    }
    console.log(
      `       dashboard: ${pgDashboard.rows.length} rows, detailJobs=${pgDashboard.meta.filteredDetailCount}, headers=${pgDashboard.headers.length}`
    );
  });

  await run("4. Unfiltered PG P-Roles produces aggregated rows", async () => {
    const r = pgDefault!;
    assert(r.rows.length > 0, "empty aggregation");
    assert(
      (r.meta.filteredDetailCount ?? 0) === EXPECTED_MASTER_COUNT ||
        (r.meta.filteredDetailCount ?? 0) > 20_000,
      `unexpected detail count ${r.meta.filteredDetailCount}`
    );
    // COUNT of JRs with non-empty id — empty JR skipped by engine
    assert(
      (r.meta.filteredDetailCount ?? 0) <= EXPECTED_MASTER_COUNT,
      "detail count cannot exceed master rows"
    );
  });

  await run("5. API route is explicitly postgres-sourced (static)", async () => {
    const route = await fs.readFile(
      path.join(
        process.cwd(),
        "src/app/api/dataset/lateral/p-roles/route.ts"
      ),
      "utf8"
    );
    assert(route.includes('source: "postgres"'), "route missing source postgres");
    assert(
      !route.includes("read-lateral-master-from-drive"),
      "route still imports Drive reader"
    );
    assert(
      !route.includes("drive-xlsm"),
      "route should not select drive-xlsm"
    );
  });

  await run("6. Service default path has no static Drive/XLSM import", async () => {
    const src = await fs.readFile(
      path.join(
        process.cwd(),
        "src/services/lateral-processing/lateral-p-roles-service.ts"
      ),
      "utf8"
    );
    assert(
      src.includes("listLateralMasterForPRoles"),
      "missing Phase 8.1 read layer"
    );
    // Static import of Drive reader must not exist (dynamic only for parity)
    assert(
      !/^import .*read-lateral-master-from-drive/m.test(src),
      "static Drive import found"
    );
    assert(
      src.includes('source ?? "postgres"') ||
        src.includes('options?.source ?? "postgres"'),
      "default source is not postgres"
    );
  });

  await run("7. No database writes during P-Roles build", async () => {
    const after = await countLateralMasterRows();
    assert(
      after === masterBefore && after === EXPECTED_MASTER_COUNT,
      `count drifted before=${masterBefore} after=${after}`
    );
    // Touch DB with a trivial read to ensure client still works
    const sql = getDbClient();
    await sql`SELECT 1`;
  });

  await run("8. Engine filteredDetailCount matches SQL for dashboard filters", async () => {
    const sql = getDbClient();
    const statuses = ["active", "reopen", "new"];
    const rows = await sql<{ c: string }[]>`
      SELECT COUNT(*)::text AS c FROM lateral_master
      WHERE LOWER(COALESCE(job_status, '')) = ANY(${statuses})
        AND LOWER(COALESCE(posted, '')) = ${"yes"}
        AND btrim(COALESCE(job_requisition_id, '')) <> ''
    `;
    const expected = Number(rows[0]?.c ?? 0);
    const actual = pgDashboard!.meta.filteredDetailCount ?? -1;
    assert(
      actual === expected,
      `SQL count=${expected} engine filteredDetailCount=${actual}`
    );
    console.log(`       SQL Active/Reopen/New + Posted Yes = ${expected}`);
  });

  await run("9. Deterministic PG rebuild (same filters → identical aggregation)", async () => {
    const filters = defaultDashboardFilters();
    const again = await buildLateralPRolesOpenings(filters, {
      source: "postgres",
    });
    const { equal, differences } = compareResults(pgDashboard!, again);
    assert(equal, differences.slice(0, 10).join("; "));
  });

  // Best-effort Drive/XLSM parity — SKIP if OAuth/workbook unavailable (do not fail 8.2).
  {
    const filters = defaultDashboardFilters();
    let driveDashboard: ExcelOpeningsResult | null = null;
    try {
      driveDashboard = await buildLateralPRolesOpenings(filters, {
        source: "drive-xlsm",
        forceVercelSafeNative: true,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      skip(
        "10. Parity compare PG vs Drive (dashboard defaults, topN=10)",
        `Drive/XLSM unavailable: ${msg.slice(0, 240)}`
      );
      skip(
        "11. Parity compare PG vs Drive (no column filters, topN=null)",
        "Skipped because Drive/XLSM source is unavailable in this environment."
      );
    }

    if (driveDashboard) {
      await run("10. Parity compare PG vs Drive (dashboard defaults, topN=10)", async () => {
        const pg = pgDashboard!;
        console.log("\n       --- PG summary ---");
        console.log("      ", JSON.stringify(summarizeResult(pg)));
        console.log("       --- Drive summary ---");
        console.log("      ", JSON.stringify(summarizeResult(driveDashboard!)));
        const { equal, differences } = compareResults(pg, driveDashboard!);
        if (!equal) {
          const preview = differences.slice(0, 25).join("\n  - ");
          throw new Error(
            `${differences.length} difference(s):\n  - ${preview}`
          );
        }
      });

      await run("11. Parity compare PG vs Drive (no column filters, topN=null)", async () => {
        const openFilters: OpeningsFilters = {
          columnFilters: {},
          sortBy: "Grand Total",
          sortDirection: "desc",
          topN: null,
        };
        const [pg, driveAll] = await Promise.all([
          buildLateralPRolesOpenings(openFilters, { source: "postgres" }),
          buildLateralPRolesOpenings(openFilters, { source: "drive-xlsm" }),
        ]);
        console.log(
          `       unfiltered: PG rows=${pg.rows.length} detail=${pg.meta.filteredDetailCount}; Drive rows=${driveAll.rows.length} detail=${driveAll.meta.filteredDetailCount}`
        );
        const { equal, differences } = compareResults(pg, driveAll);
        if (!equal) {
          const preview = differences.slice(0, 40).join("\n  - ");
          throw new Error(
            `${differences.length} difference(s):\n  - ${preview}`
          );
        }
      });
    }
  }

  await closeDbClient();

  const failed = results.filter((r) => r.status === "FAIL");
  const skipped = results.filter((r) => r.status === "SKIP");
  console.log("\n---------- SUMMARY ----------");
  console.log(
    `Passed: ${results.filter((r) => r.status === "PASS").length}/${results.length}`
  );
  if (skipped.length) {
    for (const s of skipped) console.log(`  SKIP: ${s.name} — ${s.detail}`);
  }
  if (failed.length) {
    for (const f of failed) console.log(`  FAIL: ${f.name} — ${f.detail}`);
    process.exitCode = 1;
  } else {
    console.log("Phase 8.2 P-Roles → PostgreSQL validation: ALL PASS");
  }
}

main().catch(async (error) => {
  console.error(error);
  process.exitCode = 1;
  await closeDbClient();
});
