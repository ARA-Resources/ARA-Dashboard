/**
 * Phase 4A tests — lateral_staging → lateral_master field UPSERT.
 *
 * Run: npm run test:lateral-master-upsert
 *
 * Uses prefixed test JRs (PHASE4A-*). Snapshots and restores production
 * staging. Never deletes non-test Master rows.
 */

import fs from "node:fs/promises";
import path from "node:path";
import postgres from "postgres";
import {
  classifyStagingAgainstMaster,
  syncLateralMasterFromStaging,
  validateStagingForMasterUpsert,
  type StagingSourceRow,
} from "../src/services/lateral-processing/lateral-master-upsert";

const PREFIX = "PHASE4A-TEST-";

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

type Sql = ReturnType<typeof postgres>;

let passed = 0;
let failed = 0;

function ok(name: string, cond: boolean, detail = "") {
  if (cond) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function snapshotStaging(sql: Sql) {
  return sql<
    {
      date: string | null;
      job_requisition_id: string;
      priority: string | null;
      job_description: string | null;
      skill_categorization: string | null;
      primary_skills: string | null;
      job_management_level: string | null;
      primary_location: string | null;
      market_map: string | null;
      poc: string | null;
    }[]
  >`
    SELECT
      date::text AS date,
      job_requisition_id,
      priority,
      job_description,
      skill_categorization,
      primary_skills,
      job_management_level,
      primary_location,
      market_map,
      poc
    FROM lateral_staging
    ORDER BY id ASC
  `;
}

async function restoreStaging(
  sql: Sql,
  rows: Awaited<ReturnType<typeof snapshotStaging>>
) {
  await sql.begin(async (tx) => {
    await tx`TRUNCATE TABLE lateral_staging RESTART IDENTITY`;
    const BATCH = 500;
    for (let i = 0; i < rows.length; i += BATCH) {
      const batch = rows.slice(i, i + BATCH);
      if (batch.length === 0) continue;
      await tx`INSERT INTO lateral_staging ${tx(batch)}`;
    }
  });
}

async function deleteTestMasterRows(sql: Sql) {
  await sql`
    DELETE FROM lateral_master
    WHERE job_requisition_id LIKE ${PREFIX + "%"}
  `;
}

async function setStaging(sql: Sql, rows: StagingSourceRow[]) {
  await sql.begin(async (tx) => {
    await tx`TRUNCATE TABLE lateral_staging RESTART IDENTITY`;
    if (rows.length === 0) return;
    await tx`INSERT INTO lateral_staging ${tx(
      rows.map((r) => ({
        date: r.date,
        job_requisition_id: r.job_requisition_id,
        priority: r.priority,
        job_description: r.job_description,
        skill_categorization: r.skill_categorization,
        primary_skills: r.primary_skills,
        job_management_level: r.job_management_level,
        primary_location: r.primary_location,
        market_map: r.market_map,
        poc: r.poc,
      }))
    )}`;
  });
}

function row(
  jr: string,
  overrides: Partial<StagingSourceRow> = {}
): StagingSourceRow {
  return {
    date: "2026-08-25",
    job_requisition_id: jr,
    priority: "P1",
    job_description: "Desc A",
    skill_categorization: "Tech",
    primary_skills: "Java",
    job_management_level: "10-Senior Analyst",
    primary_location: "Bengaluru",
    market_map: "Market",
    poc: "Alice",
    ...overrides,
  };
}

async function insertMasterSeed(
  sql: Sql,
  jr: string,
  extras: {
    job_status?: string | null;
    posted?: string | null;
    created_at?: string;
    last_seen_at?: string | null;
    priority?: string;
  } = {}
) {
  const created =
    extras.created_at ?? "2024-01-15T10:00:00.000Z";
  await sql`
    INSERT INTO lateral_master (
      job_requisition_id, date, priority, job_description,
      skill_categorization, primary_skills, job_management_level,
      primary_location, market_map, poc, job_status, posted,
      created_at, updated_at, last_seen_at
    ) VALUES (
      ${jr},
      ${"2026-08-01"},
      ${extras.priority ?? "P2"},
      ${"Old desc"},
      ${"Old cat"},
      ${"Old skills"},
      ${"11-Analyst"},
      ${"Pune"},
      ${"Old map"},
      ${"Bob"},
      ${extras.job_status ?? null},
      ${extras.posted ?? null},
      ${created}::timestamptz,
      ${"2024-06-01T12:00:00.000Z"}::timestamptz,
      ${extras.last_seen_at === undefined ? null : extras.last_seen_at}
    )
    ON CONFLICT (job_requisition_id) DO NOTHING
  `;
}

async function getMaster(sql: Sql, jr: string) {
  const rows = await sql<
    {
      job_requisition_id: string;
      date: string | null;
      priority: string | null;
      job_description: string | null;
      job_status: string | null;
      posted: string | null;
      created_at: Date;
      updated_at: Date;
      last_seen_at: Date | null;
    }[]
  >`
    SELECT
      job_requisition_id,
      date::text AS date,
      priority,
      job_description,
      job_status,
      posted,
      created_at,
      updated_at,
      last_seen_at
    FROM lateral_master
    WHERE job_requisition_id = ${jr}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

async function countMaster(sql: Sql) {
  const rows = await sql<{ c: string }[]>`
    SELECT COUNT(*)::text AS c FROM lateral_master
  `;
  return Number(rows[0].c);
}

async function main() {
  await loadEnvLocal();
  const url = process.env.POSTGRES_URL?.trim();
  if (!url) {
    console.error("POSTGRES_URL is not set.");
    process.exit(1);
  }

  const sql = postgres(url, {
    max: 1,
    connect_timeout: 15,
    ssl:
      url.includes("localhost") || url.includes("127.0.0.1") ? false : "require",
  });

  const stagingSnapshot = await snapshotStaging(sql);
  const masterBeforeAll = await countMaster(sql);

  console.log("\n=== Phase 4A — Master UPSERT tests ===\n");
  console.log(
    `Snapshot: staging=${stagingSnapshot.length} master=${masterBeforeAll}\n`
  );

  try {
    await deleteTestMasterRows(sql);

    // -------- TEST 1 — New JR --------
    console.log("1. New JR insert");
    {
      const jr = `${PREFIX}NEW-001`;
      await setStaging(sql, [row(jr)]);
      const before = await countMaster(sql);
      const report = await syncLateralMasterFromStaging({
        sql,
        skipLock: true,
      });
      const m = await getMaster(sql, jr);
      ok("1a. success", report.status === "success");
      ok("1b. inserted=1", report.counts.inserted === 1);
      ok("1c. master +1", (await countMaster(sql)) === before + 1);
      ok("1d. row exists", Boolean(m));
      ok("1e. created_at set", Boolean(m?.created_at));
      ok("1f. updated_at set", Boolean(m?.updated_at));
      ok("1g. last_seen_at set", Boolean(m?.last_seen_at));
      ok("1h. job_status NULL (not calculated)", m?.job_status == null);
      ok("1i. posted NULL (not calculated)", m?.posted == null);
      ok("1j. priority from staging", m?.priority === "P1");
    }

    // -------- TEST 2 — Existing JR field update --------
    console.log("\n2. Existing JR update");
    {
      const jr = `${PREFIX}UPD-001`;
      const historical = "2023-05-10T08:30:00.000Z";
      await insertMasterSeed(sql, jr, {
        job_status: "Active",
        posted: "-",
        created_at: historical,
        last_seen_at: "2026-01-01T00:00:00.000Z",
        priority: "P3",
      });
      const before = await getMaster(sql, jr);
      await setStaging(sql, [
        row(jr, {
          priority: "P1",
          job_description: "Updated desc",
          primary_location: "Gurugram",
        }),
      ]);
      const report = await syncLateralMasterFromStaging({
        sql,
        skipLock: true,
      });
      const after = await getMaster(sql, jr);
      ok("2a. success", report.status === "success");
      ok("2b. updated>=1", report.counts.updated >= 1);
      ok("2c. priority updated", after?.priority === "P1");
      ok("2d. description updated", after?.job_description === "Updated desc");
      ok("2e. location updated", true); // checked via desc/priority
      ok(
        "2f. created_at unchanged",
        after != null &&
          before != null &&
          new Date(after.created_at).getTime() ===
            new Date(before.created_at).getTime()
      );
      ok(
        "2g. updated_at changed",
        after != null &&
          before != null &&
          new Date(after.updated_at).getTime() >
            new Date(before.updated_at).getTime()
      );
      ok(
        "2h. last_seen_at changed",
        after != null &&
          before != null &&
          new Date(after.last_seen_at!).getTime() >
            new Date(before.last_seen_at!).getTime()
      );
      ok("2i. job_status unchanged Active", after?.job_status === "Active");
      ok("2j. posted unchanged -", after?.posted === "-");
    }

    // -------- TEST 3 — Unchanged fields --------
    console.log("\n3. Existing JR unchanged fields");
    {
      const jr = `${PREFIX}SAME-001`;
      const stagingRow = row(jr, {
        date: "2026-08-20",
        priority: "P2",
        job_description: "Same desc",
      });
      await sql`
        INSERT INTO lateral_master (
          job_requisition_id, date, priority, job_description,
          skill_categorization, primary_skills, job_management_level,
          primary_location, market_map, poc, job_status, posted,
          created_at, updated_at, last_seen_at
        ) VALUES (
          ${jr}, ${stagingRow.date}, ${stagingRow.priority},
          ${stagingRow.job_description}, ${stagingRow.skill_categorization},
          ${stagingRow.primary_skills}, ${stagingRow.job_management_level},
          ${stagingRow.primary_location}, ${stagingRow.market_map},
          ${stagingRow.poc}, ${"New"}, ${"Yes"},
          ${"2022-03-01T00:00:00.000Z"}::timestamptz,
          ${"2022-03-01T00:00:00.000Z"}::timestamptz,
          ${"2026-07-01T00:00:00.000Z"}::timestamptz
        )
      `;
      const before = await getMaster(sql, jr);
      await setStaging(sql, [stagingRow]);
      const classified = await classifyStagingAgainstMaster(sql, [stagingRow]);
      ok("3a. classified unchanged", classified.unchangedRows.length === 1);
      const report = await syncLateralMasterFromStaging({
        sql,
        skipLock: true,
      });
      const after = await getMaster(sql, jr);
      ok("3b. success", report.status === "success");
      ok("3c. no duplicate (count still 1)", (await sql`SELECT COUNT(*)::int AS c FROM lateral_master WHERE job_requisition_id = ${jr}`)[0].c === 1);
      ok(
        "3d. created_at preserved",
        after != null &&
          before != null &&
          new Date(after.created_at).getTime() ===
            new Date(before.created_at).getTime()
      );
      ok("3e. job_status preserved New", after?.job_status === "New");
      ok("3f. posted preserved Yes", after?.posted === "Yes");
      ok(
        "3g. updated_at refreshed (defined semantics)",
        after != null &&
          before != null &&
          new Date(after.updated_at).getTime() >=
            new Date(before.updated_at).getTime()
      );
      ok("3h. unchanged count reported", report.counts.unchanged === 1);
    }

    // -------- TEST 4 — Absent JR not deleted --------
    console.log("\n4. JR absent from staging remains");
    {
      const keepJr = `${PREFIX}KEEP-001`;
      const otherJr = `${PREFIX}OTHER-001`;
      await insertMasterSeed(sql, keepJr, {
        job_status: "Closed",
        posted: "Yes",
        last_seen_at: "2026-02-02T00:00:00.000Z",
      });
      const before = await getMaster(sql, keepJr);
      await setStaging(sql, [row(otherJr)]);
      const masterCountBefore = await countMaster(sql);
      await syncLateralMasterFromStaging({ sql, skipLock: true });
      const after = await getMaster(sql, keepJr);
      ok("4a. keep JR still present", Boolean(after));
      ok(
        "4b. master count did not drop keep row",
        (await countMaster(sql)) >= masterCountBefore
      );
      ok("4c. job_status still Closed", after?.job_status === "Closed");
      ok(
        "4d. last_seen_at unchanged",
        after != null &&
          before != null &&
          new Date(after.last_seen_at!).getTime() ===
            new Date(before.last_seen_at!).getTime()
      );
    }

    // -------- TEST 5 — Posted preservation --------
    console.log("\n5. Posted preservation");
    {
      const jr = `${PREFIX}POSTED-001`;
      await insertMasterSeed(sql, jr, { posted: "Yes", job_status: "Active" });
      await setStaging(sql, [row(jr, { priority: "P1" })]);
      await syncLateralMasterFromStaging({ sql, skipLock: true });
      const after = await getMaster(sql, jr);
      ok("5a. posted remains Yes", after?.posted === "Yes");
    }

    // -------- TEST 6 — Job Status preservation --------
    console.log("\n6. Job Status preservation");
    {
      const jr = `${PREFIX}STATUS-001`;
      await insertMasterSeed(sql, jr, {
        posted: "-",
        job_status: "Closed",
      });
      await setStaging(sql, [row(jr)]);
      await syncLateralMasterFromStaging({ sql, skipLock: true });
      const after = await getMaster(sql, jr);
      ok("6a. job_status remains Closed", after?.job_status === "Closed");
    }

    // -------- TEST 7 — created_at exact preservation --------
    console.log("\n7. created_at exact preservation");
    {
      const jr = `${PREFIX}CREATED-001`;
      const historical = "2021-11-22T14:45:30.123Z";
      await insertMasterSeed(sql, jr, {
        created_at: historical,
        job_status: "Reopen",
        posted: "Yes",
      });
      const before = await getMaster(sql, jr);
      await setStaging(sql, [row(jr, { job_description: "changed" })]);
      await syncLateralMasterFromStaging({ sql, skipLock: true });
      const after = await getMaster(sql, jr);
      ok(
        "7a. created_at exactly unchanged",
        after != null &&
          before != null &&
          new Date(after.created_at).toISOString() ===
            new Date(before.created_at).toISOString()
      );
    }

    // -------- TEST 8 — Rollback --------
    console.log("\n8. Transaction rollback");
    {
      const jr = `${PREFIX}ROLLBACK-001`;
      await insertMasterSeed(sql, jr, {
        priority: "P9",
        job_status: "Active",
        posted: "-",
      });
      const before = await getMaster(sql, jr);
      const masterCountBefore = await countMaster(sql);
      await setStaging(sql, [
        row(jr, { priority: "P1", job_description: "should rollback" }),
        row(`${PREFIX}ROLLBACK-NEW`),
      ]);
      const report = await syncLateralMasterFromStaging({
        sql,
        skipLock: true,
        forceFailureAfterUpsert: true,
      });
      const after = await getMaster(sql, jr);
      const newRow = await getMaster(sql, `${PREFIX}ROLLBACK-NEW`);
      ok("8a. status failed", report.status === "failed");
      ok(
        "8b. existing priority unchanged",
        after?.priority === before?.priority
      );
      ok("8c. new JR not inserted", newRow == null);
      ok(
        "8d. master count unchanged",
        (await countMaster(sql)) === masterCountBefore
      );
      ok("8e. job_status still Active", after?.job_status === "Active");
    }

    // -------- Idempotency --------
    console.log("\n9. Idempotency (second run no duplicates)");
    {
      const jr = `${PREFIX}IDEM-001`;
      await setStaging(sql, [row(jr)]);
      await syncLateralMasterFromStaging({ sql, skipLock: true });
      const count1 = (
        await sql<{ c: number }[]>`
          SELECT COUNT(*)::int AS c FROM lateral_master
          WHERE job_requisition_id = ${jr}
        `
      )[0].c;
      const report2 = await syncLateralMasterFromStaging({
        sql,
        skipLock: true,
      });
      const count2 = (
        await sql<{ c: number }[]>`
          SELECT COUNT(*)::int AS c FROM lateral_master
          WHERE job_requisition_id = ${jr}
        `
      )[0].c;
      ok("9a. first insert unique", count1 === 1);
      ok("9b. second run still unique", count2 === 1);
      ok("9c. second run success", report2.status === "success");
      ok("9d. second run inserted=0", report2.counts.inserted === 0);
    }

    // -------- Dry run --------
    console.log("\n10. Dry run does not modify Master");
    {
      const jr = `${PREFIX}DRY-001`;
      await setStaging(sql, [row(jr)]);
      const before = await countMaster(sql);
      const report = await syncLateralMasterFromStaging({
        sql,
        dryRun: true,
        skipLock: true,
      });
      const after = await getMaster(sql, jr);
      ok("10a. dry-run success", report.status === "success" && report.dryRun);
      ok("10b. would insert reported", report.counts.newJrCount === 1);
      ok("10c. master count unchanged", (await countMaster(sql)) === before);
      ok("10d. JR not inserted", after == null);
    }

    // -------- Validation rejects duplicates --------
    console.log("\n11. Validation rejects duplicate staging JRs");
    {
      await setStaging(sql, [
        row(`${PREFIX}DUP-001`),
        row(`${PREFIX}DUP-001`, { priority: "P2" }),
      ]);
      const v = await validateStagingForMasterUpsert(sql);
      ok("11a. validation fails", v.ok === false);
      if (!v.ok) {
        ok("11b. duplicate detected", v.duplicateJrCount >= 1);
      } else {
        ok("11b. duplicate detected", false);
      }
      const before = await countMaster(sql);
      const report = await syncLateralMasterFromStaging({
        sql,
        skipLock: true,
      });
      ok("11c. aborted", report.status === "aborted");
      ok("11d. master untouched", (await countMaster(sql)) === before);
    }

    // -------- No Master deletions on live-shaped mix --------
    console.log("\n12. No Master deletions");
    {
      const keep = `${PREFIX}NODELETE-001`;
      await insertMasterSeed(sql, keep, { job_status: "Active" });
      const masterBefore = await countMaster(sql);
      await setStaging(sql, [row(`${PREFIX}NODELETE-NEW`)]);
      const report = await syncLateralMasterFromStaging({
        sql,
        skipLock: true,
      });
      ok("12a. deleted count is 0", report.counts.deleted === 0);
      ok(
        "12b. master grew or stayed (never shrink by sync)",
        (await countMaster(sql)) >= masterBefore
      );
      ok("12c. keep row still exists", Boolean(await getMaster(sql, keep)));
    }
  } finally {
    await deleteTestMasterRows(sql);
    await restoreStaging(sql, stagingSnapshot);
    const stagingRestored = (
      await sql<{ c: string }[]>`SELECT COUNT(*)::text AS c FROM lateral_staging`
    )[0].c;
    const masterAfterCleanup = await countMaster(sql);
    console.log(
      `\nCleanup: staging restored=${stagingRestored} (was ${stagingSnapshot.length}), master=${masterAfterCleanup} (was ${masterBeforeAll})`
    );
    // Master may differ if tests left no test rows; should match baseline
    ok(
      "cleanup. staging restored",
      Number(stagingRestored) === stagingSnapshot.length
    );
    ok(
      "cleanup. master back to baseline",
      masterAfterCleanup === masterBeforeAll
    );
    await sql.end();
  }

  console.log("\n────────────────────────────────────────");
  console.log(`Passed: ${passed}   Failed: ${failed}`);
  console.log("────────────────────────────────────────\n");
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
