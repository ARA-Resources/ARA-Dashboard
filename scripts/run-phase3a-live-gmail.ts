/**
 * Phase 3A live runner: Gmail → ATCI DS → lateral_staging
 *
 * Uses file-backed dataset setup / Gmail OAuth (dev-encrypted local store)
 * and PostgreSQL for staging rows.
 */
import fs from "node:fs/promises";
import path from "node:path";
import postgres from "postgres";
import {
  executeLateralGmailStagingJob,
  printLateralGmailStagingJobReport,
} from "../src/services/lateral-processing/lateral-gmail-staging-job";

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

  // Local .data/dataset-setup.enc.json was sealed with the development key.
  // Clear mismatched production secrets so decrypt falls back correctly.
  delete process.env.ARA_DATASET_SETUP_SECRET;
  delete process.env.ARA_SETUP_SECRET;
  process.env.ARA_PERSISTENCE = "file";

  const url = process.env.POSTGRES_URL?.trim();
  if (!url) {
    console.error("POSTGRES_URL is not set.");
    process.exitCode = 1;
    return;
  }

  const sql = postgres(url, {
    max: 1,
    connect_timeout: 15,
    ssl:
      url.includes("localhost") || url.includes("127.0.0.1") ? false : "require",
  });

  const masterBefore = Number(
    (await sql<{ c: string }[]>`SELECT COUNT(*)::text AS c FROM lateral_master`)[0]
      .c
  );
  const stagingBefore = Number(
    (await sql<{ c: string }[]>`SELECT COUNT(*)::text AS c FROM lateral_staging`)[0]
      .c
  );
  console.log(
    JSON.stringify({ masterBefore, stagingBefore, note: "live Gmail Phase 3A" })
  );

  try {
    const report = await executeLateralGmailStagingJob({
      sql,
      latestOnly: true,
    });
    printLateralGmailStagingJobReport(report);

    const masterAfter = Number(
      (
        await sql<{ c: string }[]>`SELECT COUNT(*)::text AS c FROM lateral_master`
      )[0].c
    );
    const stagingAfter = Number(
      (
        await sql<{ c: string }[]>`SELECT COUNT(*)::text AS c FROM lateral_staging`
      )[0].c
    );
    console.log(
      JSON.stringify({
        masterAfter,
        stagingAfter,
        masterUnchanged: masterBefore === masterAfter,
      })
    );

    if (report.status === "failed") process.exitCode = 1;
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
