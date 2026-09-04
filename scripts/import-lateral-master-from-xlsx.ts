/**
 * One-shot UPSERT: local Excel Master Sheet → PostgreSQL `lateral_master`.
 *
 * Source (repo-local only — never Google Drive):
 *   data/excel/ATCI Lateral Master Data Updated.xlsx
 *
 * Usage:
 *   npx tsx scripts/import-lateral-master-from-xlsx.ts
 *   npm run db:import-lateral-master-xlsx
 *
 * Optional:
 *   --file <path>     Override workbook path
 *   --dry-run         Validate + print report; no writes
 *   --replace         TRUNCATE lateral_master, then import (full replace from file)
 *   ARA_LATERAL_MASTER_XLSX_PATH  Override default path via env
 *
 * Behavior:
 *   - Reads Master Sheet tab (or first / Master-like sheet)
 *   - Maps EVERY Excel header → DB column (unmapped headers = hard fail)
 *   - Default: UPSERTs by job_requisition_id (update existing, insert new);
 *     does NOT delete rows absent from the file
 *   - --replace: TRUNCATE lateral_master RESTART IDENTITY CASCADE (or plain
 *     TRUNCATE), then insert all Excel rows so DB matches the file exactly
 *
 * Normalization (CHECK constraints only):
 *   - job_status: trim; empty→NULL; case-canonicalized to New|Reopen|Active|Closed
 *   - posted: trim; empty→NULL; "yes"→Yes; anything else non-empty that is not
 *     already "-" is rejected (must be Yes or -)
 *   - Job Description: stored exactly (no trim of inner whitespace)
 *   - opened_on_oorwin: free text as-is (trimmed only if entire cell empty→NULL)
 */

import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import postgres from "postgres";
import {
  LATERAL_MASTER_COLUMN_MAP,
  LATERAL_MASTER_EXCEL_HEADERS,
  type LateralMasterSheetDbColumn,
} from "../src/services/persistence/lateral-master-sheet-columns";

const execFileAsync = promisify(execFile);

const DEFAULT_XLSX = path.join(
  process.cwd(),
  "data",
  "excel",
  "ATCI Lateral Master Data Updated.xlsx"
);

const ALLOWED_JOB_STATUSES = ["New", "Reopen", "Active", "Closed"] as const;
const ALLOWED_POSTED = ["Yes", "-"] as const;

type AllowedJobStatus = (typeof ALLOWED_JOB_STATUSES)[number];
type AllowedPosted = (typeof ALLOWED_POSTED)[number];

interface ExtractedSheet {
  sheetName: string;
  headers: string[];
  rows: unknown[][];
}

interface MappedRow {
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
  opened_on_oorwin: string | null;
  posted: AllowedPosted | null;
}

function loadDotEnvFile(filePath: string) {
  try {
    // sync read via exists + later async; keep simple with process sync for env
  } catch {
    // ignore
  }
}

