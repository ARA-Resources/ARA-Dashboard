/**
 * Phase 4A safety snapshot before live Master UPSERT (read-only).
 */
import fs from "node:fs/promises";
import path from "node:path";
import postgres from "postgres";

async function loadEnvLocal() {
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
}

async function main() {
  await loadEnvLocal();
  const url = process.env.POSTGRES_URL!;
  const sql = postgres(url, {
    max: 1,
    ssl: url.includes("localhost") || url.includes("127.0.0.1") ? false : "require",
  });

  const stamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .slice(0, 19);
  const dir = path.join(
    process.cwd(),
    ".data",
    "phase4a-safety-snapshots",
    stamp
  );
  await fs.mkdir(dir, { recursive: true });

  const masterCount = Number(
    (await sql<{ c: string }[]>`SELECT COUNT(*)::text AS c FROM lateral_master`)[0]
      .c
  );
  const stagingCount = Number(
    (await sql<{ c: string }[]>`SELECT COUNT(*)::text AS c FROM lateral_staging`)[0]
      .c
  );

  const samples = await sql`
    SELECT
      job_requisition_id,
      date::text AS date,
      priority,
      job_status,
      posted,
      created_at,
      updated_at,
      last_seen_at
    FROM lateral_master
    ORDER BY created_at ASC NULLS LAST
    LIMIT 15
  `;

  const statusDist = await sql`
    SELECT job_status, COUNT(*)::int AS c
    FROM lateral_master
    GROUP BY job_status
    ORDER BY c DESC
  `;

  const postedDist = await sql`
    SELECT posted, COUNT(*)::int AS c
    FROM lateral_master
    GROUP BY posted
    ORDER BY c DESC
  `;

  const overlap = await sql<{ c: string }[]>`
    SELECT COUNT(*)::text AS c
    FROM lateral_staging s
    INNER JOIN lateral_master m
      ON m.job_requisition_id = s.job_requisition_id
  `;

  const meta = {
    createdAt: new Date().toISOString(),
    purpose: "Phase 4A safety snapshot before live staging→master UPSERT",
    masterCount,
    stagingCount,
    stagingJrsAlreadyInMaster: Number(overlap[0].c),
    stagingJrsNewEstimate: stagingCount - Number(overlap[0].c),
    statusDist,
    postedDist,
    sampleExistingJrs: samples,
    note: "No Excel export. PostgreSQL is the Master store. No DELETE.",
  };

  await fs.writeFile(
    path.join(dir, "SNAPSHOT.json"),
    JSON.stringify(meta, null, 2),
    "utf8"
  );

  console.log(JSON.stringify({ snapshotDir: dir, ...meta, sampleExistingJrs: `(${samples.length} rows in file)` }, null, 2));
  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
