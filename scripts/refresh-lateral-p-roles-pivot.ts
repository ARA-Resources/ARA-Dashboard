/**
 * Refresh P-Roles Pivot Table source from Google Sheet Master Sheet data.
 * Updates existing pivot in place — does not create duplicates or copy Excel.
 *
 * Run: npx tsx scripts/refresh-lateral-p-roles-pivot.ts
 * Force full reconfigure: npx tsx scripts/refresh-lateral-p-roles-pivot.ts --force
 */
import { refreshLateralPRolesPivotTable } from "../src/services/lateral-processing/lateral-p-roles-sheets-pivot";

async function main() {
  const force = process.argv.includes("--force");
  const result = await refreshLateralPRolesPivotTable({
    forceReconfigure: force,
    applyAppearance: force,
  });
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
