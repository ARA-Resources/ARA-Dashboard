/**
 * Phase 4C — Executive Master Sheet reconciliation validation (fixture + optional live dry-run).
 *
 * Does NOT write the live Executive Master Sheet.
 *
 * Run:
 *   npx tsx scripts/validate-executive-master-reconciliation-phase4c.ts
 *   npx tsx scripts/validate-executive-master-reconciliation-phase4c.ts --live-dry-run
 */

import type { ExecutiveMasterSheetRow } from "@/services/excel/executive-master-sheet";
import { EXECUTIVE_MASTER_LIVE_COLUMNS } from "@/services/excel/executive-master-sheet";
import {
  runExecutiveMasterReconcileDryRun,
  type ExecutiveNewSheetRow,
  type ExecutivePostedSheetRow,
} from "@/services/executive-processing/executive-master-reconcile-engine";
import { resolveExecutiveJobStatus } from "@/services/executive-processing/executive-job-status-rules";
import {
  buildExecutivePostedJrSet,
  resolveExecutivePostedValue,
} from "@/services/executive-processing/executive-posted-rules";

function blankMaster(
  id: string,
  jr: string,
  overrides: Partial<ExecutiveMasterSheetRow> = {}
): ExecutiveMasterSheetRow {
  const row = { id } as ExecutiveMasterSheetRow;
  for (const col of EXECUTIVE_MASTER_LIVE_COLUMNS) {
    row[col] = null;
  }
  row["Job Requisition ID"] = jr;
  Object.assign(row, overrides);
  return row;
}

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

