/**
 * PURE ADDITIVE insert: Lateral Master Sheet file → PostgreSQL `lateral_master`.
 *
 * For every row in the source file:
 *   - job_requisition_id already in lateral_master → SKIPPED. Nothing about
 *     that existing row (job_status, posted, created_at, any column) is
 *     ever read for a write, let alone written.
 *   - job_requisition_id not in lateral_master → INSERTED, with
 *     created_at/updated_at = now() and last_seen_at = NULL (same
 *     convention as the one-time backfill, `import-lateral-master-to-postgres.ts`).
 *
 * This is a different code path from the TRUNCATE-based `--replace` tool in
 * `import-lateral-master-from-xlsx.ts` — no TRUNCATE, no UPDATE/UPSERT of
 * any kind, ever. All inserts for an --execute run happen in one
 * transaction (`sql.begin`), so a mid-run failure rolls back cleanly — the
 * earlier investigation flagged `--replace`'s TRUNCATE+insert as NOT being
 * wrapped this way; this script fixes that for the additive path.
 *
 * The primary key (`job_requisition_id`) is TEXT, not SERIAL — there is no
 * sequence to reset or worry about, confirmed again at runtime below.
 *
 * Column mapping is name-based, from `LATERAL_MASTER_COLUMN_MAP` (the same
 * mapping the dashboard, export, and pipeline all use) — never by position.
 *
 * Usage:
 *   npx tsx scripts/lateral-master-additive-import.ts --file <path.xlsm> --dry-run
 *   npx tsx scripts/lateral-master-additive-import.ts --file <path.xlsm> --execute --confirm-insert=<N>
 *   npm run db:lateral-master-additive-import -- --file <path.xlsm> --dry-run
 *
 * --dry-run performs zero writes (not even a transaction is opened).
 *
 * --execute requires --confirm-insert=<N> where <N> must equal the
 * would-insert count THIS run just computed live (not trusted from a prior
 * run/report) — a bare --execute, or one with a stale/wrong count, refuses
 * before opening any connection-level write. This is the only guard; there
 * is no separate "--dry-run-only" build — --dry-run (or omitting --execute)
 * is simply what happens when that confirmation isn't present.
 */
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { getDbClient, closeDbClient } from "../src/lib/persistence/db-client";
import { LATERAL_MASTER_COLUMN_MAP } from "../src/services/persistence/lateral-master-sheet-columns";
import {
  LATERAL_MASTER_SHEET_NAME,
  isAllowedJobStatus,
  isAllowedPosted,
  normalizeOptionalText,
  parseExcelDateToIso,
  mapMasterSheetHeaders,
  formatLateralPgDateDdMmYyyy,
  type AllowedJobStatus,
  type AllowedPosted,
  type HeaderMappingSuccess,
} from "../src/services/lateral-processing/lateral-master-pg-backfill";
// Reuse the existing, proven openpyxl-based XLSM extraction — same reader
// the one-time backfill script uses. Importing it does NOT run that
// script's own `main()` (guarded by an isDirectRun check on process.argv[1]).
import { extractMasterSheetRows } from "./import-lateral-master-to-postgres";

async function loadEnvLocal() {
  const envLocalPath = path.join(process.cwd(), ".env.local");
  try {
    const envContent = await fs.readFile(envLocalPath, "utf8");
    for (const line of envContent.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx < 1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
      if (key && !(key in process.env)) process.env[key] = val;
    }
  } catch {
    // optional
  }
}

export interface NewRow {
  excelRowNumber: number;
  job_requisition_id: string;
  date: string | null;
  priority: string | null;
  job_description: string | null;
  skill_categorization: string | null;
  primary_skills: string | null;
  job_management_level: string | null;
  primary_location: string | null;
  market_map: string | null;
  poc: string | null;
  job_status: AllowedJobStatus | null;
  posted: AllowedPosted | null;
  opened_on_oorwin: string | null;
}

