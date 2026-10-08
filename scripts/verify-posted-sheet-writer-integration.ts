/**
 * Integration test for the local-file half of the Posted button (row
 * deletes, font normalization, AutoFilter fix-up, Master Sheet column
 * write, "every other tab unchanged") against a synthetic fixture — no
 * Drive, no Postgres, no real credentials.
 *
 * Known, stated limitation: openpyxl cannot fabricate a real VBA project,
 * so this does NOT exercise macro/vbaProject preservation against a real
 * macro-enabled file — that can only be verified against the real
 * workbook, which this harness must never touch.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { readPostedSheetTabRaw } from "../src/services/dataset-posted/posted-sheet-reader";
import { cleanPostedSheetRows } from "../src/services/dataset-posted/posted-sheet-row-cleaner";
import { writePostedSheetLocal, type PostedSheetWriteRowInstruction } from "../src/services/dataset-posted/posted-sheet-writer";
import { snapshotOtherTabs, findUnexpectedTabChanges } from "../src/services/dataset-posted/posted-sheet-integrity-check";

const execFileAsync = promisify(execFile);

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

async function main() {
  const fixturePath = path.join(os.tmpdir(), `posted-fixture-${Date.now()}.xlsx`);
  const builderPath = path.join(__dirname, "fixtures", "build-posted-sheet-fixture.py");
  await execFileAsync("python3", [builderPath, fixturePath]);

  try {
    const excludeFromCheck = ["Posted Sheet", "Master Sheet"];
    const before = await snapshotOtherTabs(fixturePath, excludeFromCheck);
    assert(before.ok, `before-snapshot must succeed: ${!before.ok ? before.reason : ""}`);

    const raw = await readPostedSheetTabRaw(fixturePath, "Posted Sheet");
    assert(raw.ok, `raw read must succeed: ${!raw.ok ? raw.reason : ""}`);
    if (!raw.ok) return;

    const cleaned = cleanPostedSheetRows(raw.rows);
    assert(cleaned.blankRowsRemoved === 2, `expected 2 blank rows removed, got ${cleaned.blankRowsRemoved}`);
    assert(cleaned.noJrIdRowsRemoved === 1, `expected 1 title-line row removed, got ${cleaned.noJrIdRowsRemoved}`);
    assert(cleaned.needsLookCount === 1, `expected 1 needs-a-look row, got ${cleaned.needsLookCount}`);
    assert(cleaned.kept.length === 2, `expected 2 kept rows, got ${cleaned.kept.length}`);

    const matchedJrIds = new Set(["ATCI-7001-S1"]);
    const rowsToWrite: PostedSheetWriteRowInstruction[] = cleaned.rows
      .filter((r) => r.kind === "clean" || r.kind === "needsLook")
      .map((r) =>
        r.kind === "clean"
          ? { rowNumber: r.rowNumber, columnA: r.columnA, columnB: r.jobRequisitionId, columnC: matchedJrIds.has(r.jobRequisitionId) ? "Yes" : "No" }
          : { rowNumber: r.rowNumber, columnA: null, columnB: r.jobRequisitionId, columnC: matchedJrIds.has(r.jobRequisitionId) ? "Yes" : "No" }
      );
    const rowsToDelete = cleaned.rows.filter((r) => r.kind === "deleteBlank" || r.kind === "deleteNoJrId").map((r) => r.rowNumber);

    const writeResult = await writePostedSheetLocal({
      localPath: fixturePath,
      postedSheetName: "Posted Sheet",
      rowsToDelete,
      rowsToWrite,
      masterColumnWrite: {
        sheetName: "Master Sheet",
        jrHeader: "Job Requisition ID",
        postedHeader: "Posted",
        matchedJrIds: [...matchedJrIds],
      },
    });
    assert(writeResult.ok, `write must succeed: ${!writeResult.ok ? writeResult.reason : ""}`);
    if (!writeResult.ok) return;
    assert(writeResult.finalDataRowCount === 2, `expected 2 final data rows, got ${writeResult.finalDataRowCount}`);
    assert(writeResult.masterRowsUpdated === 2, `expected 2 Master Sheet rows updated, got ${writeResult.masterRowsUpdated}`);

    const after = await snapshotOtherTabs(fixturePath, excludeFromCheck);
    assert(after.ok, `after-snapshot must succeed: ${!after.ok ? after.reason : ""}`);
    if (before.ok && after.ok) {
      const unexpected = findUnexpectedTabChanges(before.hashes, after.hashes);
      assert(unexpected.length === 0, `expected zero unexpected tab changes, got: ${unexpected.join(", ")}`);
    }

    const rawAfter = await readPostedSheetTabRaw(fixturePath, "Posted Sheet");
    assert(rawAfter.ok, "re-read after write must succeed");
    if (rawAfter.ok) {
      assert(rawAfter.rows.length === 2, `expected 2 data rows after edit, got ${rawAfter.rows.length}`);
      assert(
        rawAfter.rows[0].columnA === "ATCI-7001-S1 | Posting Date: 01/01/2026 | Pune",
        `row 1 Column A mismatch: ${rawAfter.rows[0].columnA}`
      );
      assert(rawAfter.rows[0].columnB === "ATCI-7001-S1", "row 1 Column B must be the JR ID");
      assert(rawAfter.rows[0].columnC === "Yes", "row 1 Column C must be Yes (matched)");
      assert(
        rawAfter.rows[1].columnA === "ATCI-7002-S1 | Posting Date: 02/02/2026",
        `row 2 (needs-a-look) Column A must be left untouched, got: ${rawAfter.rows[1].columnA}`
      );
      assert(rawAfter.rows[1].columnB === "ATCI-7002-S1", "row 2 Column B must still get the JR ID");
      assert(rawAfter.rows[1].columnC === "No", "row 2 Column C must be No (not matched)");
    }

    // Independent re-inspection via a fresh python process: auto_filter span, font, Master Sheet values.
    const inspectScript = `
import json, sys
from openpyxl import load_workbook
path = sys.argv[1]
wb = load_workbook(path, data_only=False)
posted = wb["Posted Sheet"]
master = wb["Master Sheet"]
result = {
    "autoFilterRef": posted.auto_filter.ref,
    "row2Font": [posted.cell(2, 1).font.name, posted.cell(2, 1).font.size],
    "row3Font": [posted.cell(3, 2).font.name, posted.cell(3, 2).font.size],
    "masterB2": master["B2"].value,
    "masterB3": master["B3"].value,
    "headerRow": [posted.cell(1, 1).value, posted.cell(1, 2).value, posted.cell(1, 3).value],
}
print(json.dumps(result))
`.trim();
    const inspectPath = path.join(os.tmpdir(), `posted-fixture-inspect-${Date.now()}.py`);
    await fs.writeFile(inspectPath, inspectScript, "utf8");
    const { stdout } = await execFileAsync("python3", [inspectPath, fixturePath]);
    const inspected = JSON.parse(stdout.trim()) as {
      autoFilterRef: string;
      row2Font: [string, number];
      row3Font: [string, number];
      masterB2: string;
      masterB3: string;
      headerRow: [string, string, string];
    };
    await fs.unlink(inspectPath).catch(() => undefined);

    assert(inspected.autoFilterRef === "A1:D3", `AutoFilter must preserve the A:D span with the new row count, got "${inspected.autoFilterRef}"`);
    assert(inspected.row2Font[0] === "Calibri" && inspected.row2Font[1] === 11, `row 2 font must be normalized to Calibri/11, got ${JSON.stringify(inspected.row2Font)}`);
    assert(inspected.row3Font[0] === "Calibri" && inspected.row3Font[1] === 11, `row 3 (needs-a-look) font must ALSO be normalized, got ${JSON.stringify(inspected.row3Font)}`);
    assert(inspected.masterB2 === "Yes", `Master Sheet row for the matched JR must become "Yes", got "${inspected.masterB2}"`);
    assert(inspected.masterB3 === "-", `Master Sheet row for the unmatched JR must become "-", got "${inspected.masterB3}"`);
    assert(
      inspected.headerRow[0] === "Job Requisition" && inspected.headerRow[1] === "Job Requisition ID" && inspected.headerRow[2] === "Demand",
      `header row must be completely untouched, got ${JSON.stringify(inspected.headerRow)}`
    );

    console.log(
      "verify-posted-sheet-writer-integration: OK (NOTE: does not exercise real VBA/macro preservation — openpyxl cannot fabricate a real vbaProject fixture; that can only be checked against the real workbook)"
    );
  } finally {
    await fs.unlink(fixturePath).catch(() => undefined);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
