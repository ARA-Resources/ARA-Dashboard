/**
 * Step C safety checks — default mode makes NO lasting PostgreSQL writes.
 *
 * Always:
 * - empty Posted input → no mass-reset
 * - persistDatabase=false dry-run matching against PG
 * - static checks: upsert preserves posted; p-roles-service still Postgres
 *
 * Optional (explicit only): ARA_STEPC_ALLOW_WRITES=1 enables a controlled
 * write+restore idempotency probe. Never set this against production casually.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { getDbClient, closeDbClient } from "../src/lib/persistence/db-client";
import { syncLateralPostedStatus } from "../src/services/lateral-processing/lateral-master-postgres";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
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

async function main() {
  await loadEnvLocal();
  const sql = getDbClient();
  const allowWrites = process.env.ARA_STEPC_ALLOW_WRITES === "1";
  console.log(
    `Step C safety validation (writes=${allowWrites ? "ALLOWED" : "disabled"})...`
  );

  const beforeYes = await sql<{ c: string }[]>`
    SELECT COUNT(*)::text AS c FROM lateral_master WHERE posted = 'Yes'
  `;
  const empty = await syncLateralPostedStatus([], true);
  assert(empty.skippedEmptyInput === true, "empty should skip");
  assert(empty.markedYes === 0 && empty.resetToDash === 0, "empty must not write");
  const afterEmptyYes = await sql<{ c: string }[]>`
    SELECT COUNT(*)::text AS c FROM lateral_master WHERE posted = 'Yes'
  `;
  assert(beforeYes[0].c === afterEmptyYes[0].c, "empty must not change Yes count");
  console.log("PASS empty-input no mass-reset");

  const seed = await sql<{
    job_requisition_id: string;
    posted: string | null;
    updated_at: string;
  }[]>`
    SELECT
      job_requisition_id,
      posted,
      updated_at::text AS updated_at
    FROM lateral_master
    WHERE job_requisition_id ~ '^ATCI-'
    ORDER BY job_requisition_id
    LIMIT 1
  `;
  assert(seed.length === 1, "need one ATCI row in lateral_master");
  const jr = seed[0].job_requisition_id;
  const snapshot = seed[0];

  const dry = await syncLateralPostedStatus(
    [jr, "ATCI-9999999-S9999999"],
    false
  );
  assert(dry.matchedIds.includes(jr), "dry-run must match existing JR");
  assert(
    !dry.matchedIds.includes("ATCI-9999999-S9999999"),
    "dry-run must not invent matches"
  );
  assert(dry.markedYes === 0 && dry.resetToDash === 0, "dry-run must not write");
  const afterDry = await sql<{ posted: string | null; updated_at: string }[]>`
    SELECT posted, updated_at::text AS updated_at
    FROM lateral_master WHERE job_requisition_id = ${jr}
  `;
  assert(
    afterDry[0].posted === snapshot.posted &&
      afterDry[0].updated_at === snapshot.updated_at,
    "dry-run must leave posted/updated_at unchanged"
  );
  console.log("PASS dry-run PG matching without writes");

  if (allowWrites) {
    const yesRows = await sql<
      { job_requisition_id: string; posted: string | null }[]
    >`SELECT job_requisition_id, posted FROM lateral_master WHERE posted = 'Yes'`;
    const thisBefore = await sql<{
      posted: string | null;
      job_status: string | null;
      primary_skills: string | null;
    }[]>`
      SELECT posted, job_status, primary_skills
      FROM lateral_master WHERE job_requisition_id = ${jr}
    `;

    const first = await syncLateralPostedStatus([jr], true);
    assert(first.matched === 1, "first sync matches one");
    const afterFirst = await sql<{
      posted: string | null;
      job_status: string | null;
      primary_skills: string | null;
    }[]>`
      SELECT posted, job_status, primary_skills
      FROM lateral_master WHERE job_requisition_id = ${jr}
    `;
    assert(afterFirst[0].posted === "Yes", "posted should be Yes");
    assert(
      afterFirst[0].job_status === thisBefore[0].job_status,
      "job_status unchanged"
    );
    assert(
      afterFirst[0].primary_skills === thisBefore[0].primary_skills,
      "primary_skills unchanged"
    );
    console.log("PASS sync only changes posted (+ updated_at)");

    const second = await syncLateralPostedStatus([jr], true);
    assert(second.markedYes === 0, "idempotent markedYes=0");
    console.log(
      `PASS idempotent second run markedYes=${second.markedYes} resetToDash=${second.resetToDash}`
    );

    await sql`
      UPDATE lateral_master SET posted = '-', updated_at = NOW()
      WHERE posted = 'Yes'
    `;
    for (const row of yesRows) {
      await sql`
        UPDATE lateral_master
        SET posted = ${row.posted}, updated_at = NOW()
        WHERE job_requisition_id = ${row.job_requisition_id}
      `;
    }
    await sql`
      UPDATE lateral_master
      SET posted = ${snapshot.posted}, updated_at = NOW()
      WHERE job_requisition_id = ${jr}
    `;
    console.log("PASS restored prior posted state");
  } else {
    console.log(
      "SKIP write/idempotency probe (set ARA_STEPC_ALLOW_WRITES=1 to enable)"
    );
  }

  const upsertSrc = await fs.readFile(
    path.join(
      process.cwd(),
      "src/services/lateral-processing/lateral-master-upsert.ts"
    ),
    "utf8"
  );
  assert(
    /Never touches job_status, posted, or created_at on conflict/.test(upsertSrc),
    "upsert must document posted preservation"
  );
  assert(
    !/DO UPDATE SET[\s\S]{0,500}\bposted\s*=/.test(upsertSrc),
    "upsert ON CONFLICT must not assign posted"
  );
  console.log("PASS Phase 8 upsert still preserves posted");

  const pRoles = await fs.readFile(
    path.join(
      process.cwd(),
      "src/services/lateral-processing/lateral-p-roles-service.ts"
    ),
    "utf8"
  );
  assert(
    pRoles.includes("listLateralMasterForPRoles") &&
      pRoles.includes("source?: LateralPRolesDataSource"),
    "Phase 8 p-roles postgres path must remain"
  );
  console.log("PASS Phase 8 p-roles-service intact");

  await closeDbClient();
  console.log("\nStep C safety validation PASSED");
}

void main().catch(async (err) => {
  console.error(err);
  await closeDbClient().catch(() => undefined);
  process.exit(1);
});
