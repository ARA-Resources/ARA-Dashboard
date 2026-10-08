/**
 * Verify the shared Posted-button row cleaner (no network, no I/O) against
 * the synthetic fixture shapes agreed with the user: a raw tab, an
 * already-clean tab, a mixed tab, duplicate JR IDs, odd spacing, two JR IDs
 * on one line, an unclear date, and idempotency (clean(clean(x)) ===
 * clean(x), two runs in a row identical).
 */
import { cleanPostedSheetRows, parsePostedSheetLine } from "../src/services/dataset-posted/posted-sheet-row-cleaner";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

// --- (a) raw tab: blank / title-line / blank / real posting, repeated ---
{
  const raw = [
    { rowNumber: 2, columnA: "" },
    { rowNumber: 3, columnA: "Custom Software Engineer" },
    { rowNumber: 4, columnA: "" },
    { rowNumber: 5, columnA: "ATCI-5751644-S2068697 | Posting Date: 10/06/2026 | Bengaluru" },
    { rowNumber: 6, columnA: "" },
    { rowNumber: 7, columnA: "Senior Data Analyst" },
    { rowNumber: 8, columnA: "" },
    { rowNumber: 9, columnA: "ATCI-5751645-S2068698|Posting Date:11/07/2026|Chennai" },
  ];
  const result = cleanPostedSheetRows(raw);
  assert(result.blankRowsRemoved === 4, `expected 4 blank rows removed, got ${result.blankRowsRemoved}`);
  assert(result.noJrIdRowsRemoved === 2, `expected 2 title-line rows removed, got ${result.noJrIdRowsRemoved}`);
  assert(result.kept.length === 2, `expected 2 kept rows, got ${result.kept.length}`);
  assert(result.needsLookCount === 0, "no needsLook rows expected in this fixture");
  assert(result.changed === true, "raw tab must report changed=true");
  assert(
    result.kept[0].columnA === "ATCI-5751644-S2068697 | Posting Date: 10/06/2026 | Bengaluru",
    "row 5 must stay byte-identical (already canonical)"
  );
  assert(
    result.kept[1].columnA === "ATCI-5751645-S2068698 | Posting Date: 11/07/2026 | Chennai",
    `row 9 (no spaces around pipes) must be normalized to canonical spacing, got "${result.kept[1].columnA}"`
  );
}

// --- (b) clean tab: only canonical lines — nothing should change ---
{
  const raw = [
    { rowNumber: 2, columnA: "ATCI-1111111-S1000001 | Posting Date: 01/02/2026 | Pune" },
    { rowNumber: 3, columnA: "ATCI-2222222-S2000002 | Posting Date: 03/04/2026 | Mumbai" },
  ];
  const result = cleanPostedSheetRows(raw);
  assert(result.blankRowsRemoved === 0 && result.noJrIdRowsRemoved === 0, "clean tab must remove nothing");
  assert(result.kept.length === 2, "clean tab must keep both rows");
  assert(result.changed === false, "already-clean tab must report changed=false (skip Drive upload)");
}

// --- mixed raw + clean lines in the same tab ---
{
  const raw = [
    { rowNumber: 2, columnA: "ATCI-3333333-S3000003 | Posting Date: 05/06/2026 | Delhi" }, // already clean
    { rowNumber: 3, columnA: "ATCI-4444444-S4000004  Posting   Date :  07/08/2026 | Noida" }, // raw spacing
  ];
  const result = cleanPostedSheetRows(raw);
  assert(result.kept.length === 2, "mixed tab must keep both rows");
  assert(result.rows[0].kind === "clean" && (result.rows[0] as { unchanged: boolean }).unchanged === true, "already-clean row must be marked unchanged");
  assert(result.rows[1].kind === "clean" && (result.rows[1] as { unchanged: boolean }).unchanged === false, "raw row must be marked changed");
  assert(
    result.kept[1].columnA === "ATCI-4444444-S4000004 | Posting Date: 07/08/2026 | Noida",
    `raw spacing must normalize to canonical form, got "${result.kept[1].columnA}"`
  );
}

// --- duplicate JR IDs: kept as two separate rows, not collapsed ---
{
  const raw = [
    { rowNumber: 2, columnA: "ATCI-5555555-S5000005 | Posting Date: 09/10/2026 | Pune" },
    { rowNumber: 3, columnA: "ATCI-5555555-S5000005 | Posting Date: 09/10/2026 | Pune" },
  ];
  const result = cleanPostedSheetRows(raw);
  assert(result.kept.length === 2, "duplicate JR IDs must both be kept as separate rows");
  assert(result.kept[0].jobRequisitionId === result.kept[1].jobRequisitionId, "both rows share the same JR ID");
}

