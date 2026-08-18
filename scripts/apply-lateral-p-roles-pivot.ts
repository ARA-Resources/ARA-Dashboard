import { config } from "dotenv";
config({ path: ".env.local" });

/**
 * Apply Lateral P-Roles Google Sheets Pivot Table.
 * Run: npx tsx scripts/apply-lateral-p-roles-pivot.ts
 *
 * Uses Google Sheet Master Sheet data only (never local Excel as pivot source).
 */
import { applyLateralPRolesPivotTable } from "../src/services/lateral-processing/lateral-p-roles-sheets-pivot";

async function main() {
  const result = await applyLateralPRolesPivotTable({ forceAppearance: true });
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
