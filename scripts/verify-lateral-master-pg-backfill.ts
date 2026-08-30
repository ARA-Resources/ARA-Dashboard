/**
 * Validation tests for Phase 2 Lateral Master → PostgreSQL backfill.
 *
 * Uses synthetic in-memory / temp workbooks. Does NOT truncate production
 * lateral_master. Live DB checks are read-only unless explicitly inserting
 * into a rolled-back transaction / disposable JR ids that are cleaned up.
 *
 * Run: npx tsx scripts/verify-lateral-master-pg-backfill.ts
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import postgres from "postgres";
import {
  analyzeExistingMasterProtection,
  formatLateralPgDateDdMmYyyy,
  formatLateralPgTimestampIst,
  mapMasterSheetHeaders,
  normalizeOptionalText,
  parseExcelDateToIso,
  validateAndBuildBackfillRows,
  type HeaderMappingSuccess,
} from "../src/services/lateral-processing/lateral-master-pg-backfill";
import { extractMasterSheetRows } from "./import-lateral-master-to-postgres";

const execFileAsync = promisify(execFile);

interface TestResult {
  name: string;
  status: "PASS" | "FAIL";
  detail?: string;
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
      const k = t.slice(0, eq).trim();
      const v = t.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      if (k && !(k in process.env)) process.env[k] = v;
    }
  } catch {
    // optional
  }
}

function goodHeaders() {
  return [
    "Date",
    "Job Requisition ID",
    "Priority",
    "Job Description",
    "Skill Categorization",
    "Primary Skills",
    "Job Management Level",
    "Primary Location/Office lOcate",
    "Market Map",
    "POC",
    "Job Status",
    "Opened on Oorwin",
    "Posted",
    "Team - Auto",
    "Team - Manual",
  ];
}

function mappingOrThrow(headers: string[]): HeaderMappingSuccess {
  const m = mapMasterSheetHeaders(headers);
  if (!m.ok) throw new Error(m.message);
  return m;
}

function baseRow(overrides: Record<string, unknown> = {}): unknown[] {
  const headers = goodHeaders();
  const byName: Record<string, unknown> = {
    Date: "2026-08-25",
    "Job Requisition ID": "ATCI-TEST-001",
    Priority: "P1",
    "Job Description": "Desc",
    "Skill Categorization": "Tech",
    "Primary Skills": "Java",
    "Job Management Level": "11-Analyst",
    "Primary Location/Office lOcate": "Pune",
    "Market Map": "India",
    POC: "POC",
    "Job Status": "Active",
    "Opened on Oorwin": "ignore-me",
    Posted: "Yes",
    "Team - Auto": "ignore-team",
    "Team - Manual": "ignore-team",
    ...overrides,
  };
  return headers.map((h) => byName[h] ?? null);
}

async function writeTempWorkbook(options: {
  sheetName?: string;
  headers?: string[];
  rows?: unknown[][];
  skipMaster?: boolean;
}): Promise<string> {
  const outPath = path.join(
    os.tmpdir(),
    `lateral-backfill-test-${Date.now()}-${Math.random().toString(16).slice(2)}.xlsx`
  );
  const script = `
import json, sys
from openpyxl import Workbook
payload = json.loads(sys.argv[1])
out = sys.argv[2]
wb = Workbook()
default = wb.active
wb.remove(default)
if not payload.get("skipMaster"):
    ws = wb.create_sheet(payload.get("sheetName") or "Master Sheet")
    headers = payload["headers"]
    ws.append(headers)
    for row in payload.get("rows") or []:
        ws.append(row)
else:
    wb.create_sheet("Other Sheet")
wb.create_sheet("Posted Sheet")
wb.save(out)
print(out)
`;
  const scriptPath = path.join(os.tmpdir(), `backfill-wb-${Date.now()}.py`);
  await fs.writeFile(scriptPath, script, "utf8");
  try {
    await execFileAsync(
      "python",
      [
        scriptPath,
        JSON.stringify({
          sheetName: options.sheetName ?? "Master Sheet",
          headers: options.headers ?? goodHeaders(),
          rows: options.rows ?? [baseRow()],
          skipMaster: options.skipMaster === true,
        }),
        outPath,
      ],
      { windowsHide: true, timeout: 60_000 }
    );
    return outPath;
  } finally {
    await fs.unlink(scriptPath).catch(() => undefined);
  }
}

async function main() {
  await loadEnvLocal();
  const results: TestResult[] = [];
  let passed = 0;
  let failed = 0;

  const ok = (name: string, cond: boolean, detail?: string) => {
    if (cond) {
      passed += 1;
      results.push({ name, status: "PASS" });
      console.log(`  PASS  ${name}`);
    } else {
      failed += 1;
      results.push({ name, status: "FAIL", detail });
      console.error(`  FAIL  ${name}${detail ? " — " + detail : ""}`);
    }
  };

  console.log("\n1. Normal mapping + row import shape");
  {
    const headers = goodHeaders();
    const mapping = mapMasterSheetHeaders(headers);
    ok("1a. headers map OK", mapping.ok);
    if (mapping.ok) {
      ok(
        "1b. ignores Team / Oorwin columns",
        mapping.ignoredHeaders.includes("Opened on Oorwin") &&
          mapping.ignoredHeaders.includes("Team - Auto")
      );
      const validated = validateAndBuildBackfillRows({
        headers,
        rawRows: [
          baseRow(),
          baseRow({
            "Job Requisition ID": "ATCI-TEST-002",
            Posted: "-",
            "Job Status": "Closed",
            Priority: "",
          }),
        ],
        mapping,
      });
      ok("1c. valid rows", validated.ok && validated.ok && validated.rows.length === 2);
      if (validated.ok) {
        ok("1d. empty optional → null", validated.rows[1].priority === null);
        ok("1e. posted Yes/- preserved", validated.rows[0].posted === "Yes" && validated.rows[1].posted === "-");
      }
    }
  }

  console.log("\n2. Missing Master Sheet");
  {
    const wb = await writeTempWorkbook({ skipMaster: true });
    try {
      let threw = false;
      try {
        await extractMasterSheetRows(wb);
      } catch (e) {
        threw = /Master Sheet/i.test(e instanceof Error ? e.message : String(e));
      }
      ok("2a. missing Master Sheet stops", threw);
    } finally {
      await fs.unlink(wb).catch(() => undefined);
    }
  }

  console.log("\n3. Missing required header");
  {
    const headers = goodHeaders().filter((h) => h !== "Posted");
    const mapping = mapMasterSheetHeaders(headers);
    ok("3a. missing Posted fails", !mapping.ok);
    ok(
      "3b. reports posted missing",
      !mapping.ok && mapping.missingFields.includes("posted")
    );
  }

  console.log("\n4. Duplicate Job Requisition ID");
  {
    const mapping = mappingOrThrow(goodHeaders());
    const validated = validateAndBuildBackfillRows({
      headers: goodHeaders(),
      rawRows: [
        baseRow({ "Job Requisition ID": "ATCI-DUP" }),
        baseRow({ "Job Requisition ID": "ATCI-DUP", Priority: "P2" }),
      ],
      mapping,
    });
    ok("4a. duplicates abort", !validated.ok);
    ok(
      "4b. reports row numbers",
      !validated.ok &&
        validated.duplicateJrs.some(
          (d) =>
            d.jobRequisitionId === "ATCI-DUP" &&
            d.excelRowNumbers.includes(2) &&
            d.excelRowNumbers.includes(3)
        )
    );
  }

  console.log("\n5. Invalid Job Status");
  {
    const mapping = mappingOrThrow(goodHeaders());
    const validated = validateAndBuildBackfillRows({
      headers: goodHeaders(),
      rawRows: [baseRow({ "Job Status": "Pending" })],
      mapping,
    });
    ok("5a. invalid status aborts", !validated.ok);
    ok(
      "5b. reports Pending",
      !validated.ok &&
        validated.invalidJobStatuses.some((r) => r.value === "Pending")
    );
  }

  console.log("\n6. Invalid Posted");
  {
    const mapping = mappingOrThrow(goodHeaders());
    const validated = validateAndBuildBackfillRows({
      headers: goodHeaders(),
      rawRows: [baseRow({ Posted: "Y" })],
      mapping,
    });
    ok("6a. invalid posted aborts", !validated.ok);
    ok(
      "6b. reports Y",
      !validated.ok && validated.invalidPosted.some((r) => r.value === "Y")
    );
  }

  console.log("\n7. Invalid date");
  {
    const mapping = mappingOrThrow(goodHeaders());
    const validated = validateAndBuildBackfillRows({
      headers: goodHeaders(),
      rawRows: [baseRow({ Date: "not-a-date" })],
      mapping,
    });
    ok("7a. invalid date aborts", !validated.ok);
    ok(
      "7b. reports bad date",
      !validated.ok && validated.invalidDates.length === 1
    );
    const goodDate = parseExcelDateToIso("25/08/2026");
    ok(
      "7c. DD/MM/YYYY parses to ISO",
      goodDate.ok && goodDate.iso === "2026-08-25"
    );
  }

  console.log("\n8. Empty optional fields");
  {
    ok("8a. empty string → null", normalizeOptionalText("") === null);
    ok("8b. whitespace → null", normalizeOptionalText("  ") === null);
    ok("8c. value preserved", normalizeOptionalText(" Java ") === "Java");
    const emptyDate = parseExcelDateToIso(null);
    ok("8d. empty date → null", emptyDate.ok && emptyDate.iso === null);
  }

  console.log("\n9. Extra Excel columns ignored");
  {
    const mapping = mappingOrThrow(goodHeaders());
    ok(
      "9a. Team columns ignored",
      mapping.ignoredHeaders.some((h) => /Team/i.test(h))
    );
    const validated = validateAndBuildBackfillRows({
      headers: goodHeaders(),
      rawRows: [baseRow()],
      mapping,
    });
    ok(
      "9b. row has no team fields",
      validated.ok &&
        !("team_auto" in validated.rows[0]) &&
        !("opened_on_oorwin" in validated.rows[0])
    );
  }

  console.log("\n10. Existing PostgreSQL row protection (logic)");
  {
    const protection = analyzeExistingMasterProtection({
      sourceIds: ["A", "B", "C"],
      existingIds: ["B", "D"],
    });
    ok("10a. overlapping detected", protection.overlappingIds.includes("B"));
    ok("10b. new ids listed", protection.newIds.includes("A") && protection.newIds.includes("C"));
    ok("10c. existing count", protection.existingCount === 2);
  }

  console.log("\n11. Transaction rollback on failure (DB)");
  {
    const url = process.env.POSTGRES_URL?.trim();
    if (!url) {
      ok("11a. POSTGRES_URL present", false, "POSTGRES_URL missing");
    } else {
      const sql = postgres(url, {
        max: 1,
        ssl:
          url.includes("localhost") || url.includes("127.0.0.1")
            ? false
            : "require",
      });
      try {
        const marker = `ATCI-BACKFILL-ROLLBACK-${Date.now()}`;
        const before = await sql<{ c: string }[]>`
          SELECT COUNT(*)::text AS c FROM lateral_master
        `;
        let rolledBack = false;
        try {
          await sql.begin(async (tx) => {
            await tx`
              INSERT INTO lateral_master (
                job_requisition_id, job_status, posted, created_at, updated_at, last_seen_at
              ) VALUES (
                ${marker}, 'New', '-', NOW(), NOW(), NULL
              )
            `;
            // Force failure after insert inside same transaction
            await tx`
              INSERT INTO lateral_master (
                job_requisition_id, job_status, posted, created_at, updated_at, last_seen_at
              ) VALUES (
                ${marker}, 'Active', 'Yes', NOW(), NOW(), NULL
              )
            `;
          });
        } catch {
          rolledBack = true;
        }
        const after = await sql<{ c: string }[]>`
          SELECT COUNT(*)::text AS c FROM lateral_master
        `;
        const stillThere = await sql`
          SELECT 1 FROM lateral_master WHERE job_requisition_id = ${marker}
        `;
        ok("11a. duplicate PK failed", rolledBack);
        ok(
          "11b. row count unchanged",
          before[0].c === after[0].c
        );
        ok("11c. marker row absent after rollback", stillThere.length === 0);
      } finally {
        await sql.end();
      }
    }
  }

  console.log("\n12. Header case / locate variant + synthetic workbook extract");
  {
    const wb = await writeTempWorkbook({
      headers: goodHeaders(),
      rows: [
        baseRow({ "Job Requisition ID": "ATCI-SYN-1", Date: "2026-01-15" }),
      ],
    });
    try {
      const extracted = await extractMasterSheetRows(wb);
      ok("12a. extract headers", extracted.headers[1] === "Job Requisition ID");
      const mapping = mapMasterSheetHeaders(extracted.headers);
      ok("12b. map extracted", mapping.ok);
      if (mapping.ok) {
        const validated = validateAndBuildBackfillRows({
          headers: extracted.headers,
          rawRows: extracted.rows,
          mapping,
        });
        ok("12c. validate extracted row", validated.ok && validated.rows.length === 1);
        ok(
          "12d. date ISO",
          validated.ok && validated.rows[0].date === "2026-01-15"
        );
        ok(
          "12e. date display DD/MM/YYYY",
          validated.ok &&
            formatLateralPgDateDdMmYyyy(validated.rows[0].date) === "15/01/2026"
        );
      }
    } finally {
      await fs.unlink(wb).catch(() => undefined);
    }
  }

  console.log("\n13. Timestamp display IST formatting");
  {
    const utcIso = "2026-08-25T05:48:52.385Z";
    const expected = "25/08/2026, 11:18:52 IST";
    const actual = formatLateralPgTimestampIst(utcIso);
    ok("13a. UTC → IST display", actual === expected, `got "${actual}"`);

    const midnightUtc = "2026-08-25T00:00:00.000Z";
    const midnightIst = formatLateralPgTimestampIst(midnightUtc);
    ok(
      "13b. midnight UTC → IST (+5:30)",
      midnightIst === "25/08/2026, 05:30:00 IST",
      `got "${midnightIst}"`
    );

    // Crossing calendar day: late UTC evening → next calendar day in IST
    const lateUtc = "2026-08-24T20:00:00.000Z";
    const nextDayIst = formatLateralPgTimestampIst(lateUtc);
    ok(
      "13c. UTC evening crosses into IST next day",
      nextDayIst === "25/08/2026, 01:30:00 IST",
      `got "${nextDayIst}"`
    );

    ok(
      "13d. Date object accepted",
      formatLateralPgTimestampIst(new Date(utcIso)) === expected
    );
    ok("13e. null → empty", formatLateralPgTimestampIst(null) === "");
    ok(
      "13f. business date has no time",
      formatLateralPgDateDdMmYyyy("2026-08-25") === "25/08/2026"
    );
  }

  console.log("\n14. PostgreSQL still stores TIMESTAMPTZ (not formatted text)");
  {
    const url = process.env.POSTGRES_URL?.trim();
    if (!url) {
      ok("14a. POSTGRES_URL present", false, "POSTGRES_URL missing");
    } else {
      const sql = postgres(url, {
        max: 1,
        ssl:
          url.includes("localhost") || url.includes("127.0.0.1")
            ? false
            : "require",
      });
      try {
        const types = await sql<{ column_name: string; udt_name: string }[]>`
          SELECT column_name, udt_name
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'lateral_master'
            AND column_name IN ('created_at', 'updated_at', 'last_seen_at', 'date')
          ORDER BY column_name
        `;
        const byName = Object.fromEntries(
          types.map((r) => [r.column_name, r.udt_name])
        );
        ok("14a. created_at is timestamptz", byName.created_at === "timestamptz");
        ok("14b. updated_at is timestamptz", byName.updated_at === "timestamptz");
        ok("14c. last_seen_at is timestamptz", byName.last_seen_at === "timestamptz");
        ok("14d. date is date (not timestamptz)", byName.date === "date");

        const sample = await sql<{ created_at: Date; created_text: string }[]>`
          SELECT created_at, created_at::text AS created_text
          FROM lateral_master
          LIMIT 1
        `;
        if (sample[0]) {
          const display = formatLateralPgTimestampIst(sample[0].created_at);
          ok(
            "14e. sample created_at formats as IST",
            /^\d{2}\/\d{2}\/\d{4}, \d{2}:\d{2}:\d{2} IST$/.test(display),
            display
          );
          ok(
            "14f. DB text is not the display format",
            !String(sample[0].created_text).includes(" IST")
          );
        } else {
          ok("14e. sample created_at formats as IST", false, "no rows");
          ok("14f. DB text is not the display format", false, "no rows");
        }
      } finally {
        await sql.end();
      }
    }
  }

  console.log("\n────────────────────────────────────────");
  console.log(`Passed: ${passed}   Failed: ${failed}`);
  console.log("────────────────────────────────────────\n");
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
