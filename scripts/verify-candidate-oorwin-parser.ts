/**
 * C4 validation — Oorwin sheet parser + name/mobile field utilities.
 *
 * Proves: parseCandidateOorwinWorkbook correctly reads a real Oorwin .xls
 * export (skipping the decorative "Custom Report" title row and the
 * trailing blank row), and combineCandidateName / normalizeCandidateMobile
 * behave correctly on both real extracted values and synthetic edge cases.
 * Read-only, no DB involved.
 *
 * Run: npx tsx scripts/verify-candidate-oorwin-parser.ts [pathToXlsFile]
 */
import fs from "node:fs/promises";
import path from "node:path";
import { parseCandidateOorwinWorkbook } from "../src/services/candidate-processing/candidate-oorwin-parser";
import {
  combineCandidateName,
  normalizeCandidateMobile,
} from "../src/services/candidate-processing/candidate-field-utils";

interface TestResult {
  name: string;
  status: "PASS" | "FAIL";
  detail?: string;
}

function check(results: TestResult[], name: string, pass: boolean, detail?: string) {
  results.push({ name, status: pass ? "PASS" : "FAIL", detail });
}

async function main() {
  const results: TestResult[] = [];

  const filePath =
    process.argv[2] ||
    path.join(
      process.cwd(),
      "data",
      "excel",
      "ACCI Candidate Master Tracker Test - Anurag Shah-4.xls"
    );
  const buffer = await fs.readFile(filePath);

  const parsed = parseCandidateOorwinWorkbook(buffer);
  check(results, "Parse succeeds on the real Oorwin .xls sample", parsed.ok, parsed.ok ? undefined : parsed.message);
  if (!parsed.ok) {
    printAndExit(results);
    return;
  }

  check(
    results,
    "Skips the decorative title row and finds the real header row (60 data rows expected)",
    parsed.rows.length === 60,
    `got ${parsed.rows.length}`
  );

  check(
    results,
    "All 17 expected headers matched to their canonical Oorwin spelling",
    Object.keys(parsed.matchedHeaders).length === 17,
    JSON.stringify(parsed.matchedHeaders)
  );

  const first = parsed.rows[0];
  check(
    results,
    "First data row's fields match the real file exactly",
    first?.cid === "C27803646" &&
      first?.firstName === "Nitu" &&
      first?.middleName === "-" &&
      first?.lastName === "Kumari" &&
      first?.mobile === "918797271671" &&
      first?.clientSubmissionJr === "ATCI-R1-S1926331",
    JSON.stringify(first)
  );

  // Row with a numeric-typed CID cell (7447312071, no "C" prefix) — must come
  // through as plain text, not scientific notation or a mangled value.
  const numericCidRow = parsed.rows.find((r) => r.firstName === "Abdullah");
  check(
    results,
    "Numeric-typed CID cell (7447312071) is stringified as plain digits, not scientific notation",
    numericCidRow?.cid === "7447312071",
    JSON.stringify(numericCidRow?.cid)
  );

  // Trailing fully-blank row must not appear as a parsed row.
  check(
    results,
    "Trailing fully-blank sheet row produces no parsed row",
    !parsed.rows.some((r) => r.cid === "" && r.firstName === ""),
    undefined
  );

  // -- combineCandidateName --
  check(
    results,
    "combineCandidateName: dash middle name is dropped (real data convention)",
    combineCandidateName("Nitu", "-", "Kumari") === "Nitu Kumari"
  );
  check(
    results,
    "combineCandidateName: real middle name is included",
    combineCandidateName("Vaishali", "Samadhan", "Band") === "Vaishali Samadhan Band"
  );
  check(
    results,
    "combineCandidateName: blank (empty string) middle name is dropped",
    combineCandidateName("A", "", "B") === "A B"
  );
  check(
    results,
    "combineCandidateName: whitespace-only middle name is dropped",
    combineCandidateName("A", "   ", "B") === "A B"
  );
  check(
    results,
    "combineCandidateName: all three blank collapses to empty string",
    combineCandidateName("-", "-", "-") === ""
  );

  // -- normalizeCandidateMobile: real data --
  check(
    results,
    "normalizeCandidateMobile: real 12-digit value with 91 country code → 10 digits",
    normalizeCandidateMobile("918797271671").ok === true &&
      normalizeCandidateMobile("918797271671").normalized === "8797271671"
  );
  check(
    results,
    "normalizeCandidateMobile: blank placeholder '-' is not ok (caller decides whether to flag)",
    normalizeCandidateMobile("-").ok === false
  );

  // -- normalizeCandidateMobile: synthetic edge cases --
  check(
    results,
    "normalizeCandidateMobile: plain 10 digits, no country code",
    normalizeCandidateMobile("9876543210").ok === true &&
      normalizeCandidateMobile("9876543210").normalized === "9876543210"
  );
  check(
    results,
    "normalizeCandidateMobile: spaces embedded (legacy-style '94431 25992')",
    normalizeCandidateMobile("94431 25992").ok === true &&
      normalizeCandidateMobile("94431 25992").normalized === "9443125992"
  );
  check(
    results,
    "normalizeCandidateMobile: dashes embedded",
    normalizeCandidateMobile("98-765-43210").ok === true &&
      normalizeCandidateMobile("98-765-43210").normalized === "9876543210"
  );
  check(
    results,
    "normalizeCandidateMobile: stray leading '-' character (legacy artifact, e.g. '-8005660752')",
    normalizeCandidateMobile("-8005660752").ok === true &&
      normalizeCandidateMobile("-8005660752").normalized === "8005660752"
  );
  check(
    results,
    "normalizeCandidateMobile: 11-digit landline-style number (leading 0) does NOT force to 10",
    normalizeCandidateMobile("08585014746").ok === false
  );
  check(
    results,
    "normalizeCandidateMobile: two numbers in one cell (e.g. '9879028613/ 9824834031') is not ok",
    normalizeCandidateMobile("9879028613/ 9824834031").ok === false
  );
  check(
    results,
    "normalizeCandidateMobile: a CID string accidentally in the phone column is not ok",
    normalizeCandidateMobile("C15514827").ok === false
  );
  check(
    results,
    "normalizeCandidateMobile: empty string is not ok",
    normalizeCandidateMobile("").ok === false
  );
  check(
    results,
    "normalizeCandidateMobile: 12-digit value NOT starting with 91 is not ok (not a country-code case)",
    normalizeCandidateMobile("123456789012").ok === false
  );

  // -- missing-header failure path --
  const bogusBuffer = Buffer.from("not a real workbook");
  const bogusResult = parseCandidateOorwinWorkbook(bogusBuffer);
  check(
    results,
    "A non-workbook buffer fails gracefully (no throw, ok:false with a message)",
    bogusResult.ok === false && typeof bogusResult.message === "string" && bogusResult.message.length > 0
  );

  printAndExit(results);
}

function printAndExit(results: TestResult[]) {
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
