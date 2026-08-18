/**
 * Verify P-Roles data-source architecture (Google Sheet only).
 * Run: npx tsx scripts/verify-lateral-p-roles-source-architecture.ts
 */
import { verifyPRolesDataSourceArchitecture } from "../src/services/lateral-processing/lateral-p-roles-sheets-pivot";

async function main() {
  const architecture = await verifyPRolesDataSourceArchitecture();
  console.log(JSON.stringify(architecture, null, 2));
  console.log("");
  console.log("P-Roles source spreadsheet:");
  console.log(architecture.sourceSpreadsheetName);
  console.log("");
  console.log("P-Roles source tab:");
  console.log(architecture.sourceTab);
  console.log("");
  console.log("P-Roles source range:");
  console.log(architecture.sourceRange);
  console.log("");
  console.log("Master Sheet read-only by P-Roles:");
  console.log(architecture.masterSheetReadOnlyByPRoles);
  console.log("");
  console.log("VERIFICATION_PASSED");
}

main().catch((error) => {
  console.error(error);
  console.error("VERIFICATION_FAILED");
  process.exit(1);
});