async function loadEnvFiles() {
  for (const name of [".env.local", ".env"]) {
    const envPath = path.join(process.cwd(), name);
    if (!existsSync(envPath)) continue;
    const envContent = await fs.readFile(envPath, "utf8");
    for (const line of envContent.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx < 1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed
        .slice(eqIdx + 1)
        .trim()
        .replace(/^["']|["']$/g, "");
      if (key && !(key in process.env)) process.env[key] = val;
    }
  }
  void loadDotEnvFile;
}

function parseArgs(argv: string[]) {
  let file: string | undefined;
  let dryRun = false;
  let replace = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--replace") replace = true;
    else if (arg === "--file") {
      file = argv[i + 1];
      i += 1;
    }
  }
  return { file, dryRun, replace };
}

function normalizeHeader(h: string): string {
  return String(h ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function resolveWorkbookPath(cliPath?: string): string {
  const candidates = [
    cliPath?.trim() || "",
    process.env.ARA_LATERAL_MASTER_XLSX_PATH?.trim() || "",
    DEFAULT_XLSX,
  ].filter(Boolean);
  for (const c of candidates) {
    const resolved = path.resolve(c);
    if (existsSync(resolved)) return resolved;
  }
  throw new Error(
    `Workbook not found. Looked for:\n${candidates.map((c) => `  - ${path.resolve(c)}`).join("\n")}`
  );
}

async function extractSheet(workbookPath: string): Promise<ExtractedSheet> {
  const outPath = path.join(
    os.tmpdir(),
    `lateral-master-xlsx-${Date.now()}.json`
  );
  const script = `
import json, sys
from datetime import date, datetime
from openpyxl import load_workbook

workbook_path = sys.argv[1]
out_path = sys.argv[2]

wb = load_workbook(workbook_path, read_only=True, data_only=True, keep_vba=False)
names = list(wb.sheetnames)
preferred = None
for n in names:
    if n.strip().lower() == "master sheet":
        preferred = n
        break
if preferred is None:
    for n in names:
        if "master" in n.strip().lower():
            preferred = n
            break
if preferred is None:
    preferred = names[0] if names else None
if not preferred:
    print(json.dumps({"ok": False, "error": "Workbook has no sheets.", "available": names}))
    wb.close()
    raise SystemExit(0)

ws = wb[preferred]
headers = []
rows = []
first = True
for row in ws.iter_rows(values_only=True):
    values = list(row)
    if first:
        headers = [("" if v is None else str(v).strip()) for v in values]
        while headers and headers[-1] == "":
            headers.pop()
        first = False
        continue
    out = []
    for v in values[:len(headers)]:
        if v is None:
            out.append(None)
        elif isinstance(v, datetime):
            out.append(v.date().isoformat())
        elif isinstance(v, date):
            out.append(v.isoformat())
        elif isinstance(v, bool):
            out.append(str(v))
        elif isinstance(v, (int, float)):
            out.append(v)
        else:
            # Preserve Job Description and other text exactly (no strip here)
            out.append(str(v))
    rows.append(out)

wb.close()
payload = {"ok": True, "sheetName": preferred, "headers": headers, "rows": rows}
with open(out_path, "w", encoding="utf-8") as f:
    json.dump(payload, f)
print(json.dumps({"ok": True, "outPath": out_path, "rowCount": len(rows), "headerCount": len(headers)}))
`.trim();

  const scriptPath = path.join(
    os.tmpdir(),
    `lateral-master-xlsx-extract-${Date.now()}.py`
  );
  try {
    await fs.writeFile(scriptPath, script, "utf8");
    const python = existsSync("/usr/bin/python3")
      ? "python3"
      : existsSync("/usr/bin/python")
        ? "python"
        : "python3";
    const { stdout } = await execFileAsync(
      python,
      [scriptPath, workbookPath, outPath],
      {
        windowsHide: true,
        timeout: 10 * 60 * 1000,
        maxBuffer: 64 * 1024 * 1024,
      }
    );
    const meta = JSON.parse((stdout || "").trim() || "{}") as {
      ok?: boolean;
      error?: string;
      available?: string[];
    };
    if (!meta.ok) {
      throw new Error(
        `${meta.error || "Failed to read workbook."} Available: ${(meta.available || []).join(", ") || "(none)"}`
      );
    }
    const raw = JSON.parse(await fs.readFile(outPath, "utf8")) as {
      ok?: boolean;
      sheetName: string;
      headers: string[];
      rows: unknown[][];
      error?: string;
    };
    if (!raw.ok) {
      throw new Error(raw.error || "Extract produced invalid JSON.");
    }
    return {
      sheetName: raw.sheetName,
      headers: raw.headers,
      rows: raw.rows,
    };
  } finally {
    await fs.unlink(scriptPath).catch(() => undefined);
    await fs.unlink(outPath).catch(() => undefined);
  }
}

function mapHeaders(sourceHeaders: string[]): {
  fieldToIndex: Record<LateralMasterSheetDbColumn, number>;
  fieldToHeader: Record<LateralMasterSheetDbColumn, string>;
  unmappedHeaders: string[];
} {
  const headers = sourceHeaders.map((h) => String(h ?? "").trim());
  const fieldToIndex = {} as Record<LateralMasterSheetDbColumn, number>;
  const fieldToHeader = {} as Record<LateralMasterSheetDbColumn, string>;
  const claimed = new Set<number>();

  for (const mapping of LATERAL_MASTER_COLUMN_MAP) {
    const aliases = mapping.importAliases;
    let found: { index: number; header: string } | null = null;

    for (const candidate of aliases) {
      const idx = headers.findIndex((h) => h === candidate);
      if (idx >= 0) {
        found = { index: idx, header: headers[idx] };
        break;
      }
    }
    if (!found) {
      for (const candidate of aliases) {
        const lower = candidate.toLowerCase();
        const idx = headers.findIndex((h) => h.toLowerCase() === lower);
        if (idx >= 0) {
          found = { index: idx, header: headers[idx] };
          break;
        }
      }
    }
    if (!found) {
      for (const candidate of aliases) {
        const candNorm = normalizeHeader(candidate);
        const idx = headers.findIndex(
          (h) => normalizeHeader(h) === candNorm
        );
        if (idx >= 0) {
          found = { index: idx, header: headers[idx] };
          break;
        }
      }
    }

    if (!found) {
      throw new Error(
        `Missing required Excel header for DB column "${mapping.dbColumn}" (expected one of: ${aliases.join(" | ")})`
      );
    }
    if (claimed.has(found.index)) {
      throw new Error(
        `Header "${found.header}" mapped to multiple DB columns`
      );
    }
    claimed.add(found.index);
    fieldToIndex[mapping.dbColumn] = found.index;
    fieldToHeader[mapping.dbColumn] = found.header;
  }

  const unmappedHeaders = headers.filter(
    (h, i) => h && !claimed.has(i)
  );
  return { fieldToIndex, fieldToHeader, unmappedHeaders };
}

function cellToTextPreserve(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") {
    // Empty / whitespace-only → NULL; otherwise keep exact string (incl. leading/trailing)
    if (value.trim() === "") return null;
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  const text = String(value);
  return text.trim() === "" ? null : text;
}

function cellToTrimmedText(value: unknown): string | null {
  if (value == null) return null;
  const text = String(value).replace(/\u00a0/g, " ").trim();
  return text.length ? text : null;
}

function normalizeDate(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    // Excel serial → YYYY-MM-DD (UTC approx)
    const utc = Date.UTC(1899, 11, 30) + value * 86400000;
    const d = new Date(utc);
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 10);
  }
  const text = String(value).trim();
  if (!text) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  const dmy = text.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
  if (dmy) {
    const d = Number(dmy[1]);
    const mo = Number(dmy[2]);
    const y = Number(dmy[3]);
    const dt = new Date(Date.UTC(y, mo - 1, d));
    if (
      dt.getUTCFullYear() === y &&
      dt.getUTCMonth() === mo - 1 &&
      dt.getUTCDate() === d
    ) {
      return dt.toISOString().slice(0, 10);
    }
  }
  const parsed = new Date(text);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toISOString().slice(0, 10);
  }
  return null;
}

