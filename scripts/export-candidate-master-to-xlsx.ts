/**
 * One-off export: candidate_master (Postgres) -> a new .xlsx file.
 *
 * Read-only against Postgres. Never touches the original source workbook
 * or any application table other than a SELECT from candidate_master.
 *
 * Column order matches CANDIDATE_MASTER_EXCEL_HEADERS (the same order the
 * dashboard's Candidate Master Sheet page uses), sourced by db column name
 * from CANDIDATE_MASTER_COLUMN_MAP so the mapping never drifts from the
 * dashboard's own contract.
 *
 * Usage: POSTGRES_URL=... npx tsx scripts/export-candidate-master-to-xlsx.ts [outputPath]
 */
import path from "node:path";
import fs from "node:fs/promises";
import ExcelJS from "exceljs";
import postgres from "postgres";
import {
  CANDIDATE_MASTER_COLUMN_MAP,
  CANDIDATE_MASTER_EXCEL_HEADERS,
} from "../src/services/persistence/candidate-master-sheet-columns";

const DEFAULT_OUTPUT_PATH = path.join(
  process.cwd(),
  "data",
  "excel",
  "ATCI Candidate Master Data - Cleaned.xlsx"
);

function getDb() {
  const url = process.env.POSTGRES_URL?.trim();
  if (!url) {
    throw new Error(
      "POSTGRES_URL is not set. Provide it in the environment or .env.local."
    );
  }
  return postgres(url, {
    max: 1,
    connect_timeout: 15,
    idle_timeout: 20,
    prepare: false,
    ssl: url.includes("localhost") || url.includes("127.0.0.1") ? false : "require",
  });
}

async function main() {
  const outputPath = path.resolve(process.argv[2] || DEFAULT_OUTPUT_PATH);

  const sourcePath = path.join(
    process.cwd(),
    "data",
    "excel",
    "ATCI Candidate Master Data.xlsx"
  );
  if (path.resolve(outputPath) === path.resolve(sourcePath)) {
    throw new Error(
      `Refusing to overwrite the original source workbook (${sourcePath}). Choose a different output path.`
    );
  }

  const sql = getDb();
  try {
    const dbColumns = CANDIDATE_MASTER_COLUMN_MAP.map((m) => m.dbColumn);
    const selectList = dbColumns.join(", ");

    console.log(`Reading candidate_master (ORDER BY id) ...`);
    const rows = await sql.unsafe(
      `SELECT ${selectList} FROM candidate_master ORDER BY id`
    );
    console.log(`Read ${rows.length} row(s) from candidate_master.`);

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("ATCI");

    sheet.addRow([...CANDIDATE_MASTER_EXCEL_HEADERS]);
    for (const row of rows) {
      sheet.addRow(dbColumns.map((col) => row[col as keyof typeof row] ?? ""));
    }

    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await workbook.xlsx.writeFile(outputPath);

    console.log(`Wrote ${rows.length} row(s) + 1 header row to:`);
    console.log(`  ${outputPath}`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error("Export failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
