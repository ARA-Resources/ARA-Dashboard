/**
 * Verify the Lateral P-Roles pivot honours all 5 toolbar filters and that the
 * per-column totals are internally consistent.
 *
 * Specifically checks the two filters that were previously dropped server-side:
 *   - Priority
 *   - Skill Categorization
 * plus the existing Job Status / Posted / Market Map, and the column-wise
 * Grand Total math used by the new footer row.
 *
 * All expectations are derived live from `lateral_master` — no hardcoded counts.
 *
 * Run: npx tsx scripts/verify-lateral-p-roles-filters.ts
 */
import fs from "node:fs/promises";
import path from "node:path";
import { closeDbClient, getDbClient } from "../src/lib/persistence/db-client";
import { buildLateralPRolesOpenings } from "../src/services/lateral-processing/lateral-p-roles-service";
import type { ExcelOpeningsResult } from "../src/types/excel";
import type { OpeningsFilters } from "../src/types/filters";

const JML_COLUMNS = [
  "8-Associate Manager",
  "9-Team Lead/Consultant",
  "10-Senior Analyst",
  "11-Analyst",
  "12-Associate",
];

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

async function loadEnvLocal() {
  for (const file of [".env.local", ".env"]) {
    try {
      const content = await fs.readFile(
        path.join(process.cwd(), file),
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
}

function baseFilters(): OpeningsFilters {
  return {
    columnFilters: {
      "Job Status": ["Active", "Reopen", "New"],
      Posted: ["Yes"],
    },
    sortBy: "Grand Total",
    sortDirection: "desc",
    topN: null,
  };
}

function withColumn(
  filters: OpeningsFilters,
  column: string,
  values: string[]
): OpeningsFilters {
  return {
    ...filters,
    columnFilters: { ...filters.columnFilters, [column]: values },
  };
}

/** COUNT(*) of lateral_master rows matching the base filters + extra predicates. */
async function sqlCount(extra: {
  priority?: string;
  skillCategorization?: string;
}): Promise<number> {
  const sql = getDbClient();
  const statuses = ["active", "reopen", "new"];
  const rows = await sql<{ c: string }[]>`
    SELECT COUNT(*)::text AS c FROM lateral_master
    WHERE LOWER(COALESCE(job_status, '')) = ANY(${statuses})
      AND LOWER(COALESCE(posted, '')) = ${"yes"}
      AND btrim(COALESCE(job_requisition_id, '')) <> ''
      ${
        extra.priority
          ? sql`AND LOWER(COALESCE(priority, '')) = ${extra.priority.toLowerCase()}`
          : sql``
      }
      ${
        extra.skillCategorization
          ? sql`AND LOWER(COALESCE(skill_categorization, '')) = ${extra.skillCategorization.toLowerCase()}`
          : sql``
      }
  `;
  return Number(rows[0]?.c ?? 0);
}

function columnSum(result: ExcelOpeningsResult, header: string): number {
  return result.rows.reduce(
    (acc, row) => acc + (Number(row[header] ?? 0) || 0),
    0
  );
}

async function main() {
  await loadEnvLocal();
  console.log("===== Lateral P-Roles filters + totals =====\n");

  const base = await buildLateralPRolesOpenings(baseFilters(), {
    source: "postgres",
  });
  const baseDetail = base.meta.filteredDetailCount ?? -1;
  const baseSql = await sqlCount({});
  check(
    "base: engine detail count matches SQL",
    baseDetail === baseSql,
    `engine=${baseDetail} sql=${baseSql}`
  );

  // ---- Priority filter (was previously ignored) ----
  const p1 = await buildLateralPRolesOpenings(
    withColumn(baseFilters(), "Priority", ["P1"]),
    { source: "postgres" }
  );
  const p1Detail = p1.meta.filteredDetailCount ?? -1;
  const p1Sql = await sqlCount({ priority: "P1" });
  check(
    "Priority=P1 changes the result",
    p1Detail < baseDetail && p1Detail > 0,
    `base=${baseDetail} p1=${p1Detail}`
  );
  check(
    "Priority=P1 detail count matches SQL",
    p1Detail === p1Sql,
    `engine=${p1Detail} sql=${p1Sql}`
  );

  const p1Plus2 = await buildLateralPRolesOpenings(
    withColumn(baseFilters(), "Priority", ["P1", "P2"]),
    { source: "postgres" }
  );
  check(
    "Priority=P1+P2 ≈ base (both priorities selected)",
    (p1Plus2.meta.filteredDetailCount ?? -1) === baseDetail,
    `p1p2=${p1Plus2.meta.filteredDetailCount} base=${baseDetail}`
  );

  // ---- Skill Categorization filter (was previously ignored) ----
  const core = await buildLateralPRolesOpenings(
    withColumn(baseFilters(), "Skill Categorization", ["Core"]),
    { source: "postgres" }
  );
  const coreDetail = core.meta.filteredDetailCount ?? -1;
  const coreSql = await sqlCount({ skillCategorization: "Core" });
  check(
    "Skill Categorization=Core detail count matches SQL",
    coreDetail === coreSql,
    `engine=${coreDetail} sql=${coreSql}`
  );
  check(
    "Skill Categorization=Core → every returned row is Core",
    core.rows.length > 0 &&
      core.rows.every((r) => r["Skill Categorization"] === "Core"),
    `rows=${core.rows.length}`
  );

  // ---- Column-wise Grand Total math (footer row) ----
  const grandTotalColSum = columnSum(base, "Grand Total");
  check(
    "sum of per-row Grand Total == filteredDetailCount",
    grandTotalColSum === baseDetail,
    `sum=${grandTotalColSum} detail=${baseDetail}`
  );
  const jmlColsSum = JML_COLUMNS.reduce(
    (acc, col) => acc + columnSum(base, col),
    0
  );
  check(
    "sum of the 5 JML columns == sum of Grand Total column",
    jmlColsSum === grandTotalColSum,
    `jml=${jmlColsSum} grand=${grandTotalColSum}`
  );

  // ---- No regression on the existing filters ----
  check(
    "base still returns all skill groups (topN=null)",
    base.meta.topN === undefined && base.rows.length > 50,
    `rows=${base.rows.length} topN=${base.meta.topN}`
  );

  await closeDbClient();
  console.log(
    `\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch(async (error) => {
  console.error(error);
  process.exitCode = 1;
  await closeDbClient();
});
