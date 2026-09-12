/**
 * Verify the Executive dashboard read-path now runs off PostgreSQL
 * `executive_master` (migration 009) instead of the XLSM.
 *
 * Usage: npx tsx scripts/verify-executive-master-postgres.ts
 *        npm run test:executive-master-postgres
 *
 * Read-only. Checks:
 *  - row count (expect 1,576)
 *  - Priority distinct values ⊆ {Very High Priority, High Priority,
 *    Do Not Add Supply} + NULL
 *  - job_status ⊆ {New,Reopen,Active,Closed}; posted ⊆ {Yes,-}
 *  - Job Management Level distribution
 *  - listExecutiveMasterForPDashboard() + buildExecutivePDashboardFromRows()
 *    produce a coherent pivot (Grand Total == sum of group rows; canonical Level
 *    total <= filtered detail count)
 */

import fs from "node:fs/promises";
import path from "node:path";
import postgres from "postgres";
import {
  listExecutiveMasterForPDashboard,
  countExecutiveMasterRows,
} from "../src/services/persistence/read-executive-master";
import {
  buildExecutivePDashboardFromRows,
  extractExecutivePDashboardFilters,
} from "../src/services/executive-processing/executive-p-dashboard-engine";
import { EXECUTIVE_PRIORITY_CANONICAL_VALUES } from "../src/services/executive-processing/executive-priority-normalize";

const EXPECTED_ROWS = 1576;

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
      const v = t
        .slice(eq + 1)
        .trim()
        .replace(/^["']|["']$/g, "");
      if (k && !(k in process.env)) process.env[k] = v;
    }
  } catch {
    // optional
  }
}

function getDb() {
  const url = process.env.POSTGRES_URL?.trim();
  if (!url) throw new Error("POSTGRES_URL is not set.");
  return postgres(url, {
    max: 1,
    prepare: false,
    ssl:
      url.includes("localhost") || url.includes("127.0.0.1") ? false : "require",
  });
}

async function main() {
  await loadEnvLocal();
  const sql = getDb();
  const issues: string[] = [];

  try {
    const total = await countExecutiveMasterRows(sql);
    if (total !== EXPECTED_ROWS) {
      issues.push(`Row count ${total} != expected ${EXPECTED_ROWS}`);
    }

    const distinct = async (col: string) =>
      (
        await sql<{ value: string | null; c: string }[]>`
          SELECT ${sql(col)} AS value, COUNT(*)::text AS c
          FROM executive_master GROUP BY ${sql(col)} ORDER BY 1 NULLS FIRST
        `
      ).map((r) => ({ value: r.value, count: Number(r.c) }));

    const priority = await distinct("priority");
    const jobStatus = await distinct("job_status");
    const posted = await distinct("posted");
    const level = await distinct("job_management_level");
    const dateNonNull = Number(
      (
        await sql<{ c: string }[]>`
          SELECT COUNT(*)::text AS c FROM executive_master WHERE date IS NOT NULL
        `
      )[0]?.c ?? "0"
    );

    const allowedPriority = new Set<string | null>([
      ...EXECUTIVE_PRIORITY_CANONICAL_VALUES,
      null,
    ]);
    for (const row of priority) {
      if (!allowedPriority.has(row.value)) {
        issues.push(`Unexpected Priority value: ${JSON.stringify(row.value)}`);
      }
    }
    for (const row of jobStatus) {
      if (
        row.value !== null &&
        !["New", "Reopen", "Active", "Closed"].includes(row.value)
      ) {
        issues.push(`Unexpected Job Status: ${JSON.stringify(row.value)}`);
      }
    }
    for (const row of posted) {
      if (row.value !== null && !["Yes", "-"].includes(row.value)) {
        issues.push(`Unexpected Posted: ${JSON.stringify(row.value)}`);
      }
    }
    if (dateNonNull !== 0) {
      issues.push(`Expected 0 non-null date rows, found ${dateNonNull}`);
    }

    // Engine path
    const rows = await listExecutiveMasterForPDashboard(sql);
    const noFilter = buildExecutivePDashboardFromRows(
      rows,
      extractExecutivePDashboardFilters({})
    );
    const activeOnly = buildExecutivePDashboardFromRows(
      rows,
      extractExecutivePDashboardFilters({ "Job Status": ["Active"] })
    );

    const groupSum = (
      g: typeof noFilter.groups,
      key: "5-Associate Director" | "6-Senior Manager" | "7-Manager"
    ) => g.reduce((s, row) => s + row[key], 0);

    for (const [name, built] of [
      ["no-filter", noFilter],
      ["Job Status = Active", activeOnly],
    ] as const) {
      for (const key of [
        "5-Associate Director",
        "6-Senior Manager",
        "7-Manager",
      ] as const) {
        if (groupSum(built.groups, key) !== built.totals[key]) {
          issues.push(`${name}: Grand Total mismatch for ${key}`);
        }
      }
      if (built.totals.canonicalTotal > built.totals.filteredDetailCount) {
        issues.push(`${name}: canonical Level total exceeds detail count`);
      }
    }

    const summary = {
      ok: issues.length === 0,
      rowCount: total,
      expectedRowCount: EXPECTED_ROWS,
      priority,
      jobStatus,
      posted,
      level,
      dateNonNull,
      pivot: {
        noFilter: {
          groups: noFilter.groups.length,
          filteredDetailCount: noFilter.totals.filteredDetailCount,
          totals: {
            "5-Associate Director": noFilter.totals["5-Associate Director"],
            "6-Senior Manager": noFilter.totals["6-Senior Manager"],
            "7-Manager": noFilter.totals["7-Manager"],
            canonicalTotal: noFilter.totals.canonicalTotal,
          },
        },
        active: {
          groups: activeOnly.groups.length,
          filteredDetailCount: activeOnly.totals.filteredDetailCount,
          canonicalTotal: activeOnly.totals.canonicalTotal,
        },
      },
      issues,
    };

    console.log(JSON.stringify(summary, null, 2));
    if (!summary.ok) {
      console.error("EXECUTIVE_MASTER_PG_VERIFY_FAIL");
      process.exit(1);
    }
    console.log("EXECUTIVE_MASTER_PG_VERIFY_OK");
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error("EXECUTIVE_MASTER_PG_VERIFY_FAIL", err);
  process.exit(1);
});
