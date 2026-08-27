/**
 * Phase 8.4 validation — Home widgets from PostgreSQL `home_metrics`.
 *
 * Proves getHomeDashboardWidgets /api/home/widgets is home_metrics-backed
 * when ARA_PERSISTENCE=postgres, preserves response contract, matches SQL
 * KPI values, skips Drive/Excel bootstrap, and performs no DB writes.
 *
 * Run: npx tsx scripts/verify-home-widgets-postgres.ts
 */
import fs from "node:fs/promises";
import path from "node:path";
import {
  closeDbClient,
  getDbClient,
} from "../src/lib/persistence/db-client";
import {
  getHomeDashboardWidgets,
  homeWidgetsAllowsExcelBootstrap,
  invalidateHomeWidgetsCache,
} from "../src/services/home/build-home-widgets";
import { readHomeWidgetsMetricsSnapshot } from "../src/services/home/home-widgets-metrics-store";
import type { HomeDashboardWidgetsData } from "../src/types/home-widgets";

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

function assertContract(payload: HomeDashboardWidgetsData) {
  assert(typeof payload.generatedAt === "string" && payload.generatedAt.length > 0);
  assert(payload.metrics && typeof payload.metrics === "object");
  for (const key of [
    "totalOpenPositions",
    "activeOpenings",
    "postedOpenings",
    "newOpenings",
  ] as const) {
    const m = payload.metrics[key];
    assert(m && typeof m.id === "string");
    assert(typeof m.label === "string");
    assert(typeof m.value === "number" && Number.isFinite(m.value));
  }
  assert(Array.isArray(payload.metricBreakdown.totalOpenPositions));
  assert(Array.isArray(payload.businessUnitDistribution));
  assert(Array.isArray(payload.excelSyncStatus));
  assert(Array.isArray(payload.activityFeed));
  assert(Array.isArray(payload.topHiringCompanies));
  assert(payload.businessUnitDistribution.length >= 1);
  assert(payload.excelSyncStatus.length >= 1);
}

