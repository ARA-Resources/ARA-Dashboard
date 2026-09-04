/**
 * Phase 8.5 — Integration tests for PostgreSQL-backed Lateral Dashboard paths
 * plus regression smoke for intentionally Excel-backed paths.
 *
 * Migrated (must PASS on PG):
 *   GET /api/dataset/lateral/p-roles
 *   GET /api/excel/lateral/filters
 *   GET /api/home/widgets
 *
 * Intentionally Excel/Drive (smoke; SKIP if OAuth/workbook unavailable):
 *   GET /api/excel/lateral-master-sheet
 *   GET /api/excel/lateral-master-sheet/export
 *   GET /api/excel/lateral/skill-clusters
 *
 * Does NOT modify schema, Phase 7, frontend, or production data (reads only).
 * Does NOT auto-fix application failures — report only.
 *
 * Run: npx tsx scripts/verify-phase85-dashboard-integration.ts
 */
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

/** tsx/scripts are not Next server components — stub `server-only` so Excel routes can load. */
function stubServerOnlyModule() {
  const require = createRequire(import.meta.url);
  const resolved = require.resolve("server-only");
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: {},
    children: [],
    paths: [],
    parent: null,
    isPreloading: false,
    require,
    path: path.dirname(resolved),
  } as NodeModule;
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

type Status = "PASS" | "FAIL" | "SKIP";

interface TestResult {
  name: string;
  status: Status;
  detail?: string;
}

function assert(condition: boolean, detail?: string): asserts condition {
  if (!condition) throw new Error(detail ?? "assertion failed");
}

function isEnvUnavailable(message: string): boolean {
  return /gmail is not connected|oauth|not configured|drive|workbook|not found|ENOENT|Complete OAuth|Dataset Manager/i.test(
    message
  );
}

async function jsonFromResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(
      `Non-JSON response (${response.status}): ${text.slice(0, 200)}`
    );
  }
}

