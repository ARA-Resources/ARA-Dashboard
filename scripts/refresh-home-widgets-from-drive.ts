/**
 * Refresh Home Overview Lateral KPIs from Drive XLSM Master Sheet.
 * Run: npx tsx scripts/refresh-home-widgets-from-drive.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { refreshLateralHomeWidgetsMetricsFromDriveXlsm } from "../src/services/home/refresh-lateral-home-widgets-metrics";
import { readHomeWidgetsMetricsSnapshot } from "../src/services/home/home-widgets-metrics-store";

async function main() {
  const result = await refreshLateralHomeWidgetsMetricsFromDriveXlsm({
    bypassCache: true,
  });
  console.log("refresh", JSON.stringify(result, null, 2));
  const snap = await readHomeWidgetsMetricsSnapshot();
  console.log("snapshot.lateral", JSON.stringify(snap.units.lateral, null, 2));
  const lat = snap.units.lateral;
  const exec = snap.units.executive;
  const cons = snap.units.consulting;
  console.log("overview totals", {
    totalOpen:
      (lat?.totals ?? 0) + (exec?.totals ?? 0) + (cons?.totals ?? 0),
    active:
      (lat?.active ?? 0) + (exec?.active ?? 0) + (cons?.active ?? 0),
    posted:
      (lat?.posted ?? 0) + (exec?.posted ?? 0) + (cons?.posted ?? 0),
    fresh: (lat?.fresh ?? 0) + (exec?.fresh ?? 0) + (cons?.fresh ?? 0),
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