interface InvalidRow {
  excelRowNumber: number;
  jobRequisitionId: string;
  reason: "missing_jr" | "duplicate_jr" | "invalid_date" | "invalid_job_status" | "invalid_posted";
  field: string;
  value: string;
}

function cellIsEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string" && value.trim() === "") return true;
  return false;
}

/**
 * Header candidates for the one field this file's backfill helper module
 * doesn't carry: `opened_on_oorwin` (the Master Sheet reconciliation path
 * never writes it, so `lateral-master-pg-backfill.ts` never needed it —
 * but a fresh additive INSERT is exactly the kind of write that should set
 * it from the file, same as the other two full-column import paths do).
 */
const OPENED_ON_OORWIN_CANDIDATES = ["Opened on Oorwin"];

function findOpenedOnOorwinIndex(headers: string[]): number {
  const trimmed = headers.map((h) => String(h ?? "").trim());
  for (const candidate of OPENED_ON_OORWIN_CANDIDATES) {
    const idx = trimmed.findIndex((h) => h === candidate);
    if (idx >= 0) return idx;
  }
  return -1;
}

/**
 * Validate + partition every data row into valid / invalid — unlike
 * `validateAndBuildBackfillRows` (used by the one-time backfill, which
 * aborts the ENTIRE import if even one row is bad), this additive import
 * must still insert the good rows and separately report the bad ones, per
 * the dry-run spec. Reuses the same per-field normalizers/validators as the
 * rest of the Lateral pipeline (`normalizeOptionalText`, `parseExcelDateToIso`,
 * `isAllowedJobStatus`, `isAllowedPosted`) so values are normalized exactly
 * the same way everywhere.
 */
export function validateAndPartitionRows(
  headers: string[],
  rawRows: unknown[][],
  mapping: HeaderMappingSuccess
): {
  validRows: NewRow[];
  invalidRows: InvalidRow[];
  skippedEmptyRows: number;
} {
  const idx = mapping.fieldToIndex;
  const oorwinIdx = findOpenedOnOorwinIndex(headers);

  const seen = new Map<string, number[]>();
  const provisional: NewRow[] = [];
  const invalidRows: InvalidRow[] = [];
  let skippedEmptyRows = 0;

  for (let i = 0; i < rawRows.length; i += 1) {
    const excelRowNumber = i + 2;
    const cells = rawRows[i] ?? [];

    if (cells.every((c) => cellIsEmpty(c))) {
      skippedEmptyRows += 1;
      continue;
    }

    const jrRaw = cells[idx.job_requisition_id];
    const jr =
      jrRaw === null || jrRaw === undefined
        ? ""
        : String(jrRaw).replace(/ /g, " ").trim();

    if (!jr) {
      invalidRows.push({
        excelRowNumber,
        jobRequisitionId: "",
        reason: "missing_jr",
        field: "job_requisition_id",
        value: "",
      });
      continue;
    }

    const list = seen.get(jr) ?? [];
    list.push(excelRowNumber);
    seen.set(jr, list);

    const dateResult = parseExcelDateToIso(cells[idx.date]);
    if (!dateResult.ok) {
      invalidRows.push({
        excelRowNumber,
        jobRequisitionId: jr,
        reason: "invalid_date",
        field: "date",
        value: dateResult.raw,
      });
      continue;
    }

    const statusText = normalizeOptionalText(cells[idx.job_status]);
    if (statusText !== null && !isAllowedJobStatus(statusText)) {
      invalidRows.push({
        excelRowNumber,
        jobRequisitionId: jr,
        reason: "invalid_job_status",
        field: "job_status",
        value: statusText,
      });
      continue;
    }

    const postedText = normalizeOptionalText(cells[idx.posted]);
    if (postedText !== null && !isAllowedPosted(postedText)) {
      invalidRows.push({
        excelRowNumber,
        jobRequisitionId: jr,
        reason: "invalid_posted",
        field: "posted",
        value: postedText,
      });
      continue;
    }

    provisional.push({
      excelRowNumber,
      job_requisition_id: jr,
      date: dateResult.iso,
      priority: normalizeOptionalText(cells[idx.priority]),
      job_description: normalizeOptionalText(cells[idx.job_description]),
      skill_categorization: normalizeOptionalText(cells[idx.skill_categorization]),
      primary_skills: normalizeOptionalText(cells[idx.primary_skills]),
      job_management_level: normalizeOptionalText(cells[idx.job_management_level]),
      primary_location: normalizeOptionalText(cells[idx.primary_location]),
      market_map: normalizeOptionalText(cells[idx.market_map]),
      poc: normalizeOptionalText(cells[idx.poc]),
      job_status: statusText as AllowedJobStatus | null,
      posted: postedText as AllowedPosted | null,
      opened_on_oorwin:
        oorwinIdx >= 0 ? normalizeOptionalText(cells[oorwinIdx]) : null,
    });
  }

  // Duplicate JR within the file: every row sharing that JR is invalid —
  // including ones that would otherwise have passed every other check.
  const duplicateJrs = new Set(
    [...seen.entries()].filter(([, rows]) => rows.length > 1).map(([jr]) => jr)
  );

  const validRows: NewRow[] = [];
  for (const row of provisional) {
    if (duplicateJrs.has(row.job_requisition_id)) {
      invalidRows.push({
        excelRowNumber: row.excelRowNumber,
        jobRequisitionId: row.job_requisition_id,
        reason: "duplicate_jr",
        field: "job_requisition_id",
        value: row.job_requisition_id,
      });
      continue;
    }
    validRows.push(row);
  }

  // Sort invalid rows by Excel row number for a readable report.
  invalidRows.sort((a, b) => a.excelRowNumber - b.excelRowNumber);

  return { validRows, invalidRows, skippedEmptyRows };
}