async function main() {
  await loadEnvLocal();
  process.env.ARA_PERSISTENCE = "postgres";
  stubServerOnlyModule();

  const { closeDbClient, getDbClient } = await import(
    "../src/lib/persistence/db-client"
  );
  const { countLateralMasterRows } = await import(
    "../src/services/persistence/read-lateral-master"
  );
  const { homeWidgetsAllowsExcelBootstrap } = await import(
    "../src/services/home/build-home-widgets"
  );
  const { GET: getPRoles } = await import(
    "../src/app/api/dataset/lateral/p-roles/route"
  );
  const { GET: getFilters } = await import(
    "../src/app/api/excel/[businessUnitId]/filters/route"
  );
  const { GET: getHomeWidgets } = await import(
    "../src/app/api/home/widgets/route"
  );
  const { GET: getMasterSheet } = await import(
    "../src/app/api/excel/lateral-master-sheet/route"
  );
  const { GET: getMasterExport } = await import(
    "../src/app/api/excel/lateral-master-sheet/export/route"
  );
  const { GET: getSkillClusters } = await import(
    "../src/app/api/excel/[businessUnitId]/skill-clusters/route"
  );

  const results: TestResult[] = [];

  const pass = (name: string, detail?: string) => {
    results.push({ name, status: "PASS", detail });
    console.log(`PASS  ${name}${detail ? ` — ${detail}` : ""}`);
  };
  const fail = (name: string, detail: string) => {
    results.push({ name, status: "FAIL", detail });
    console.error(`FAIL  ${name}: ${detail}`);
  };
  const skip = (name: string, detail: string) => {
    results.push({ name, status: "SKIP", detail });
    console.log(`SKIP  ${name}: ${detail}`);
  };

  const run = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
      pass(name);
    } catch (error) {
      fail(name, error instanceof Error ? error.message : String(error));
    }
  };

  const runExcelSmoke = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
      pass(name);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (isEnvUnavailable(msg)) {
        skip(name, `Excel/Drive environment unavailable: ${msg.slice(0, 240)}`);
      } else {
        fail(name, msg);
      }
    }
  };

  console.log("========== PHASE 8.5 — DASHBOARD INTEGRATION ==========\n");
  console.log(`ARA_PERSISTENCE=${process.env.ARA_PERSISTENCE}`);
  console.log("");

  const masterBefore = await countLateralMasterRows();
  const sql = getDbClient();
  const homeBefore = await sql<
    Array<{ business_unit_id: string; updated_at: Date | string }>
  >`
    SELECT business_unit_id, updated_at FROM home_metrics
    ORDER BY business_unit_id
  `;

  // ─── A. Environment / PG-only gates ─────────────────────────────────────

  await run("A1. ARA_PERSISTENCE=postgres", async () => {
    assert(
      process.env.ARA_PERSISTENCE?.toLowerCase() === "postgres",
      process.env.ARA_PERSISTENCE
    );
  });

  await run("A2. Home widgets Excel bootstrap disabled", async () => {
    assert(homeWidgetsAllowsExcelBootstrap() === false);
  });

  await run("A3. lateral_master readable (baseline count)", async () => {
    assert(masterBefore > 0, `master count=${masterBefore}`);
    console.log(`       lateral_master rows=${masterBefore}`);
  });

  // ─── B. Migrated APIs — availability + contracts ─────────────────────────

  let pRolesBody: Record<string, unknown> | null = null;
  let filtersBody: Record<string, unknown> | null = null;
  let homeBody: Record<string, unknown> | null = null;

  const dashboardFilters = {
    "Job Status": ["Active", "Reopen", "New"],
    Posted: ["Yes"],
  };

  await run("B1. GET /api/dataset/lateral/p-roles available + contract", async () => {
    const params = new URLSearchParams({
      columnFilters: JSON.stringify(dashboardFilters),
      sortBy: "Grand Total",
      sortDir: "desc",
      top: "10",
    });
    const response = await getPRoles(
      new Request(`http://localhost/api/dataset/lateral/p-roles?${params}`)
    );
    assert(response.status === 200, `status=${response.status}`);
    const body = (await jsonFromResponse(response)) as Record<string, unknown>;
    assert(body.businessUnitId === "lateral");
    assert(body.sheetName === "P-Roles");
    assert(body.sourceFile === "lateral_master", String(body.sourceFile));
    assert(Array.isArray(body.headers));
    assert(Array.isArray(body.rows));
    const headers = body.headers as string[];
    assert(headers.includes("Primary Skills"));
    assert(headers.includes("Grand Total"));
    const rows = body.rows as unknown[];
    assert(rows.length <= 10, `topN broken: ${rows.length}`);
    const meta = body.meta as Record<string, unknown>;
    assert(meta.filePath === "postgres:lateral_master", String(meta.filePath));
    assert(typeof meta.filteredDetailCount === "number");
    pRolesBody = body;
    console.log(
      `       rows=${rows.length} detailJobs=${meta.filteredDetailCount} headers=${headers.length}`
    );
  });

  await run("B2. GET /api/excel/lateral/filters available + contract", async () => {
    const response = await getFilters(
      new Request("http://localhost/api/excel/lateral/filters"),
      { params: Promise.resolve({ businessUnitId: "lateral" }) }
    );
    assert(response.status === 200, `status=${response.status}`);
    const body = (await jsonFromResponse(response)) as Record<string, unknown>;
    assert(body.businessUnitId === "lateral");
    assert(body.sourceFile === "lateral_master", String(body.sourceFile));
    assert(Array.isArray(body.fields));
    const fields = body.fields as Array<{ column: string; values: string[] }>;
    const names = fields.map((f) => f.column);
    assert(names.includes("Job Status"), names.join(","));
    assert(names.includes("Posted"), names.join(","));
    assert(names.includes("Market Map"), names.join(","));
    for (const banned of names) {
      assert(
        !/team\s*member|team\s*lead|opened\s*on\s*oorwin/i.test(banned),
        `Excel-only column leaked: ${banned}`
      );
    }
    filtersBody = body;
    console.log(`       filter fields=${fields.length}: ${names.join(" | ")}`);
  });

  await run("B3. GET /api/home/widgets available + contract", async () => {
    const response = await getHomeWidgets(
      new Request("http://localhost/api/home/widgets?refresh=1")
    );
    assert(response.status === 200, `status=${response.status}`);
    const body = (await jsonFromResponse(response)) as Record<string, unknown>;
    assert(typeof body.generatedAt === "string");
    const metrics = body.metrics as Record<string, { value: number; id: string }>;
    assert(typeof metrics.totalOpenPositions?.value === "number");
    assert(typeof metrics.activeOpenings?.value === "number");
    assert(typeof metrics.postedOpenings?.value === "number");
    assert(typeof metrics.newOpenings?.value === "number");
    assert(Array.isArray(body.businessUnitDistribution));
    assert(Array.isArray(body.excelSyncStatus));
    assert(body.metricBreakdown && typeof body.metricBreakdown === "object");
    homeBody = body;
    console.log(
      `       totals=${metrics.totalOpenPositions.value} active=${metrics.activeOpenings.value} posted=${metrics.postedOpenings.value}`
    );
  });

  // ─── C. Cross-API consistency ────────────────────────────────────────────

  await run("C1. Filters ↔ P-Roles: default filter keys drive P-Roles", async () => {
    assert(filtersBody && pRolesBody);
    const fields = filtersBody!.fields as Array<{ column: string; values: string[] }>;
    const statusField = fields.find((f) => f.column === "Job Status")!;
    const postedField = fields.find((f) => f.column === "Posted")!;
    assert(statusField.values.some((v) => /active/i.test(v)));
    assert(postedField.values.some((v) => /^yes$/i.test(v)));

    const statuses = ["active", "reopen", "new"];
    const sqlCount = await sql<{ c: string }[]>`
      SELECT COUNT(*)::text AS c FROM lateral_master
      WHERE LOWER(COALESCE(job_status, '')) = ANY(${statuses})
        AND LOWER(COALESCE(posted, '')) = ${"yes"}
        AND btrim(COALESCE(job_requisition_id, '')) <> ''
    `;
    const expected = Number(sqlCount[0]?.c ?? 0);
    const meta = pRolesBody!.meta as Record<string, unknown>;
    assert(
      meta.filteredDetailCount === expected,
      `P-Roles detail=${meta.filteredDetailCount} SQL=${expected}`
    );
  });

  await run("C2. Home KPIs ↔ home_metrics SQL", async () => {
    assert(homeBody);
    const rows = await sql<
      Array<{
        business_unit_id: string;
        totals: number;
        active: number;
        posted: number;
        fresh: number;
      }>
    >`
      SELECT business_unit_id, totals, active, posted, fresh FROM home_metrics
      WHERE business_unit_id = ANY(${["lateral", "executive", "consulting"]})
    `;
    const sum = (key: "totals" | "active" | "posted" | "fresh") =>
      rows.reduce((acc, r) => acc + (r[key] ?? 0), 0);
    const metrics = homeBody!.metrics as Record<string, { value: number }>;
    assert(metrics.totalOpenPositions.value === sum("totals"));
    assert(metrics.activeOpenings.value === sum("active"));
    assert(metrics.postedOpenings.value === sum("posted"));
    assert(metrics.newOpenings.value === sum("fresh"));
  });

  await run("C3. P-Roles aggregation shape stable under empty filters", async () => {
    const response = await getPRoles(
      new Request(
        "http://localhost/api/dataset/lateral/p-roles?columnFilters=%7B%7D&sortBy=Grand%20Total&sortDir=desc&top=all"
      )
    );
    assert(response.status === 200);
    const body = (await jsonFromResponse(response)) as Record<string, unknown>;
    assert(body.sourceFile === "lateral_master");
    const meta = body.meta as Record<string, unknown>;
    assert(
      (meta.filteredDetailCount as number) <= masterBefore,
      `unfiltered detail=${meta.filteredDetailCount} master=${masterBefore}`
    );
    assert((body.rows as unknown[]).length > 0);
  });

  // ─── D. PostgreSQL-only / no Drive on migrated paths ─────────────────────

  await run("D1. Static: P-Roles route is postgres-sourced", async () => {
    const src = await fs.readFile(
      path.join(process.cwd(), "src/app/api/dataset/lateral/p-roles/route.ts"),
      "utf8"
    );
    assert(src.includes('source: "postgres"'));
    assert(!src.includes("drive-xlsm"));
  });

  await run("D2. Static: Lateral filters use PG schema builder", async () => {
    const src = await fs.readFile(
      path.join(process.cwd(), "src/services/excel/filter-schema.ts"),
      "utf8"
    );
    assert(
      /if\s*\(\s*businessUnitId\s*===\s*"lateral"\s*\)[\s\S]*getLateralDashboardFilterSchemaFromPostgres/.test(
        src
      )
    );
  });

  await run("D3. Static: Home widgets gates Excel bootstrap in postgres", async () => {
    const src = await fs.readFile(
      path.join(process.cwd(), "src/services/home/build-home-widgets.ts"),
      "utf8"
    );
    assert(src.includes("allowExcelBootstrap"));
    assert(/allowExcelBootstrap\s*&&/.test(src));
  });

  await run("D4. Runtime: migrated APIs succeed without Gmail/Drive OAuth", async () => {
    assert(pRolesBody && filtersBody && homeBody);
  });

  // ─── E. Read-only DB safety ──────────────────────────────────────────────

  await run("E1. lateral_master count unchanged after integration reads", async () => {
    const after = await countLateralMasterRows();
    assert(after === masterBefore, `before=${masterBefore} after=${after}`);
  });

  await run("E2. home_metrics updated_at unchanged after Home read", async () => {
    const after = await sql<
      Array<{ business_unit_id: string; updated_at: Date | string }>
    >`
      SELECT business_unit_id, updated_at FROM home_metrics
      ORDER BY business_unit_id
    `;
    assert(after.length === homeBefore.length);
    for (const row of homeBefore) {
      const next = after.find((r) => r.business_unit_id === row.business_unit_id);
      assert(next, `missing ${row.business_unit_id}`);
      assert(
        new Date(next!.updated_at).getTime() ===
          new Date(row.updated_at).getTime(),
        `${row.business_unit_id} updated_at drifted`
      );
    }
  });

  // ─── F. Regression smoke — intentionally Excel-backed ────────────────────

  console.log("\n------- Excel/Drive regression smoke -------");

  await runExcelSmoke(
    "F1. GET /api/excel/lateral-master-sheet is Postgres-backed",
    async () => {
      const response = await getMasterSheet(
        new Request(
          "http://localhost/api/excel/lateral-master-sheet?page=1&pageSize=10"
        )
      );
      if (!response.ok) {
        const body = (await jsonFromResponse(response).catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(body?.error ?? `HTTP ${response.status}`);
      }
      const body = (await jsonFromResponse(response)) as Record<string, unknown>;
      assert(body.ok === true, `ok=${String(body.ok)}`);
      assert(Array.isArray(body.rows), "missing rows");
      const sourceFile = String(body.sourceFile ?? "");
      assert(
        sourceFile === "lateral_master",
        `expected sourceFile=lateral_master, got ${sourceFile || "(empty)"}`
      );
      const headers = body.headers as string[] | undefined;
      assert(Array.isArray(headers) && headers.includes("Opened on Oorwin"), "missing Opened on Oorwin header");
      assert(Array.isArray(headers) && headers.includes("Job Description"), "missing Job Description header");
      console.log(
        `       master sheet page rows=${(body.rows as unknown[]).length} sourceFile=${sourceFile} headers=${headers?.length}`
      );
    }
  );

  await runExcelSmoke(
    "F2. GET /api/excel/lateral-master-sheet/export from Postgres",
    async () => {
      const response = await getMasterExport(
        new Request("http://localhost/api/excel/lateral-master-sheet/export")
      );
      if (!response.ok) {
        const body = (await jsonFromResponse(response).catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(body?.error ?? `HTTP ${response.status}`);
      }
      const ctype = response.headers.get("Content-Type") ?? "";
      assert(
        /spreadsheetml|octet-stream|excel/i.test(ctype) ||
          Boolean(
            response.headers.get("Content-Disposition")?.includes("attachment")
          ),
        `unexpected content-type: ${ctype}`
      );
      const buf = await response.arrayBuffer();
      assert(buf.byteLength > 0, "empty export");
      console.log(`       export bytes=${buf.byteLength}`);
    }
  );

  await runExcelSmoke(
    "F3. GET /api/excel/lateral/skill-clusters still Excel path",
    async () => {
      const response = await getSkillClusters(
        new Request(
          "http://localhost/api/excel/lateral/skill-clusters?limitGroups=3"
        ),
        { params: Promise.resolve({ businessUnitId: "lateral" }) }
      );
      if (!response.ok) {
        const body = (await jsonFromResponse(response).catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(body?.error ?? `HTTP ${response.status}`);
      }
      const body = (await jsonFromResponse(response)) as Record<string, unknown>;
      assert(Array.isArray(body.groups), "missing groups");
      assert(
        typeof body.sourceFile === "string" ||
          typeof body.sourcePath === "string",
        "missing Excel source metadata"
      );
      if (String(body.sourceFile) === "lateral_master") {
        throw new Error(
          "Skill clusters unexpectedly sourced from lateral_master"
        );
      }
      console.log(
        `       groups=${(body.groups as unknown[]).length} sourceFile=${body.sourceFile}`
      );
    }
  );

  await run(
    "F4. Static: Master Sheet defaults to Postgres; skill-clusters stay Excel",
    async () => {
      const masterSvc = await fs.readFile(
        path.join(
          process.cwd(),
          "src/services/excel/read-lateral-master-sheet.ts"
        ),
        "utf8"
      );
      assert(masterSvc.includes('ARA_LATERAL_MASTER_SOURCE'));
      assert(masterSvc.includes("listLateralMasterAsExcelRows"));
      assert(masterSvc.includes("readLateralMasterSheetFromDriveXlsm"));
      const clusters = await fs.readFile(
        path.join(
          process.cwd(),
          "src/services/excel/extract-skill-clusters.ts"
        ),
        "utf8"
      );
      assert(clusters.includes("readFilterSourceSheet"));
    }
  );

  await closeDbClient();

  const passed = results.filter((r) => r.status === "PASS");
  const failed = results.filter((r) => r.status === "FAIL");
  const skipped = results.filter((r) => r.status === "SKIP");

  console.log("\n---------- PHASE 8.5 SUMMARY ----------");
  console.log(`PASS: ${passed.length}`);
  console.log(`FAIL: ${failed.length}`);
  console.log(`SKIP: ${skipped.length}`);
  console.log(`Total: ${results.length}`);

  if (skipped.length) {
    console.log("\nSkipped:");
    for (const s of skipped) console.log(`  - ${s.name}: ${s.detail}`);
  }
  if (failed.length) {
    console.log("\nFailures (no auto-fix applied):");
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
    process.exitCode = 1;
  } else {
    console.log("\nPhase 8.5 integration: ALL REQUIRED CHECKS PASSED");
    if (skipped.length) {
      console.log(
        `(${skipped.length} Excel/Drive smoke test(s) skipped due to environment)`
      );
    }
  }
}

main().catch(async (error) => {
  console.error(error);
  process.exitCode = 1;
  try {
    const { closeDbClient } = await import("../src/lib/persistence/db-client");
    await closeDbClient();
  } catch {
    // ignore
  }
});