function runFixtureTests() {
  const processingDate = new Date(2026, 7, 21); // 21-08-2026

  // 1. Existing unchanged JR (Active sticky via Activated path when status was Active/blank)
  {
    const r = resolveExecutiveJobStatus({
      existsInNewSheet: true,
      existsInMasterSheet: true,
      existingMasterStatus: "Active",
    });
    assert(r?.status === "Active" && r.action === "Activated", "case1 Active");
  }

  // 2. New JR
  {
    const r = resolveExecutiveJobStatus({
      existsInNewSheet: true,
      existsInMasterSheet: false,
    });
    assert(r?.status === "New" && r.createRow === true, "case2 New");
  }

  // 3. Previously closed JR returning → Reopen
  {
    const r = resolveExecutiveJobStatus({
      existsInNewSheet: true,
      existsInMasterSheet: true,
      existingMasterStatus: "Closed",
    });
    assert(
      r?.status === "Reopen" && r.updateDateOfNewJr === true,
      "case3 Reopen"
    );
  }

  // 4. Existing active JR (blank status → Active)
  {
    const r = resolveExecutiveJobStatus({
      existsInNewSheet: true,
      existsInMasterSheet: true,
      existingMasterStatus: "",
    });
    assert(r?.status === "Active", "case4 blank→Active");
  }

  // 5. JR absent from New Sheet → Closed (row kept)
  {
    const r = resolveExecutiveJobStatus({
      existsInNewSheet: false,
      existsInMasterSheet: true,
      existingMasterStatus: "Active",
    });
    assert(r?.status === "Closed" && r.createRow === false, "case5 Closed");
  }

  // 6–8 Posted
  {
    const set = buildExecutivePostedJrSet([
      { jobRequisitionId: "JR-YES-1" },
      { postingText: "JR-YES-2 | Posting Date: 08/18/2026 | Pune" },
      { jobRequisitionId: "JR-DUP" },
      { jobRequisitionId: "JR-DUP" },
    ]);
    assert(resolveExecutivePostedValue("JR-YES-1", set) === "Yes", "case6 Yes");
    assert(resolveExecutivePostedValue("JR-MISSING", set) === "-", "case7 dash");
    assert(set.has("JR-YES-2"), "case8 extract from A");
    assert(set.size === 3, "case8 multi posted rows → unique set size 3");
  }

  // 9–10 Duplicates
  {
    const master = [
      blankMaster("m1", "DUP-NEW"),
      blankMaster("m2", "KEEP"),
    ];
    const neu: ExecutiveNewSheetRow[] = [
      { "Job requisition ID": "DUP-NEW", Market: "A" },
      { "Job requisition ID": "DUP-NEW", Market: "B" },
      { "Job requisition ID": "KEEP", Market: "C" },
    ];
    const result = runExecutiveMasterReconcileDryRun({
      masterRows: master,
      newSheetRows: neu,
      postedSheetRows: [],
      processingDate,
    });
    assert(!result.ok, "case9 duplicates block ok");
    assert(
      result.duplicates.some(
        (d) => d.sheet === "New Sheet" && d.jobRequisitionId === "DUP-NEW"
      ),
      "case9 new dup reported"
    );
    assert(result.masterSheetWritePerformed === false, "case9 no write");
  }
  {
    const master = [
      blankMaster("m1", "DUP-M"),
      blankMaster("m2", "DUP-M"),
    ];
    const neu: ExecutiveNewSheetRow[] = [
      { "Job requisition ID": "X", Market: "A" },
    ];
    const result = runExecutiveMasterReconcileDryRun({
      masterRows: master,
      newSheetRows: neu,
      postedSheetRows: [],
      processingDate,
    });
    assert(
      result.duplicates.some(
        (d) => d.sheet === "Master Sheet" && d.jobRequisitionId === "DUP-M"
      ),
      "case10 master dup"
    );
  }

  // 11 Manual sticky New / Reopen
  {
    assert(
      resolveExecutiveJobStatus({
        existsInNewSheet: true,
        existsInMasterSheet: true,
        existingMasterStatus: "New",
      })?.status === "New",
      "case11 sticky New"
    );
    assert(
      resolveExecutiveJobStatus({
        existsInNewSheet: true,
        existsInMasterSheet: true,
        existingMasterStatus: "Reopen",
      })?.updateDateOfNewJr === false,
      "case11 sticky Reopen no date rewrite"
    );
  }

  // 12 Historical date preservation + 13 empty + 14 dirty Level
  {
    const master = [
      blankMaster("m1", "JR-KEEP-DATE", {
        "Job Status": "Active",
        "Date of New JR": "01-01-2025",
        "Opened on Oorwin": "15-02-2024",
        Level: "6",
        Posted: "-",
        "Team Manual": "Alice",
      }),
      blankMaster("m2", "JR-CLOSED", {
        "Job Status": "Closed",
        "Date of New JR": "10-10-2024",
        Level: "7-Manager",
      }),
      blankMaster("m3", "JR-ABSENT", {
        "Job Status": "Active",
        "Date of New JR": "11-11-2024",
      }),
    ];
    const neu: ExecutiveNewSheetRow[] = [
      {
        "Job requisition ID": "JR-KEEP-DATE",
        Market: "Banking",
        Level: "6",
        "Primary Skill": "Java",
        Priority: "",
      },
      {
        "Job requisition ID": "JR-CLOSED",
        Market: "Tech",
        Level: "7-Manager",
        "Primary Skill": "Python",
      },
      {
        "Job requisition ID": "JR-BRAND-NEW",
        Market: "NewM",
        Level: "5-Associate Director",
        "Primary Skill": "Go",
      },
    ];
    const posted: ExecutivePostedSheetRow[] = [
      { jobRequisitionId: "JR-KEEP-DATE" },
    ];
    const result = runExecutiveMasterReconcileDryRun({
      masterRows: master,
      newSheetRows: neu,
      postedSheetRows: posted,
      processingDate,
    });
    assert(result.ok, `case12 ok: ${result.blockers.join("; ")}`);
    assert(result.dryRun === true, "dryRun");
    assert(result.masterSheetWritePerformed === false, "no write");

    const keep = result.projectedMasterRows.find(
      (r) => r["Job Requisition ID"] === "JR-KEEP-DATE"
    )!;
    assert(keep["Date of New JR"] === "01-01-2025", "case12 preserve Date of New JR");
    assert(keep["Opened on Oorwin"] === "15-02-2024", "case12 preserve Opened");
    assert(keep["Team Manual"] === "Alice", "case12 preserve Team Manual");
    assert(keep.Level === "6", "case14 dirty Level preserved as-is");
    assert(keep.Posted === "Yes", "posted Yes");
    assert(keep.Market === "Banking", "incoming Market updated");

    const reopened = result.projectedMasterRows.find(
      (r) => r["Job Requisition ID"] === "JR-CLOSED"
    )!;
    assert(reopened["Job Status"] === "Reopen", "reopen status");
    assert(reopened["Date of New JR"] === "21-08-2026", "reopen date today");

    const closed = result.projectedMasterRows.find(
      (r) => r["Job Requisition ID"] === "JR-ABSENT"
    )!;
    assert(closed["Job Status"] === "Closed", "absent → Closed");
    assert(closed["Date of New JR"] === "11-11-2024", "closed date preserved");

    const neuRow = result.projectedMasterRows.find(
      (r) => r["Job Requisition ID"] === "JR-BRAND-NEW"
    )!;
    assert(neuRow["Job Status"] === "New", "new status");
    assert(neuRow["Date of New JR"] === "21-08-2026", "new date set");
    assert(neuRow.Posted === "-", "new not posted");

    assert(result.counts.new === 1, "count new");
    assert(result.counts.reopen === 1, "count reopen");
    assert(result.counts.closed === 1, "count closed");
    assert(result.counts.postedYes === 1, "count posted yes");
  }

  console.log("PHASE4C_FIXTURE_OK");
}

