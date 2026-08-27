/**
 * Phase 3 / 3A CLI: ATCI DS → PostgreSQL lateral_staging
 *
 * Manual / test path (local file):
 *   npm run db:import-lateral-staging -- --file "path\to\adhoc.xlsx"
 *
 * Production-style path (existing Gmail/Drive → staging):
 *   npm run db:import-lateral-staging -- --from-gmail
 *   npm run db:import-lateral-staging -- --from-gmail --latest-only
 *
 * Or: npx tsx scripts/run-phase3a-live-gmail.ts
 *
 * Env:
 *   ARA_LATERAL_ATCI_DS_PATH — optional default workbook path (--file mode)
 *   POSTGRES_URL — required
 *
 * Does NOT modify lateral_master, Job Status, Posted, P-Roles, Dashboard, or Run All.
 */

import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import postgres from "postgres";
import {
  importAtciDsWorkbookToStaging,
} from "../src/services/lateral-processing/lateral-staging-import";
import {
  executeLateralGmailStagingJob,
  printLateralGmailStagingJobReport,
} from "../src/services/lateral-processing/lateral-gmail-staging-job";

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
  let file = "";
  let dryRun = false;
  let fromGmail = false;
  let latestOnly = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--dry-run") dryRun = true;
    else if (a === "--from-gmail") fromGmail = true;
    else if (a === "--latest-only") latestOnly = true;
    else if (a === "--file" || a === "-f") {
      file = argv[i + 1] ?? "";
      i += 1;
    } else if (!a.startsWith("-") && !file) {
      file = a;
    }
  }
  return { file, dryRun, fromGmail, latestOnly };
}

function resolveSourcePath(cliFile: string): string | null {
  const candidates = [
    cliFile.trim(),
    process.env.ARA_LATERAL_ATCI_DS_PATH?.trim() || "",
  ].filter(Boolean);

  for (const c of candidates) {
    const resolved = path.resolve(c);
    if (existsSync(resolved)) return resolved;
  }
  return null;
}

async function main() {
  await loadEnvLocal();
  const { file, dryRun, fromGmail, latestOnly } = parseArgs(process.argv.slice(2));

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
    if (fromGmail) {
      const report = await executeLateralGmailStagingJob({
        sql,
        dryRun,
        latestOnly,
      });
      printLateralGmailStagingJobReport(report);
      if (report.status === "failed") process.exitCode = 1;
      return;
    }

    const workbookPath = resolveSourcePath(file);
    if (!workbookPath) {
      console.error(
        [
          "ATCI DS source workbook not found.",
          "Pass --file <path>, set ARA_LATERAL_ATCI_DS_PATH, or use --from-gmail.",
          "Daily Adhoc DS filenames change — do not rely on a hardcoded path.",
        ].join("\n")
      );
      process.exitCode = 1;
      return;
    }

    const report = await importAtciDsWorkbookToStaging({
      sql,
      workbookPath,
      dryRun,
    });
    if (report.status !== "success") process.exitCode = 1;
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