/**
 * The ONLY code path in this file that writes to `lateral_master`. Takes a
 * pre-validated, pre-filtered list of brand-new rows (callers are
 * responsible for the skip-existing filter — this function does not query
 * or filter against existing IDs itself, so it is also directly reusable
 * by a test harness that wants to exercise the transaction/rollback
 * behavior with a deliberately-synthetic row list, without touching or
 * re-implementing the real skip-existing logic above).
 *
 * Batches of `batchSize` (default 500, matching the existing one-time
 * backfill script's convention), ALL in one `sql.begin` transaction — a
 * Postgres-level error on any row in any batch (e.g. a PK violation that
 * slipped past this script's own app-level validation) aborts the entire
 * transaction, rolling back every batch already applied this run, not just
 * the failing one.
 */
export async function insertNewRowsInTransaction(
  sql: ReturnType<typeof getDbClient>,
  rows: NewRow[],
  batchSize = 500
): Promise<number> {
  await sql.begin(async (tx) => {
    for (let i = 0; i < rows.length; i += batchSize) {
      const batch = rows.slice(i, i + batchSize).map((r) => ({
        job_requisition_id: r.job_requisition_id,
        date: r.date,
        priority: r.priority,
        job_description: r.job_description,
        skill_categorization: r.skill_categorization,
        primary_skills: r.primary_skills,
        job_management_level: r.job_management_level,
        primary_location: r.primary_location,
        market_map: r.market_map,
        poc: r.poc,
        job_status: r.job_status,
        posted: r.posted,
        opened_on_oorwin: r.opened_on_oorwin,
        // created_at/updated_at: column defaults (NOW()) apply since they're
        // omitted here — matches "now() for new rows" without needing a
        // shared JS timestamp across batches.
        last_seen_at: null as string | null,
      }));
      await tx`INSERT INTO lateral_master ${tx(batch)}`;
    }
  });
  return rows.length;
}

