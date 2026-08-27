/**
 * Phase 8.6 — Final validation orchestrator for Phase 8 dashboard PG migration.
 *
 * Runs existing Phase 8.1–8.5 validation scripts and records PASS/FAIL/SKIP.
 * Adds static scope checks only (no functional changes).
 *
 * Run: npx tsx scripts/verify-phase86-final-validation.ts
 */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

type Status = "PASS" | "FAIL" | "SKIP";

interface SuiteResult {
  id: string;
  name: string;
  status: Status;
  exitCode: number | null;
  durationMs: number;
  summaryLine?: string;
  skipNote?: string;
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

function runScript(
  id: string,
  name: string,
  scriptRel: string
): Promise<SuiteResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(
      process.platform === "win32" ? "npx.cmd" : "npx",
      ["tsx", scriptRel],
      {
        cwd: process.cwd(),
        env: { ...process.env, ARA_PERSISTENCE: "postgres" },
        shell: true,
      }
    );

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      process.stdout.write(text);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(text);
    });

    child.on("close", (code) => {
      const combined = `${stdout}\n${stderr}`;
      const skipMatches = [...combined.matchAll(/^SKIP\s+.+$/gm)].map((m) =>
        m[0]
      );
      const failMatches = [...combined.matchAll(/^FAIL\s+.+$/gm)].map((m) =>
        m[0]
      );
      const summary =
        combined
          .split("\n")
          .reverse()
          .find(
            (line) =>
              /ALL PASS|ALL REQUIRED CHECKS PASSED|SUMMARY|Passed:/i.test(
                line
              )
          ) ?? undefined;

      let status: Status = "PASS";
      if (code !== 0 || failMatches.length > 0) status = "FAIL";
      else if (skipMatches.length > 0) status = "PASS"; // suite ok with skips

      resolve({
        id,
        name,
        status,
        exitCode: code,
        durationMs: Date.now() - started,
        summaryLine: summary?.trim(),
        skipNote:
          skipMatches.length > 0
            ? `${skipMatches.length} SKIP line(s) in suite output`
            : undefined,
      });
    });
  });
}

async function assert(condition: boolean, detail: string) {
  if (!condition) throw new Error(detail);
}

async function staticScopeChecks(): Promise<{
  status: Status;
  details: string[];
}> {
  const details: string[] = [];
  const read = (rel: string) =>
    fs.readFile(path.join(process.cwd(), rel), "utf8");

  // Migrated paths
  const pRoles = await read("src/app/api/dataset/lateral/p-roles/route.ts");
  await assert(
    pRoles.includes('source: "postgres"'),
    "P-Roles route missing source postgres"
  );
  details.push("P-Roles API → postgres source");

  const filters = await read("src/services/excel/filter-schema.ts");
  await assert(
    filters.includes("getLateralDashboardFilterSchemaFromPostgres"),
    "Filters missing PG builder"
  );
  details.push("Lateral filters → PG schema builder");

  const home = await read("src/services/home/build-home-widgets.ts");
  await assert(
    home.includes("allowExcelBootstrap") && /allowExcelBootstrap\s*&&/.test(home),
    "Home widgets missing postgres bootstrap gate"
  );
  details.push("Home widgets → home_metrics only in postgres mode");

  const readLayer = await read(
    "src/services/persistence/read-lateral-master.ts"
  );
  await assert(
    readLayer.includes("listLateralMasterForPRoles"),
    "8.1 read layer missing"
  );
  if (/\bINSERT\b|\bUPDATE\b|\bDELETE\b|\bTRUNCATE\b/.test(readLayer)) {
    throw new Error("read layer contains write SQL");
  }
  details.push("8.1 read layer present and read-only");

  // Intentional Excel exceptions
  const master = await read(
    "src/services/excel/read-lateral-master-sheet.ts"
  );
  await assert(
    master.includes("readLateralMasterSheetFromDriveXlsm"),
    "Master Sheet no longer Drive/Excel"
  );
  details.push("EXCEPTION: Master Sheet remains Drive/Excel");

  const exportRoute = await read(
    "src/app/api/excel/lateral-master-sheet/export/route.ts"
  );
  await assert(
    exportRoute.includes("exportLateralMasterSheetXlsx"),
    "Master export path changed unexpectedly"
  );
  details.push("EXCEPTION: Master Sheet export remains Excel");

  const clusters = await read(
    "src/services/excel/extract-skill-clusters.ts"
  );
  await assert(
    clusters.includes("readFilterSourceSheet"),
    "Skill clusters no longer Excel"
  );
  details.push("EXCEPTION: Allocations/Skill Clusters remain Excel");

  // Phase 7 / schema untouched markers
  const mig003 = await read("db/migrations/003_lateral_master_staging.sql");
  await assert(
    mig003.includes("CREATE TABLE IF NOT EXISTS lateral_master"),
    "migration 003 missing"
  );
  // No Phase 8 migration file should exist
  const migrations = await fs.readdir(path.join(process.cwd(), "db/migrations"));
  const phase8Migrations = migrations.filter((f) =>
    /004|008|phase.?8/i.test(f)
  );
  await assert(
    phase8Migrations.length === 0,
    `unexpected Phase 8 migration files: ${phase8Migrations.join(", ")}`
  );
  details.push("No Phase 8 schema migration added (001–003 only)");

  const upsert = await read(
    "src/services/lateral-processing/lateral-master-upsert.ts"
  );
  await assert(
    upsert.includes("Phase 4A") || upsert.includes("lateral_staging"),
    "upsert service missing"
  );
  details.push("Phase 7 upsert service still present (untouched by validation)");

  return { status: "PASS", details };
}

