/**
 * Phase 4A CLI: lateral_staging → lateral_master field UPSERT
 *
 *   npm run db:sync-lateral-master
 *   npm run db:sync-lateral-master -- --dry-run
 *
 * Does NOT implement Job Status, Posted, P-Roles, Dashboard, Gmail, or Run All.
 */

import fs from "node:fs/promises";
import path from "node:path";
import postgres from "postgres";
import {
  printLateralMasterUpsertReport,
  syncLateralMasterFromStaging,
} from "../src/services/lateral-processing/lateral-master-upsert";

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

function parseArgs(argv: string[]) {
  let dryRun = false;
  for (const a of argv) {
    if (a === "--dry-run") dryRun = true;
  }
  return { dryRun };
}

async function main() {
  await loadEnvLocal();
  const { dryRun } = parseArgs(process.argv.slice(2));

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

  try {
    const report = await syncLateralMasterFromStaging({ sql, dryRun });
    printLateralMasterUpsertReport(report);
    if (report.status === "failed" || report.status === "aborted" || report.status === "busy") {
      process.exitCode = 1;
    }
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