async function runLiveDryRun() {
  const { runExecutiveMasterReconcileDryRunService } = await import(
    "@/services/executive-processing/executive-master-reconcile-service"
  );
  const result = await runExecutiveMasterReconcileDryRunService();
  console.log(
    JSON.stringify(
      {
        ok: result.ok,
        dryRun: result.dryRun,
        masterSheetWritePerformed: result.masterSheetWritePerformed,
        blockers: result.blockers,
        duplicates: result.duplicates.slice(0, 20),
        counts: result.counts,
        notes: result.notes,
        sources: result.sources,
        changeSample: result.changes.slice(0, 10),
      },
      null,
      2
    )
  );
  if (!result.ok) {
    console.log("PHASE4C_LIVE_DRY_RUN_BLOCKED");
    process.exitCode = 2;
    return;
  }
  console.log("PHASE4C_LIVE_DRY_RUN_OK");
}

async function runLocalWorkbookDryRun() {
  const { runExecutiveMasterReconcileDryRunFromLocalWorkbook } = await import(
    "@/services/executive-processing/executive-master-reconcile-local"
  );
  const result = await runExecutiveMasterReconcileDryRunFromLocalWorkbook();
  console.log(
    JSON.stringify(
      {
        ok: result.ok,
        dryRun: result.dryRun,
        masterSheetWritePerformed: result.masterSheetWritePerformed,
        blockers: result.blockers,
        duplicates: result.duplicates.slice(0, 20),
        counts: result.counts,
        notes: result.notes,
        sources: result.sources,
        changeSample: result.changes.slice(0, 10),
      },
      null,
      2
    )
  );
  console.log(
    result.ok
      ? "PHASE4C_LOCAL_WORKBOOK_DRY_RUN_OK"
      : "PHASE4C_LOCAL_WORKBOOK_DRY_RUN_BLOCKED"
  );
  if (!result.ok) process.exitCode = 2;
}

async function main() {
  runFixtureTests();
  if (process.argv.includes("--live-dry-run")) {
    await runLiveDryRun();
  }
  if (
    process.argv.includes("--local-workbook-dry-run") ||
    process.argv.includes("--workbook-dry-run")
  ) {
    await runLocalWorkbookDryRun();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