// --- odd dashes: a non-ASCII dash right after "ATCI" fails closed (no JR ID found, deleted) ---
{
  const raw = [{ rowNumber: 2, columnA: "ATCI–123–S1 | Posting Date: 01/01/2026 | Pune" }];
  const result = cleanPostedSheetRows(raw);
  assert(result.noJrIdRowsRemoved === 1, "an en-dash right after ATCI must not match the JR ID pattern — fails closed, deleted and counted");
}

// --- two JR IDs on one line: ambiguous, needs a look, line left untouched ---
{
  const original = "ATCI-111-S1 ATCI-222-S2 | Posting Date: 05/06/2026 | Delhi";
  const raw = [{ rowNumber: 2, columnA: original }];
  const result = cleanPostedSheetRows(raw);
  assert(result.needsLookCount === 1, "two JR IDs on one line must be flagged needs-a-look, not guessed at");
  const outcome = result.rows[0];
  assert(outcome.kind === "needsLook" && outcome.reason === "ambiguous_second_jr_id", "reason must be ambiguous_second_jr_id");
  assert(outcome.kind === "needsLook" && outcome.columnA === original, "ambiguous line must be left byte-identical, never rewritten");
  assert(outcome.kind === "needsLook" && outcome.jobRequisitionId === "ATCI-111-S1", "the first JR ID is still extracted for Column B");
}

// --- unclear date: JR ID present but no "Posting Date" found — kept as-is, counted ---
{
  const original = "ATCI-333-S3 | some other text | Pune";
  const raw = [{ rowNumber: 2, columnA: original }];
  const result = cleanPostedSheetRows(raw);
  assert(result.needsLookCount === 1, "missing posting date must be needs-a-look");
  const outcome = result.rows[0];
  assert(outcome.kind === "needsLook" && outcome.reason === "no_posting_date", "reason must be no_posting_date");
  assert(outcome.kind === "needsLook" && outcome.columnA === original, "line with unclear date must never be deleted or rewritten");
}

// --- a JR ID is NEVER deleted, even when ambiguous ---
{
  const raw = [
    { rowNumber: 2, columnA: "ATCI-999-S9 | no date here at all" },
  ];
  const result = cleanPostedSheetRows(raw);
  assert(result.kept.length === 1, "a line with a JR ID must always be kept, never deleted");
}

// --- date is kept verbatim, never reparsed (would silently swap day/month otherwise) ---
{
  const raw = [{ rowNumber: 2, columnA: "ATCI-777-S7 | Posting Date: 03/04/2026 | Pune" }];
  const result = cleanPostedSheetRows(raw);
  assert(result.kept[0].columnA.includes("03/04/2026"), "the exact date digits must be carried through verbatim, never reformatted");
}

// --- idempotency: clean(clean(x)) === clean(x) ---
{
  const original = "ATCI-888-S8  Posting Date:  12/11/2026   |   Hyderabad";
  const firstPass = parsePostedSheetLine(original);
  assert(firstPass.kind === "clean", "first pass must classify as clean");
  const firstOutput = (firstPass as { columnA: string }).columnA;

  const secondPass = parsePostedSheetLine(firstOutput);
  assert(secondPass.kind === "clean", "second pass over the first pass's own output must also classify as clean");
  const secondOutput = (secondPass as { columnA: string }).columnA;

  assert(firstOutput === secondOutput, `idempotency violated: "${firstOutput}" !== "${secondOutput}"`);
}

// --- two full runs in a row over the same input are byte-identical (JSON deep-equal) ---
{
  const raw = [
    { rowNumber: 2, columnA: "" },
    { rowNumber: 3, columnA: "Not a JR line" },
    { rowNumber: 4, columnA: "ATCI-123456-S1234567 | Posting Date: 01/02/2026 | Pune" },
  ];
  const runOnce = cleanPostedSheetRows(raw);
  const runTwice = cleanPostedSheetRows(raw);
  assert(
    JSON.stringify(runOnce) === JSON.stringify(runTwice),
    "running the cleaner twice over the same input must produce byte-identical results"
  );
}

// --- additional fixtures requested 2026-10-08, each stating the expected outcome ---