function normalizeJobStatus(
  value: unknown
): { ok: true; value: AllowedJobStatus | null } | { ok: false; raw: string } {
  const text = cellToTrimmedText(value);
  if (!text) return { ok: true, value: null };
  const hit = ALLOWED_JOB_STATUSES.find(
    (s) => s.toLowerCase() === text.toLowerCase()
  );
  if (hit) return { ok: true, value: hit };
  return { ok: false, raw: text };
}

function normalizePosted(
  value: unknown
): { ok: true; value: AllowedPosted | null } | { ok: false; raw: string } {
  const text = cellToTrimmedText(value);
  if (!text) return { ok: true, value: null };
  if (text.toLowerCase() === "yes") return { ok: true, value: "Yes" };
  if (text === "-") return { ok: true, value: "-" };
  return { ok: false, raw: text };
}

function buildRows(
  extracted: ExtractedSheet,
  fieldToIndex: Record<LateralMasterSheetDbColumn, number>
): {
  rows: MappedRow[];
  skippedEmpty: number;
  failures: Array<{ excelRowNumber: number; reason: string; jr?: string }>;
} {
  const rows: MappedRow[] = [];
  const failures: Array<{ excelRowNumber: number; reason: string; jr?: string }> =
    [];
  let skippedEmpty = 0;
  const seenJr = new Map<string, number>();

  for (let i = 0; i < extracted.rows.length; i += 1) {
    const excelRowNumber = i + 2; // header is row 1
    const raw = extracted.rows[i] ?? [];
    const get = (col: LateralMasterSheetDbColumn) =>
      raw[fieldToIndex[col]] ?? null;

    const allEmpty = LATERAL_MASTER_COLUMN_MAP.every((m) => {
      const v = get(m.dbColumn);
      return v == null || String(v).trim() === "";
    });
    if (allEmpty) {
      skippedEmpty += 1;
      continue;
    }

    const jrRaw = cellToTrimmedText(get("job_requisition_id"));
    if (!jrRaw) {
      failures.push({
        excelRowNumber,
        reason: "Missing Job Requisition ID",
      });
      continue;
    }

    if (seenJr.has(jrRaw)) {
      failures.push({
        excelRowNumber,
        jr: jrRaw,
        reason: `Duplicate Job Requisition ID (first at Excel row ${seenJr.get(jrRaw)})`,
      });
      continue;
    }
    seenJr.set(jrRaw, excelRowNumber);

    const dateVal = get("date");
    const date =
      dateVal == null || String(dateVal).trim() === ""
        ? null
        : normalizeDate(dateVal);
    if (
      dateVal != null &&
      String(dateVal).trim() !== "" &&
      date == null
    ) {
      failures.push({
        excelRowNumber,
        jr: jrRaw,
        reason: `Invalid Date: ${String(dateVal)}`,
      });
      continue;
    }

    const status = normalizeJobStatus(get("job_status"));
    if (!status.ok) {
      failures.push({
        excelRowNumber,
        jr: jrRaw,
        reason: `Invalid Job Status (CHECK): ${status.raw}`,
      });
      continue;
    }

    const posted = normalizePosted(get("posted"));
    if (!posted.ok) {
      failures.push({
        excelRowNumber,
        jr: jrRaw,
        reason: `Invalid Posted (CHECK): ${posted.raw}`,
      });
      continue;
    }

    rows.push({
      excelRowNumber,
      job_requisition_id: jrRaw,
      date,
      priority: cellToTrimmedText(get("priority")),
      // Preserve JD exactly (only null when blank)
      job_description: cellToTextPreserve(get("job_description")),
      skill_categorization: cellToTrimmedText(get("skill_categorization")),
      primary_skills: cellToTrimmedText(get("primary_skills")),
      job_management_level: cellToTrimmedText(get("job_management_level")),
      primary_location: cellToTrimmedText(get("primary_location")),
      market_map: cellToTrimmedText(get("market_map")),
      poc: cellToTrimmedText(get("poc")),
      job_status: status.value,
      opened_on_oorwin: cellToTrimmedText(get("opened_on_oorwin")),
      posted: posted.value,
    });
  }

  return { rows, skippedEmpty, failures };
}

