/**
 * Parser validation for the DATED Master Sheet export (replay mode) — the
 * "Date" column is optional (candidate-accenture-column-map.ts), and its
 * presence is what sets `hasDateColumn: true`, which is what
 * candidate-accenture-sync-job.ts reads to dispatch to the replay engine.
 *
 * Reads the real dated Master Sheet export from
 * ACCENTURE_MASTER_SAMPLE_FILE_PATH (default:
 * /root/accenture-review/Accenture_Final_Report_Master_Sheet.xlsx —
 * deliberately OUTSIDE the repo, never copied in, never committed). Prints
 * only counts/headers — no candidate name/email/phone from the file is
 * ever read into a variable or logged here.
 *
 * Read-only against the real sample file; no DB access at all.
 *
 * Run: npx tsx scripts/verify-candidate-accenture-replay-parser.ts
 */
import fs from "node:fs/promises";
import { parseCandidateAccentureWorkbook } from "../src/services/candidate-processing/candidate-accenture-parser";
import { accentureReportDateKey } from "../src/services/candidate-processing/candidate-excel-date";

interface TestResult {
  name: string;
  status: "PASS" | "FAIL";
  detail?: string;
}
const results: TestResult[] = [];
function check(name: string, pass: boolean, detail?: string) {
  results.push({ name, status: pass ? "PASS" : "FAIL", detail });
}

const SAMPLE_PATH =
  process.env.ACCENTURE_MASTER_SAMPLE_FILE_PATH ||
  "/root/accenture-review/Accenture_Final_Report_Master_Sheet.xlsx";

async function main() {
  let buffer: Buffer | null = null;
  try {
    buffer = await fs.readFile(SAMPLE_PATH);
  } catch {
    console.log(
      `NOTE: real dated sample file not found at ${SAMPLE_PATH} (set ACCENTURE_MASTER_SAMPLE_FILE_PATH) — skipping.`
    );
  }

  if (buffer) {
    const result = parseCandidateAccentureWorkbook(buffer);
    check("Real dated Master Sheet parses ok", result.ok, result.ok ? undefined : result.message);
    if (result.ok) {
      check("hasDateColumn is true -> replay path", result.hasDateColumn === true);
      check("8 headers matched (7 required + optional Date)", Object.keys(result.matchedHeaders).length === 8);
      check("51,076 non-blank data rows", result.rows.length === 51076, `got ${result.rows.length}`);
      check("every row has a non-empty reportDateRaw", result.rows.every((r) => r.reportDateRaw !== ""));

      const dateKeys = Array.from(new Set(result.rows.map((r) => accentureReportDateKey(r.reportDateRaw)))).filter(
        (k): k is string => k !== null
      );
      dateKeys.sort();
      check("51 distinct report dates", dateKeys.length === 51, `got ${dateKeys.length}`);
      check("first report date is 2026-01-26", dateKeys[0] === "2026-01-26", dateKeys[0]);
      check("last report date is 2026-10-04", dateKeys[dateKeys.length - 1] === "2026-10-04", dateKeys[dateKeys.length - 1]);

      const uniqueCids = new Set(
        result.rows.map((r) => r.cid.trim()).filter((c) => /^C[0-9]+$/.test(c))
      );
      check("3,214 unique valid CIDs", uniqueCids.size === 3214, `got ${uniqueCids.size}`);
    }
  }

  console.log("\n========== TEST RESULTS ==========");
  let failures = 0;
  for (const r of results) {
    console.log(`[${r.status}] ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
    if (r.status === "FAIL") failures += 1;
  }
  console.log(`\n${results.length - failures}/${results.length} passed.`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