async function main() {
  await loadEnvLocal();

  const args = process.argv.slice(2);
  const fileIdx = args.indexOf("--file");
  const filePath = fileIdx >= 0 ? args[fileIdx + 1] : undefined;
  const execute = args.includes("--execute");
  const confirmArg = args.find((a) => a.startsWith("--confirm-insert="));
  const confirmInsert = confirmArg ? Number(confirmArg.slice("--confirm-insert=".length)) : null;

  if (!filePath) {
    console.error(
      "Usage: tsx scripts/lateral-master-additive-import.ts --file <path.xlsm> [--dry-run | --execute --confirm-insert=<N>]"
    );
    process.exitCode = 1;
    return;
  }

  const resolvedPath = path.resolve(filePath);
  if (!existsSync(resolvedPath)) {
    console.error(`File not found: ${resolvedPath}`);
    process.exitCode = 1;
    return;
  }

  console.log(
    `========== LATERAL MASTER ADDITIVE IMPORT — ${execute ? "EXECUTE" : "DRY RUN"} ==========\n`
  );
  console.log(`Source file: ${resolvedPath}`);
  console.log(`Sheet: ${LATERAL_MASTER_SHEET_NAME}\n`);

  const extracted = await extractMasterSheetRows(resolvedPath, LATERAL_MASTER_SHEET_NAME);

  console.log(`Detected headers: ${extracted.headers.join(" | ")}`);
  console.log(`Total data rows read: ${extracted.rows.length}\n`);

  const mapping = mapMasterSheetHeaders(extracted.headers);
  if (!mapping.ok) {
    console.error("Header mapping failed:\n" + mapping.message);
    process.exitCode = 1;
    return;
  }

  // --- 4. Column mapping for review ---
  // `mapping.fieldToHeader` only covers lateral-master-pg-backfill.ts's own
  // field list, which excludes opened_on_oorwin (that module was built for
  // the Job-Status reconciliation path, which never writes that column).
  // This additive import DOES write it, resolved separately via
  // findOpenedOnOorwinIndex — handle it explicitly here so the report
  // doesn't misrepresent it as unmapped/ignored.
  const oorwinIdx = findOpenedOnOorwinIndex(extracted.headers);
  const oorwinHeaderFound = oorwinIdx >= 0 ? extracted.headers[oorwinIdx] : null;
  console.log("-- Column mapping (file header -> DB column) --");
  for (const m of LATERAL_MASTER_COLUMN_MAP) {
    if (m.dbColumn === "opened_on_oorwin") {
      console.log(
        `  "${oorwinHeaderFound ?? "(not found)"}" -> lateral_master.opened_on_oorwin`
      );
      continue;
    }
    const matchedHeader = mapping.fieldToHeader[m.dbColumn as keyof typeof mapping.fieldToHeader];
    console.log(
      `  "${matchedHeader ?? "(not found)"}" -> lateral_master.${m.dbColumn}`
    );
  }
  console.log(
    `  (no file column) -> lateral_master.created_at   [system: set to now() for new rows only]`
  );
  console.log(
    `  (no file column) -> lateral_master.updated_at   [system: set to now() for new rows only]`
  );
  console.log(
    `  (no file column) -> lateral_master.last_seen_at [system: left NULL for new rows, same convention as the one-time backfill script]`
  );
  const trulyIgnored = mapping.ignoredHeaders.filter((h) => h !== oorwinHeaderFound);
  if (trulyIgnored.length) {
    console.log(`  Ignored file columns (not imported): ${trulyIgnored.join(" | ")}`);
  }
  console.log("");

  const { validRows, invalidRows, skippedEmptyRows } = validateAndPartitionRows(
    extracted.headers,
    extracted.rows,
    mapping
  );

  // --- DB: current state ---
  const sql = getDbClient();
  try {
    const pkInfo = await sql<{ column_name: string; data_type: string }[]>`
      SELECT c.column_name, c.data_type
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
      JOIN information_schema.columns c
        ON c.table_name = tc.table_name AND c.column_name = kcu.column_name
      WHERE tc.table_name = 'lateral_master' AND tc.constraint_type = 'PRIMARY KEY'
    `;
    console.log("-- Primary key / sequence check --");
    for (const row of pkInfo) {
      console.log(`  PK column: ${row.column_name} (${row.data_type})`);
    }
    const hasSerial = pkInfo.some((r) => /serial|int/i.test(r.data_type));
    console.log(
      hasSerial
        ? "  WARNING: PK does not look like TEXT — re-verify before proceeding."
        : "  Confirmed: PK is TEXT, not SERIAL/integer. No sequence exists for lateral_master — nothing to reset."
    );
    console.log("");

    const existingRows = await sql<{ job_requisition_id: string }[]>`
      SELECT job_requisition_id FROM lateral_master
    `;
    const existingIds = new Set(existingRows.map((r) => r.job_requisition_id));

    const toInsert = validRows.filter((r) => !existingIds.has(r.job_requisition_id));
    const toSkip = validRows.filter((r) => existingIds.has(r.job_requisition_id));

    // --- 1, 2, 3 ---
    console.log("-- Counts --");
    console.log(`Total data rows in file: ${extracted.rows.length}`);
    console.log(`Skipped empty rows (blank in every column): ${skippedEmptyRows}`);
    console.log(`Invalid rows (would NOT be inserted, listed below): ${invalidRows.length}`);
    console.log(`Valid rows already in lateral_master (would be SKIPPED, untouched): ${toSkip.length}`);
    console.log(`Valid rows NOT in lateral_master (would be INSERTED): ${toInsert.length}`);
    const accountedFor =
      skippedEmptyRows + invalidRows.length + toSkip.length + toInsert.length;
    console.log(
      `Arithmetic check: ${skippedEmptyRows} + ${invalidRows.length} + ${toSkip.length} + ${toInsert.length} = ${accountedFor} (file data rows: ${extracted.rows.length}) -> ${
        accountedFor === extracted.rows.length ? "MATCHES" : "MISMATCH — investigate before proceeding"
      }`
    );
    console.log(
      `Current lateral_master count: ${existingIds.size}. Resulting total if executed: ${existingIds.size} + ${toInsert.length} = ${existingIds.size + toInsert.length}.`
    );
    console.log(
      `No existing row would be touched: ${toSkip.length} overlapping file rows are skip-only (no UPDATE path exists in this script).\n`
    );

    if (execute) {
      // Confirmation must match the count THIS run just computed — never
      // trusted from a prior report, so a stale/copy-pasted number refuses
      // just as loudly as a bare --execute would.
      if (confirmInsert === null || Number.isNaN(confirmInsert)) {
        console.error(
          `--execute requires --confirm-insert=<N>. This run computed ${toInsert.length} rows to insert — ` +
            `re-run with --confirm-insert=${toInsert.length} to proceed, or omit --execute for a dry run.`
        );
        process.exitCode = 1;
        return;
      }
      if (confirmInsert !== toInsert.length) {
        console.error(
          `--confirm-insert=${confirmInsert} does not match this run's live computed count of ${toInsert.length}. ` +
            `Refusing to write. Re-run with --confirm-insert=${toInsert.length} if that count is correct.`
        );
        process.exitCode = 1;
        return;
      }

      console.log(`Confirmed: --confirm-insert=${confirmInsert} matches the live computed count. Proceeding to insert.\n`);
      console.log("-- Inserting (single transaction, batches of 500) --");
      let inserted = 0;
      try {
        inserted = await insertNewRowsInTransaction(sql, toInsert, 500);
      } catch (err) {
        const countAfter = Number(
          (await sql<{ c: string }[]>`SELECT COUNT(*)::text AS c FROM lateral_master`)[0]?.c ?? "0"
        );
        console.error(
          `INSERT FAILED — transaction rolled back. lateral_master count after failure: ${countAfter} ` +
            `(should equal the before-count of ${existingIds.size} if rollback was clean).`
        );
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
        return;
      }
      const countAfter = Number(
        (await sql<{ c: string }[]>`SELECT COUNT(*)::text AS c FROM lateral_master`)[0]?.c ?? "0"
      );
      console.log(`Inserted: ${inserted}`);
      console.log(`lateral_master count before: ${existingIds.size}, after: ${countAfter}`);
      console.log("");

      console.log("-- Sample of up to 5 rows actually inserted (read back from DB) --");
      for (const row of toInsert.slice(0, 5)) {
        const dbRow = await sql`
          SELECT job_requisition_id, date::text AS date, priority, job_description,
                 skill_categorization, primary_skills, job_management_level,
                 primary_location, market_map, poc, job_status, posted,
                 opened_on_oorwin, created_at, updated_at, last_seen_at
          FROM lateral_master WHERE job_requisition_id = ${row.job_requisition_id}
        `;
        console.log(JSON.stringify(dbRow[0] ?? null, null, 2));
      }
      console.log("");
      console.log("-- Manual follow-ups (NOT automated by this script) --");
      console.log("  1. Refresh Home KPI cache (read-only against lateral_master): GET /api/home/widgets?refresh=1");
      console.log("  2. Update EXPECTED_MASTER_COUNT in scripts/verify-lateral-master-read-layer.ts to the new total.");
      console.log("\n========== END EXECUTE ==========");
      return;
    }

    // --- 5. Sample of 5 rows that would be inserted ---
    console.log("-- Sample of up to 5 rows that WOULD be inserted (full field values) --");
    for (const row of toInsert.slice(0, 5)) {
      console.log(JSON.stringify(
        {
          excelRowNumber: row.excelRowNumber,
          job_requisition_id: row.job_requisition_id,
          date: row.date,
          dateDisplay: formatLateralPgDateDdMmYyyy(row.date),
          priority: row.priority,
          job_description: row.job_description ? row.job_description.slice(0, 80) + (row.job_description.length > 80 ? "…" : "") : null,
          skill_categorization: row.skill_categorization,
          primary_skills: row.primary_skills,
          job_management_level: row.job_management_level,
          primary_location: row.primary_location,
          market_map: row.market_map,
          poc: row.poc,
          job_status: row.job_status,
          posted: row.posted,
          opened_on_oorwin: row.opened_on_oorwin,
          created_at: "now() [not yet executed]",
          updated_at: "now() [not yet executed]",
          last_seen_at: null,
        },
        null,
        2
      ));
    }
    console.log("");

    // --- 6. Invalid rows ---
    console.log(`-- Invalid rows (${invalidRows.length}) — NOT inserted, NOT guessed/fixed --`);
    if (invalidRows.length === 0) {
      console.log("  (none)");
    } else {
      for (const row of invalidRows.slice(0, 50)) {
        console.log(
          `  row ${row.excelRowNumber} JR="${row.jobRequisitionId}" reason=${row.reason} field=${row.field} value="${row.value}"`
        );
      }
      if (invalidRows.length > 50) {
        console.log(`  ... and ${invalidRows.length - 50} more`);
      }
    }
    console.log("");

    // --- 7. Confirm no side files touched ---
    console.log("-- Side-effect confirmation --");
    console.log("This run performed read-only queries only (information_schema + SELECT job_requisition_id).");
    console.log("No INSERT/UPDATE/DELETE/TRUNCATE was executed. No transaction was opened.");
    console.log(
      "EXPECTED_MASTER_COUNT in scripts/verify-lateral-master-read-layer.ts was NOT read or modified by this script " +
        "— updating it is a separate, manual follow-up after a real insert actually runs."
    );
    console.log("\n========== END DRY RUN ==========");
  } finally {
    await closeDbClient();
  }
}

// Guard against running main() when this module is only imported for its
// exported functions (e.g. by the rollback test harness, which imports
// `insertNewRowsInTransaction`/`validateAndPartitionRows` and must NOT also
// trigger this file's own CLI). Same pattern as `import-lateral-master-to-postgres.ts`.
const isDirectRun =
  process.argv[1] &&
  path.resolve(process.argv[1]).includes("lateral-master-additive-import");

if (isDirectRun) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