// Multi-word city -> kept clean, city carried through as-is.
{
  const result = cleanPostedSheetRows([{ rowNumber: 2, columnA: "ATCI-6001-S1 | Posting Date: 01/01/2026 | Navi Mumbai" }]);
  assert(result.kept[0].columnA === "ATCI-6001-S1 | Posting Date: 01/01/2026 | Navi Mumbai", "multi-word city must be kept clean, verbatim");
}

// City with a comma -> kept clean, comma is just part of the city text.
{
  const result = cleanPostedSheetRows([{ rowNumber: 2, columnA: "ATCI-6002-S1 | Posting Date: 01/01/2026 | Pune, Maharashtra" }]);
  assert(result.kept[0].columnA === "ATCI-6002-S1 | Posting Date: 01/01/2026 | Pune, Maharashtra", "comma in city must be kept clean, verbatim");
}

// Single-digit month/day -> kept clean, date digits kept exactly as written (no zero-padding, no reparsing).
{
  const result = cleanPostedSheetRows([{ rowNumber: 2, columnA: "ATCI-6003-S1 | Posting Date: 9/4/2026 | Pune" }]);
  assert(result.kept[0].columnA === "ATCI-6003-S1 | Posting Date: 9/4/2026 | Pune", "single-digit month/day must be kept exactly as written");
}

// Extra spaces around "|" -> kept clean, normalized to single-space-pipe-single-space.
{
  const result = cleanPostedSheetRows([{ rowNumber: 2, columnA: "ATCI-6004-S1    |     Posting Date: 02/02/2026     |      Chennai" }]);
  assert(result.kept[0].columnA === "ATCI-6004-S1 | Posting Date: 02/02/2026 | Chennai", "extra spaces around | must be normalized to canonical spacing");
}

// Trailing spaces -> kept clean, trimmed.
{
  const result = cleanPostedSheetRows([{ rowNumber: 2, columnA: "ATCI-6005-S1 | Posting Date: 03/03/2026 | Mumbai     " }]);
  assert(result.kept[0].columnA === "ATCI-6005-S1 | Posting Date: 03/03/2026 | Mumbai", "trailing spaces must be trimmed");
}

// Non-breaking spaces -> kept clean, NBSP treated as ordinary whitespace.
{
  const result = cleanPostedSheetRows([{ rowNumber: 2, columnA: "ATCI-6006-S1 | Posting Date: 04/04/2026 | Delhi" }]);
  assert(result.kept[0].columnA === "ATCI-6006-S1 | Posting Date: 04/04/2026 | Delhi", "non-breaking spaces must be normalized like ordinary spaces");
}

// Windows line breaks inside a cell -> kept clean, CRLF collapsed to a single space.
{
  const result = cleanPostedSheetRows([{ rowNumber: 2, columnA: "ATCI-6007-S1 | Posting Date:\r\n05/05/2026 | Hyderabad" }]);
  assert(result.kept[0].columnA === "ATCI-6007-S1 | Posting Date: 05/05/2026 | Hyderabad", "Windows line breaks must collapse to a single space");
}

// Lowercase "atci" -> DELETED as no-JR-ID. Case-sensitive by design, matching the
// existing Executive reader's own precedent (VBA `Like "ATCI*"` is case-sensitive).
{
  const result = cleanPostedSheetRows([{ rowNumber: 2, columnA: "atci-6008-s1 | Posting Date: 06/06/2026 | Pune" }]);
  assert(result.noJrIdRowsRemoved === 1, "lowercase atci must be deleted as no-JR-ID, matching established case-sensitive precedent");
}

// Title line containing a number -> DELETED as no-JR-ID (a number alone doesn't make it a JR ID).
{
  const result = cleanPostedSheetRows([{ rowNumber: 2, columnA: "Software Engineer 2" }]);
  assert(result.noJrIdRowsRemoved === 1, "a title line with a number in it must still be deleted as no-JR-ID");
}

// JR ID present but no city at all -> needs-a-look (NOT deleted, NOT guessed at from the date text).
{
  const original = "ATCI-6009-S1 | Posting Date: 07/07/2026";
  const result = cleanPostedSheetRows([{ rowNumber: 2, columnA: original }]);
  assert(result.needsLookCount === 1, "JR ID + date but no city must be needs-a-look, not deleted");
  const outcome = result.rows[0];
  assert(outcome.kind === "needsLook" && outcome.reason === "no_city", "reason must be no_city");
  assert(outcome.kind === "needsLook" && outcome.columnA === original, "line must be left byte-identical when city is missing");
}

console.log("verify-posted-sheet-row-cleaner: OK");