function getDb() {
  const url = process.env.POSTGRES_URL?.trim();
  if (!url) {
    throw new Error(
      "POSTGRES_URL is not set. Set it in the environment or .env / .env.local."
    );
  }
  return postgres(url, {
    max: 1,
    connect_timeout: 15,
    idle_timeout: 20,
    ssl:
      url.includes("localhost") || url.includes("127.0.0.1")
        ? false
        : "require",
  });
}

async function upsertRows(
  sql: ReturnType<typeof postgres>,
  rows: MappedRow[]
): Promise<{ inserted: number; updated: number }> {
  let inserted = 0;
  let updated = 0;
  const BATCH = 250;

  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const ids = batch.map((r) => r.job_requisition_id);
    const existing = await sql<{ job_requisition_id: string }[]>`
      SELECT job_requisition_id FROM lateral_master
      WHERE job_requisition_id = ANY(${ids})
    `;
    const existingSet = new Set(existing.map((r) => r.job_requisition_id));

    const values = batch.map((r) => ({
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
      opened_on_oorwin: r.opened_on_oorwin,
      posted: r.posted,
    }));

    await sql`
      INSERT INTO lateral_master ${sql(values, 
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
        "opened_on_oorwin",
        "posted"
      )}
      ON CONFLICT (job_requisition_id) DO UPDATE SET
        date = EXCLUDED.date,
        priority = EXCLUDED.priority,
        job_description = EXCLUDED.job_description,
        skill_categorization = EXCLUDED.skill_categorization,
        primary_skills = EXCLUDED.primary_skills,
        job_management_level = EXCLUDED.job_management_level,
        primary_location = EXCLUDED.primary_location,
        market_map = EXCLUDED.market_map,
        poc = EXCLUDED.poc,
        job_status = EXCLUDED.job_status,
        opened_on_oorwin = EXCLUDED.opened_on_oorwin,
        posted = EXCLUDED.posted,
        updated_at = NOW()
    `;

    for (const r of batch) {
      if (existingSet.has(r.job_requisition_id)) updated += 1;
      else inserted += 1;
    }

    if ((i / BATCH) % 10 === 0 || i + BATCH >= rows.length) {
      console.log(
        `  … upserted ${Math.min(i + BATCH, rows.length)} / ${rows.length}`
      );
    }
  }

  return { inserted, updated };
}

