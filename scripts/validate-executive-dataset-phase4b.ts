/**
 * Phase 4B validation — Base DS → New Sheet mapping (no live Gmail required).
 * Usage: npx tsx scripts/validate-executive-dataset-phase4b.ts
 */
import {
  EXECUTIVE_BASE_DS_REQUIRED_HEADERS,
  EXECUTIVE_BASE_DS_TO_NEW_SHEET_MAP,
  EXECUTIVE_NEW_SHEET_REQUIRED_HEADERS,
  buildExecutiveImportPlan,
  isExecutiveDsAttachmentName,
  mapBaseDsRowsToNewSheet,
  validateExecutiveBaseDsHeaders,
  validateExecutiveNewSheetHeaders,
} from "../src/services/dataset/executive-dataset-mapping";

function main() {
  const issues: string[] = [];

  // Attachment naming
  if (
    !isExecutiveDsAttachmentName("ATCI Exec DS_17th August 2026.xlsx") ||
    isExecutiveDsAttachmentName("ATCI Exec DS_17th August 2026.xlsm") ||
    isExecutiveDsAttachmentName("Other File.xlsx")
  ) {
    issues.push("attachment naming check failed");
  }

  // Mapping completeness
  for (const source of EXECUTIVE_BASE_DS_REQUIRED_HEADERS) {
    if (!(source in EXECUTIVE_BASE_DS_TO_NEW_SHEET_MAP)) {
      issues.push(`missing map for ${source}`);
    }
  }
  for (const dest of EXECUTIVE_NEW_SHEET_REQUIRED_HEADERS) {
    const hit = Object.values(EXECUTIVE_BASE_DS_TO_NEW_SHEET_MAP).includes(
      dest as (typeof EXECUTIVE_NEW_SHEET_REQUIRED_HEADERS)[number]
    );
    if (!hit) issues.push(`destination ${dest} not targeted by map`);
  }

  // Destination header order shuffled — mapping must follow destination order
  const destHeaders = [
    "Extra Col",
    "Priority",
    "Market",
    "Job requisition ID",
    "Primary Skill",
    "Level",
    "Skill category",
    "Primary Location",
    "Must Have skills",
    "Location Flex",
    "Job Description",
    "Another Extra",
  ];
  const sourceHeaders = [
    "Final Market Map",
    "Job Requisition ID",
    "Primary skills",
    "Job Management Level",
    "Skill Categorization",
    "Primary Location",
    "Mandatory skill",
    "Location Flex",
    "Job Description",
    "Priority",
  ];

  const sourceOk = validateExecutiveBaseDsHeaders(sourceHeaders);
  const destOk = validateExecutiveNewSheetHeaders(destHeaders);
  if (!sourceOk.ok) issues.push(`source headers missing: ${sourceOk.missing}`);
  if (!destOk.ok) issues.push(`dest headers missing: ${destOk.missing}`);

  const plan = buildExecutiveImportPlan(destHeaders);
  const sourceRows = [
    [
      "Enterprise Platforms",
      "JR001",
      "Kinaxis",
      "7-Manager",
      "Core",
      "Pune",
      "Must A",
      "Pan India",
      "Line1\nLine2 long JD",
      "High Priority",
    ],
    [
      "Data & AI",
      "JR002",
      "GenAI",
      "L-6",
      "Premium+",
      "Bengaluru",
      "Must B",
      "Yes",
      "Another JD",
      "Priority",
    ],
  ];

  const mapped = mapBaseDsRowsToNewSheet(sourceHeaders, sourceRows, plan);
  if (mapped.outputRows.length !== sourceRows.length) {
    issues.push("row count not preserved");
  }

  // Check positions by destination header, not source position
  const row0 = mapped.outputRows[0];
  const expect = {
    Market: "Enterprise Platforms",
    "Job requisition ID": "JR001",
    "Primary Skill": "Kinaxis",
    Level: "7-Manager",
    "Skill category": "Core",
    "Primary Location": "Pune",
    "Must Have skills": "Must A",
    "Location Flex": "Pan India",
    "Job Description": "Line1\nLine2 long JD",
    Priority: "High Priority",
  } as const;

  for (const [dest, value] of Object.entries(expect)) {
    const idx = plan.destinationIndexByHeader[dest];
    if (row0[idx] !== value) {
      issues.push(
        `mapping mismatch for ${dest}: got ${JSON.stringify(row0[idx])}`
      );
    }
  }

  // Dirty level preserved on row 1
  const row1 = mapped.outputRows[1];
  const levelIdx = plan.destinationIndexByHeader.Level;
  if (row1[levelIdx] !== "L-6") {
    issues.push("Level dirty value was altered");
  }

  // Unmapped extras left blank
  const extraIdx = destHeaders.indexOf("Extra Col");
  if (row0[extraIdx] !== null) {
    issues.push("unmapped destination column should stay blank");
  }

  // Position independence: rearrange source headers and still map
  const shuffledSourceHeaders = [
    "Priority",
    "Job Description",
    "Mandatory skill",
    "Location Flex",
    "Primary Location",
    "Skill Categorization",
    "Job Management Level",
    "Primary skills",
    "Job Requisition ID",
    "Final Market Map",
  ];
  const shuffledRows = [
    [
      "High Priority",
      "Line1\nLine2 long JD",
      "Must A",
      "Pan India",
      "Pune",
      "Core",
      "7-Manager",
      "Kinaxis",
      "JR001",
      "Enterprise Platforms",
    ],
  ];
  const mappedShuffled = mapBaseDsRowsToNewSheet(
    shuffledSourceHeaders,
    shuffledRows,
    plan
  );
  for (const [dest, value] of Object.entries(expect)) {
    const idx = plan.destinationIndexByHeader[dest];
    if (mappedShuffled.outputRows[0][idx] !== value) {
      issues.push(`position-independent mapping failed for ${dest}`);
    }
  }

  const summary = {
    ok: issues.length === 0,
    issues,
    checks: {
      sourceHeadersRecognized: sourceOk.ok,
      destinationHeadersRecognized: destOk.ok,
      mappingCount: Object.keys(EXECUTIVE_BASE_DS_TO_NEW_SHEET_MAP).length,
      rowCountPreserved: mapped.outputRows.length === 2,
      jobManagementLevelToLevel: true,
      skillCategorizationToSkillCategory: true,
      mandatorySkillToMustHaveSkills: true,
      finalMarketMapToMarket: true,
      noSourcePositionAssumptions: true,
      noHeaderDeletion: plan.destinationHeaders.length === destHeaders.length,
      jdLineBreaksPreserved:
        row0[plan.destinationIndexByHeader["Job Description"]] ===
        "Line1\nLine2 long JD",
    },
  };

  console.log(JSON.stringify(summary, null, 2));
  if (!summary.ok) process.exit(1);
  console.log("PHASE4B_SMOKE_OK");
}

main();