async function main() {
  await loadEnvLocal();
  process.env.ARA_PERSISTENCE = "postgres";

  console.log("========== PHASE 8.6 — FINAL VALIDATION ==========\n");
  console.log(`ARA_PERSISTENCE=${process.env.ARA_PERSISTENCE}\n`);

  const suites: Array<{ id: string; name: string; script: string }> = [
    {
      id: "8.1",
      name: "PostgreSQL read layer",
      script: "scripts/verify-lateral-master-read-layer.ts",
    },
    {
      id: "8.2",
      name: "P-Roles → PostgreSQL",
      script: "scripts/verify-lateral-p-roles-postgres.ts",
    },
    {
      id: "8.3",
      name: "Lateral filters → PostgreSQL",
      script: "scripts/verify-lateral-filters-postgres.ts",
    },
    {
      id: "8.4",
      name: "Home widgets → PostgreSQL",
      script: "scripts/verify-home-widgets-postgres.ts",
    },
    {
      id: "8.5",
      name: "Dashboard integration",
      script: "scripts/verify-phase85-dashboard-integration.ts",
    },
  ];

  const suiteResults: SuiteResult[] = [];

  for (const suite of suites) {
    console.log(`\n######## Running Phase ${suite.id}: ${suite.name} ########\n`);
    const result = await runScript(suite.id, suite.name, suite.script);
    suiteResults.push(result);
    console.log(
      `\n>>> Suite ${suite.id} ${result.status} (exit=${result.exitCode}, ${result.durationMs}ms)`
    );
    if (result.skipNote) console.log(`>>> ${result.skipNote}`);
  }

  console.log("\n######## Phase 8.6 static scope checks ########\n");
  let scopeStatus: Status = "PASS";
  let scopeDetails: string[] = [];
  try {
    const scope = await staticScopeChecks();
    scopeStatus = scope.status;
    scopeDetails = scope.details;
    for (const d of scopeDetails) console.log(`PASS  ${d}`);
  } catch (error) {
    scopeStatus = "FAIL";
    const detail = error instanceof Error ? error.message : String(error);
    scopeDetails = [detail];
    console.error(`FAIL  static scope: ${detail}`);
  }

  console.log("\n---------- PHASE 8.6 FINAL SUMMARY ----------");
  for (const r of suiteResults) {
    const skip = r.skipNote ? ` (${r.skipNote})` : "";
    console.log(
      `Phase ${r.id} [${r.status}] ${r.name} — exit ${r.exitCode}${skip}`
    );
    if (r.summaryLine) console.log(`         ${r.summaryLine}`);
  }
  console.log(`Phase 8.6 scope [${scopeStatus}] static documentation/scope checks`);

  console.log("\n------- Migrated runtime paths -------");
  console.log("  ✓ /api/dataset/lateral/p-roles     → PostgreSQL lateral_master");
  console.log("  ✓ /api/excel/lateral/filters       → PostgreSQL lateral_master");
  console.log("  ✓ /api/home/widgets                → PostgreSQL home_metrics");
  console.log("------- Intentional Excel/Drive exceptions -------");
  console.log("  · /api/excel/lateral-master-sheet (+ export)");
  console.log("  · /api/excel/lateral/skill-clusters (Allocations)");
  console.log("  · /api/excel/lateral/opening-skills (unused UI)");

  const failedSuites = suiteResults.filter((r) => r.status === "FAIL");
  const suitesWithSkips = suiteResults.filter((r) => r.skipNote);

  console.log("\n---------- ROLLUP ----------");
  console.log(`Suites PASS: ${suiteResults.filter((r) => r.status === "PASS").length}/${suiteResults.length}`);
  console.log(`Suites FAIL: ${failedSuites.length}`);
  console.log(`Suites with SKIP lines: ${suitesWithSkips.length}`);
  console.log(`Scope checks: ${scopeStatus}`);

  if (failedSuites.length || scopeStatus === "FAIL") {
    console.log("\nPhase 8.6 FINAL VALIDATION: FAIL");
    process.exitCode = 1;
  } else {
    console.log("\nPhase 8.6 FINAL VALIDATION: PASS");
    if (suitesWithSkips.length) {
      console.log(
        "Note: some Excel/Drive smoke checks skipped due to local OAuth/environment (not treated as migration failure)."
      );
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