async function main() {
  await loadEnvFiles();
  const { file, dryRun, replace } = parseArgs(process.argv.slice(2));
  const workbookPath = resolveWorkbookPath(file);

  console.log("========== Lateral Master XLSX → PostgreSQL ==========");
  console.log(`Workbook: ${workbookPath}`);
  console.log(`Mode: ${replace ? "REPLACE (truncate + import)" : "UPSERT"}`);
  console.log(`Dry run: ${dryRun ? "yes" : "no"}`);

  const extracted = await extractSheet(workbookPath);
  console.log(`Sheet: ${extracted.sheetName}`);
  console.log(`Excel headers (${extracted.headers.length}):`);
  extracted.headers.forEach((h, i) => console.log(`  ${i + 1}. ${h}`));

  const mapping = mapHeaders(extracted.headers);
  if (mapping.unmappedHeaders.length > 0) {
    console.error("\nUNMAPPED HEADERS (must be none):");
    for (const h of mapping.unmappedHeaders) console.error(`  - ${h}`);
    process.exitCode = 1;
    return;
  }
  console.log("\nMapped headers → DB:");
  for (const m of LATERAL_MASTER_COLUMN_MAP) {
    console.log(
      `  ${mapping.fieldToHeader[m.dbColumn]}  →  ${m.dbColumn}`
    );
  }
  console.log(`Unmapped headers: (none)`);
  console.log(
    `Canonical UI headers: ${LATERAL_MASTER_EXCEL_HEADERS.join(" | ")}`
  );

  const built = buildRows(extracted, mapping.fieldToIndex);
  const excelValidCount = built.rows.length;
  console.log("\n-- Row counts --");
  console.log(`Excel data rows: ${extracted.rows.length}`);
  console.log(`Skipped empty: ${built.skippedEmpty}`);
  console.log(`Valid for import: ${excelValidCount}`);
  console.log(`Failures: ${built.failures.length}`);
  if (built.failures.length) {
    console.log("Sample failures (up to 20):");
    for (const f of built.failures.slice(0, 20)) {
      console.log(
        `  row ${f.excelRowNumber}${f.jr ? ` [${f.jr}]` : ""}: ${f.reason}`
      );
    }
  }

  const sampleIds = built.rows.slice(0, 8).map((r) => r.job_requisition_id);
  console.log(`Sample JR IDs: ${sampleIds.join(", ") || "(none)"}`);

  if (built.failures.length > 0) {
    console.error(
      `\nAborting: ${built.failures.length} row failure(s). Fix Excel or mapping and retry.`
    );
    process.exitCode = 1;
    return;
  }

  if (dryRun) {
    console.log("\nDry run complete — no database writes.");
    if (replace) {
      console.log(
        `(Would TRUNCATE lateral_master then import ${excelValidCount} rows)`
      );
    }
    return;
  }

  const sql = getDb();
  try {
    const before = await sql<{ c: string }[]>`
      SELECT COUNT(*)::text AS c FROM lateral_master
    `;
    const beforeCount = Number(before[0]?.c ?? 0);
    console.log(`\nDB count before: ${beforeCount}`);

    if (replace) {
      console.log("TRUNCATE lateral_master ...");
      await sql`TRUNCATE TABLE lateral_master`;
      const mid = await sql<{ c: string }[]>`
        SELECT COUNT(*)::text AS c FROM lateral_master
      `;
      console.log(`DB count after truncate: ${mid[0]?.c}`);
    }

    const { inserted, updated } = await upsertRows(sql, built.rows);

    const after = await sql<{ c: string }[]>`
      SELECT COUNT(*)::text AS c FROM lateral_master
    `;
    const afterCount = Number(after[0]?.c ?? 0);

    const cols = await sql<{ column_name: string }[]>`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'lateral_master'
      ORDER BY ordinal_position
    `;
    const colSet = new Set(cols.map((c) => c.column_name));
    const missingDb = LATERAL_MASTER_COLUMN_MAP.filter(
      (m) => !colSet.has(m.dbColumn)
    ).map((m) => m.dbColumn);

    console.log(`\n-- ${replace ? "REPLACE" : "UPSERT"} result --`);
    console.log(`Inserted: ${inserted}`);
    console.log(`Updated: ${updated}`);
    console.log(`Excel valid row count: ${excelValidCount}`);
    console.log(`DB count after: ${afterCount}`);
    console.log(
      `COUNT match Excel: ${afterCount === excelValidCount ? "YES" : "NO"}`
    );
    console.log(
      `DB has all mapped columns: ${missingDb.length === 0 ? "yes" : missingDb.join(", ")}`
    );

    const withOorwin = await sql<{ c: string }[]>`
      SELECT COUNT(*)::text AS c FROM lateral_master
      WHERE opened_on_oorwin IS NOT NULL AND btrim(opened_on_oorwin) <> ''
    `;
    const withJd = await sql<{ c: string }[]>`
      SELECT COUNT(*)::text AS c FROM lateral_master
      WHERE job_description IS NOT NULL AND length(job_description) > 0
    `;
    console.log(`Rows with Opened on Oorwin: ${withOorwin[0]?.c}`);
    console.log(`Rows with Job Description: ${withJd[0]?.c}`);
    console.log("=======================================================");

    if (afterCount !== excelValidCount) {
      console.error(
        `\nERROR: lateral_master COUNT (${afterCount}) != Excel valid rows (${excelValidCount})`
      );
      process.exitCode = 1;
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

const isMain =
  typeof process.argv[1] === "string" &&
  path.resolve(process.argv[1]).includes("import-lateral-master-from-xlsx");

if (isMain) {
  main().catch((err) => {
    console.error("[import-lateral-master-from-xlsx] FAILED:", err);
    process.exitCode = 1;
  });
}
