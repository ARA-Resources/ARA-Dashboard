/**
 * One-off validation for migration 003 (Lateral Master + Staging).
 * Not part of the app — delete after use if desired.
 */
import fs from "node:fs/promises";
import path from "node:path";
import postgres from "postgres";

async function loadEnvLocal() {
  const envPath = path.join(process.cwd(), ".env.local");
  const content = await fs.readFile(envPath, "utf8");
  for (const line of content.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 1) continue;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (k && !(k in process.env)) process.env[k] = v;
  }
}

async function main() {
  await loadEnvLocal();
  const url = process.env.POSTGRES_URL?.trim();
  if (!url) throw new Error("POSTGRES_URL missing");

  const sql = postgres(url, {
    max: 1,
    ssl:
      url.includes("localhost") || url.includes("127.0.0.1") ? false : "require",
  });

  const expectedMaster = [
    "job_requisition_id",
    "date",
    "priority",
    "job_description",
    "skill_categorization",
    "primary_skills",
    "job_management_level",
    "primary_location",
    "market_map",
    "poc",
    "job_status",
    "posted",
    "created_at",
    "updated_at",
    "last_seen_at",
  ];
  const forbidden = [
    "closed_at",
    "reopened_at",
    "posted_date",
    "status_history",
    "reopen_count",
    "team_auto",
    "team_manual",
    "team_lead",
    "members",
    "opened_on_oorwin",
  ];

  let failed = 0;
  const check = (name, cond, detail) => {
    if (cond) console.log(`  PASS  ${name}`);
    else {
      failed += 1;
      console.error(`  FAIL  ${name}${detail ? " — " + detail : ""}`);
    }
  };

  console.log("=== TABLES ===");
  const tables = await sql`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `;
  const have = new Set(tables.map((t) => t.table_name));
  check("lateral_master exists", have.has("lateral_master"));
  check("lateral_staging exists", have.has("lateral_staging"));

  console.log("\n=== lateral_master COLUMNS ===");
  const masterCols = await sql`
    SELECT column_name, data_type, udt_name, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'lateral_master'
    ORDER BY ordinal_position
  `;
  for (const c of masterCols) {
    console.log(
      `  ${c.column_name.padEnd(24)} ${String(c.data_type).padEnd(20)} null=${c.is_nullable} default=${c.column_default ?? ""}`
    );
  }
  const masterNames = masterCols.map((c) => c.column_name);
  check(
    "all expected Master columns present",
    expectedMaster.every((c) => masterNames.includes(c)),
    `missing=${expectedMaster.filter((c) => !masterNames.includes(c)).join(",")}`
  );
  check(
    "no extra Master columns",
    masterNames.every((c) => expectedMaster.includes(c)),
    `extra=${masterNames.filter((c) => !expectedMaster.includes(c)).join(",")}`
  );
  check(
    "no forbidden Master columns",
    !masterNames.some((c) => forbidden.includes(c))
  );

  const typeOf = (name) =>
    masterCols.find((c) => c.column_name === name)?.udt_name;
  check("job_requisition_id is text", typeOf("job_requisition_id") === "text");
  check("date is date", typeOf("date") === "date");
  check("created_at is timestamptz", typeOf("created_at") === "timestamptz");
  check("updated_at is timestamptz", typeOf("updated_at") === "timestamptz");
  check("last_seen_at is timestamptz", typeOf("last_seen_at") === "timestamptz");
  check("posted is text", typeOf("posted") === "text");
  check("job_status is text", typeOf("job_status") === "text");

  console.log("\n=== lateral_staging COLUMNS ===");
  const stagingCols = await sql`
    SELECT column_name, data_type, udt_name, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'lateral_staging'
    ORDER BY ordinal_position
  `;
  for (const c of stagingCols) {
    console.log(
      `  ${c.column_name.padEnd(24)} ${String(c.data_type).padEnd(20)} null=${c.is_nullable} default=${c.column_default ?? ""}`
    );
  }
  const stagingNames = stagingCols.map((c) => c.column_name);
  check("staging has no job_status", !stagingNames.includes("job_status"));
  check("staging has job_requisition_id", stagingNames.includes("job_requisition_id"));
  check("staging has operational id", stagingNames.includes("id"));

  console.log("\n=== CONSTRAINTS / INDEXES ===");
  const idxs = await sql`
    SELECT tablename, indexname, indexdef
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename IN ('lateral_master', 'lateral_staging')
    ORDER BY tablename, indexname
  `;
  for (const i of idxs) {
    console.log(`  ${i.tablename}.${i.indexname}`);
    console.log(`    ${i.indexdef}`);
  }
  const indexNames = idxs.map((i) => i.indexname);
  check("PK index on master", indexNames.includes("lateral_master_pkey"));
  check("idx job_status", indexNames.includes("idx_lateral_master_job_status"));
  check("idx posted", indexNames.includes("idx_lateral_master_posted"));
  check("idx last_seen_at", indexNames.includes("idx_lateral_master_last_seen_at"));
  check(
    "idx staging JR",
    indexNames.includes("idx_lateral_staging_job_requisition_id")
  );

  console.log("\n=== UNIQUENESS / CHECK SMOKE ===");
  await sql`DELETE FROM lateral_master WHERE job_requisition_id = 'TEST-JR-003'`;
  await sql`
    INSERT INTO lateral_master (job_requisition_id, job_status, posted)
    VALUES ('TEST-JR-003', 'New', '-')
  `;
  let dupRejected = false;
  try {
    await sql`
      INSERT INTO lateral_master (job_requisition_id, job_status, posted)
      VALUES ('TEST-JR-003', 'Active', 'Yes')
    `;
  } catch (e) {
    dupRejected = e.code === "23505";
  }
  check("duplicate job_requisition_id rejected", dupRejected);

  let badPostedRejected = false;
  try {
    await sql`
      UPDATE lateral_master SET posted = 'Maybe' WHERE job_requisition_id = 'TEST-JR-003'
    `;
  } catch (e) {
    badPostedRejected = e.code === "23514";
  }
  check("invalid posted value rejected", badPostedRejected);

  let badStatusRejected = false;
  try {
    await sql`
      UPDATE lateral_master SET job_status = 'Pending' WHERE job_requisition_id = 'TEST-JR-003'
    `;
  } catch (e) {
    badStatusRejected = e.code === "23514";
  }
  check("invalid job_status value rejected", badStatusRejected);

  await sql`DELETE FROM lateral_master WHERE job_requisition_id = 'TEST-JR-003'`;

  console.log("\n=== EXISTING APP TABLES ===");
  for (const t of [
    "gmail_checkpoint",
    "app_config",
    "lateral_scheduler_state",
    "oauth_state",
    "schema_migrations",
    "home_metrics",
    "lateral_sync_history",
  ]) {
    check(`${t} still present`, have.has(t));
  }

  const mig = await sql`
    SELECT version, description FROM schema_migrations WHERE version = '003'
  `;
  check("schema_migrations has 003", mig.length === 1);

  // Re-run migrate idempotency is covered by IF NOT EXISTS; smoke query:
  const counts = await sql`
    SELECT
      (SELECT COUNT(*)::int FROM lateral_master) AS master_rows,
      (SELECT COUNT(*)::int FROM lateral_staging) AS staging_rows
  `;
  console.log("\n=== ROW COUNTS (expect 0 before import) ===", counts[0]);

  await sql.end();
  console.log(`\nValidation finished. Failed=${failed}`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