async function main() {
  await loadEnvLocal();
  process.env.ARA_PERSISTENCE = "postgres";

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

  console.log("========== PHASE 8.4 — HOME WIDGETS → POSTGRESQL ==========\n");

  assert(
    process.env.ARA_PERSISTENCE?.toLowerCase() === "postgres",
    "ARA_PERSISTENCE must be postgres for this validation"
  );

  const sql = getDbClient();
  const metricsBefore = await sql<
    Array<{
      business_unit_id: string;
      totals: number;
      active: number;
      posted: number;
      fresh: number;
      updated_at: Date | string;
    }>
  >`
    SELECT business_unit_id, totals, active, posted, fresh, updated_at
    FROM home_metrics
    WHERE business_unit_id = ANY(${["lateral", "executive", "consulting"]})
    ORDER BY business_unit_id
  `;

  await run("1. home_metrics has Lateral row for dashboard KPIs", async () => {
    const lateral = metricsBefore.find((r) => r.business_unit_id === "lateral");
    assert(Boolean(lateral), "missing home_metrics.lateral row");
    assert(
      (lateral!.totals ?? 0) > 0 || (lateral!.active ?? 0) > 0,
      "lateral home_metrics KPIs are empty — pipeline may not have written yet"
    );
    console.log(
      `       lateral: totals=${lateral!.totals} active=${lateral!.active} posted=${lateral!.posted} fresh=${lateral!.fresh}`
    );
  });

  await run("2. Postgres mode disables Excel/Drive bootstrap", async () => {
    assert(
      homeWidgetsAllowsExcelBootstrap() === false,
      "Excel bootstrap should be disabled when ARA_PERSISTENCE=postgres"
    );
  });

  invalidateHomeWidgetsCache();
  let payload: HomeDashboardWidgetsData | null = null;

  await run("3. getHomeDashboardWidgets returns contract-compatible payload", async () => {
    payload = await getHomeDashboardWidgets({ bypassCache: true });
    assertContract(payload);
  });

  await run("4. KPI values match home_metrics SQL", async () => {
    const p = payload!;
    const byId = new Map(
      metricsBefore.map((r) => [r.business_unit_id, r] as const)
    );
    const lateral = byId.get("lateral");
    const executive = byId.get("executive");
    const consulting = byId.get("consulting");

    const expectedTotals =
      (lateral?.totals ?? 0) +
      (executive?.totals ?? 0) +
      (consulting?.totals ?? 0);
    const expectedActive =
      (lateral?.active ?? 0) +
      (executive?.active ?? 0) +
      (consulting?.active ?? 0);
    const expectedPosted =
      (lateral?.posted ?? 0) +
      (executive?.posted ?? 0) +
      (consulting?.posted ?? 0);
    const expectedFresh =
      (lateral?.fresh ?? 0) +
      (executive?.fresh ?? 0) +
      (consulting?.fresh ?? 0);

    assert(
      p.metrics.totalOpenPositions.value === expectedTotals,
      `totals widget=${p.metrics.totalOpenPositions.value} sql=${expectedTotals}`
    );
    assert(
      p.metrics.activeOpenings.value === expectedActive,
      `active widget=${p.metrics.activeOpenings.value} sql=${expectedActive}`
    );
    assert(
      p.metrics.postedOpenings.value === expectedPosted,
      `posted widget=${p.metrics.postedOpenings.value} sql=${expectedPosted}`
    );
    assert(
      p.metrics.newOpenings.value === expectedFresh,
      `fresh widget=${p.metrics.newOpenings.value} sql=${expectedFresh}`
    );

    const lateralBreakdown = p.metricBreakdown.totalOpenPositions.find(
      (x) => x.businessUnitId === "lateral"
    );
    assert(
      lateralBreakdown?.value === (lateral?.totals ?? 0),
      "lateral breakdown mismatch"
    );
  });

  await run("5. Snapshot read path matches store (L2)", async () => {
    const snap = await readHomeWidgetsMetricsSnapshot();
    assert(snap.units.lateral, "snapshot missing lateral");
    assert(
      snap.units.lateral!.totals ===
        metricsBefore.find((r) => r.business_unit_id === "lateral")!.totals
    );
  });

  await run("6. L1 cache returns same payload without re-bootstrap", async () => {
    const again = await getHomeDashboardWidgets({ bypassCache: false });
    assert(again.metrics.totalOpenPositions.value === payload!.metrics.totalOpenPositions.value);
    assert(again.metrics.activeOpenings.value === payload!.metrics.activeOpenings.value);
  });

  await run("7. refresh=1 (bypassCache) still PG-only — no Drive required", async () => {
    invalidateHomeWidgetsCache();
    const refreshed = await getHomeDashboardWidgets({ bypassCache: true });
    assertContract(refreshed);
    assert(
      refreshed.metrics.totalOpenPositions.value ===
        payload!.metrics.totalOpenPositions.value
    );
  });

  await run("8. No home_metrics writes during Home widgets read", async () => {
    const after = await sql<
      Array<{ business_unit_id: string; updated_at: Date | string }>
    >`
      SELECT business_unit_id, updated_at FROM home_metrics
      WHERE business_unit_id = ANY(${["lateral", "executive", "consulting"]})
      ORDER BY business_unit_id
    `;
    assert(after.length === metricsBefore.length);
    for (const row of metricsBefore) {
      const next = after.find((r) => r.business_unit_id === row.business_unit_id);
      assert(next, `missing ${row.business_unit_id}`);
      const beforeMs = new Date(row.updated_at).getTime();
      const afterMs = new Date(next!.updated_at).getTime();
      assert(
        beforeMs === afterMs,
        `${row.business_unit_id} updated_at changed ${row.updated_at} → ${next!.updated_at}`
      );
    }
  });

  await run("9. Static: postgres branch skips Excel bootstrap modules at call time", async () => {
    const src = await fs.readFile(
      path.join(process.cwd(), "src/services/home/build-home-widgets.ts"),
      "utf8"
    );
    assert(src.includes("homeWidgetsAllowsExcelBootstrap"));
    assert(src.includes("isPostgresMode"));
    assert(src.includes("allowExcelBootstrap"));
    assert(
      /allowExcelBootstrap\s*&&/.test(src),
      "Excel bootstrap must be gated on allowExcelBootstrap"
    );
    // Dynamic imports remain for file-mode only — gated
    assert(src.includes("refresh-lateral-home-widgets-metrics"));
    assert(src.includes("refresh-executive-home-widgets-metrics"));
  });

  await run("10. Frontend hook contract still points at /api/home/widgets", async () => {
    const fetchSrc = await fs.readFile(
      path.join(process.cwd(), "src/services/home/fetch-home-widgets.ts"),
      "utf8"
    );
    assert(fetchSrc.includes('"/api/home/widgets"'));
    const hookSrc = await fs.readFile(
      path.join(process.cwd(), "src/hooks/use-home-widgets.ts"),
      "utf8"
    );
    assert(hookSrc.includes("fetchHomeDashboardWidgets"));
  });

  await run("11. Scope: P-Roles / filters / Master Sheet untouched by this change", async () => {
    // Sanity: those routes still exist with prior phase markers
    const pRoles = await fs.readFile(
      path.join(process.cwd(), "src/app/api/dataset/lateral/p-roles/route.ts"),
      "utf8"
    );
    assert(pRoles.includes('source: "postgres"'));
    const filters = await fs.readFile(
      path.join(process.cwd(), "src/services/excel/filter-schema.ts"),
      "utf8"
    );
    assert(filters.includes("getLateralDashboardFilterSchemaFromPostgres"));
  });

  console.log("\n------- Home widgets data path (postgres) -------");
  console.log("  GET /api/home/widgets");
  console.log("    → getHomeDashboardWidgets()");
  console.log("    → readHomeWidgetsMetricsSnapshot() → home_metrics");
  console.log("    → buildPayload (no Drive/Excel bootstrap)");

  await closeDbClient();

  const failed = results.filter((r) => r.status === "FAIL");
  console.log("\n---------- SUMMARY ----------");
  console.log(`Passed: ${results.length - failed.length}/${results.length}`);
  if (failed.length) {
    for (const f of failed) console.log(`  FAIL: ${f.name} — ${f.detail}`);
    process.exitCode = 1;
  } else {
    console.log("Phase 8.4 Home widgets → PostgreSQL validation: ALL PASS");
  }
}

main().catch(async (error) => {
  console.error(error);
  process.exitCode = 1;
  await closeDbClient();
});
