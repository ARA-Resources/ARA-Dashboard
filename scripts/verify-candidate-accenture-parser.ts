/**
 * Parser validation — real file + reject-wrong-file-in-both-directions.
 *
 * Reads the real "Accenture Final Report" sample from
 * ACCENTURE_SAMPLE_FILE_PATH (default: /root/accenture-review/Accenture_Final_report.xlsx
 * — deliberately OUTSIDE the repo, never copied in, never committed) to
 * confirm the real file parses to exactly 1181 rows with every required
 * header matched. Prints only counts/headers — no candidate name/email/
 * phone from the file is ever read into a variable or logged here.
 *
 * The "reject in both directions" checks build a tiny SYNTHETIC in-memory
 * workbook with Oorwin's own required headers (no name/email/phone — a
 * handful of header cells and zero data rows) rather than needing a real
 * Oorwin sample file, so this script has no PII dependency of its own.
 *
 * Read-only against the real sample file (only reads it, never writes it);
 * no DB access at all.
 *
 * Run: npx tsx scripts/verify-candidate-accenture-parser.ts
 */
import fs from "node:fs/promises";
import * as XLSX from "xlsx";
import { parseCandidateAccentureWorkbook } from "../src/services/candidate-processing/candidate-accenture-parser";
import { parseCandidateOorwinWorkbook } from "../src/services/candidate-processing/candidate-oorwin-parser";
import { CANDIDATE_OORWIN_COLUMN_MAP } from "../src/services/candidate-processing/candidate-oorwin-column-map";

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
  process.env.ACCENTURE_SAMPLE_FILE_PATH || "/root/accenture-review/Accenture_Final_report.xlsx";

function buildSyntheticWorkbookBuffer(headerRow: string[]): Buffer {
  const ws = XLSX.utils.aoa_to_sheet([headerRow]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

async function main() {
  // --- Real file: parses correctly, 1181 rows, no missing headers ---
  let realFileBuffer: Buffer | null = null;
  try {
    realFileBuffer = await fs.readFile(SAMPLE_PATH);
  } catch {
    console.log(
      `NOTE: real sample file not found at ${SAMPLE_PATH} (set ACCENTURE_SAMPLE_FILE_PATH) — skipping real-file checks.`
    );
  }

  if (realFileBuffer) {
    const result = parseCandidateAccentureWorkbook(realFileBuffer);
    check("Real Accenture file parses ok", result.ok, result.ok ? undefined : result.message);
    if (result.ok) {
      check("Real Accenture file: exactly 1181 rows", result.rows.length === 1181, `got ${result.rows.length}`);
      check(
        "Real Accenture file: all 7 required headers matched",
        Object.keys(result.matchedHeaders).length === 7,
        JSON.stringify(result.matchedHeaders)
      );
      check(
        "Real Accenture file (no Date column): hasDateColumn is false -> classic path",
        result.hasDateColumn === false
      );
      check("Real Accenture file: reportDateRaw is empty on every row (no Date column)", result.rows.every((r) => r.reportDateRaw === ""));
    }

    // Direction 1: real Accenture file fed to the OORWIN parser -> rejected
    // (missing First Name/Last Name/Mobile/Client Submission JR/etc).
    const oorwinOnAccenture = parseCandidateOorwinWorkbook(realFileBuffer);
    check(
      "Real Accenture file fed to the Oorwin parser is REJECTED (missing Oorwin headers)",
      !oorwinOnAccenture.ok,
      oorwinOnAccenture.ok ? "unexpectedly accepted" : oorwinOnAccenture.message
    );
  }

  // Direction 2: a synthetic Oorwin-shaped header row fed to the ACCENTURE
  // parser -> rejected (missing Candidate Name/Candidate Email/Management
  // Level/etc — Oorwin's "Candidate ID" alone isn't enough).
  const oorwinHeaders = CANDIDATE_OORWIN_COLUMN_MAP.map((c) => c.aliases[0]);
  const syntheticOorwinBuffer = buildSyntheticWorkbookBuffer(oorwinHeaders);

  // Sanity check: the synthetic fixture is genuinely Oorwin-shaped (Oorwin's
  // own parser accepts it, 0 data rows) — otherwise the rejection test below
  // would be meaningless (rejecting garbage proves nothing).
  const oorwinOnSynthetic = parseCandidateOorwinWorkbook(syntheticOorwinBuffer);
  check(
    "Sanity: the synthetic Oorwin-shaped header row IS accepted by the Oorwin parser itself (0 data rows)",
    oorwinOnSynthetic.ok && oorwinOnSynthetic.ok && oorwinOnSynthetic.rows.length === 0,
    oorwinOnSynthetic.ok ? `rows=${oorwinOnSynthetic.rows.length}` : oorwinOnSynthetic.message
  );

  const accentureOnSynthetic = parseCandidateAccentureWorkbook(syntheticOorwinBuffer);
  check(
    "Synthetic Oorwin-shaped file fed to the ACCENTURE parser is REJECTED (missing Accenture headers)",
    !accentureOnSynthetic.ok,
    accentureOnSynthetic.ok ? "unexpectedly accepted" : accentureOnSynthetic.message
  );

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
