/**
 * Verify shared Dataset Google connection status (no tokens printed).
 */
import { getSharedGoogleConnectionStatus } from "../src/services/dataset/google-connection";

async function main() {
  const status = await getSharedGoogleConnectionStatus({ probeDrive: true });
  const safe = {
    oauthConfigured: status.oauthConfigured,
    shared: status.shared,
    datasetTypes: status.datasetTypes,
    email: status.email,
    gmail: status.gmail,
    drive: status.drive,
    hasScope: Boolean(status.scope),
    error: status.error ?? null,
  };
  console.log(JSON.stringify(safe, null, 2));

  if (!status.shared) {
    throw new Error("Expected shared: true");
  }
  if (!status.datasetTypes.includes("Lateral") || !status.datasetTypes.includes("Executive") || !status.datasetTypes.includes("Consulting")) {
    throw new Error("Expected Lateral, Executive, Consulting in datasetTypes");
  }
  if (status.gmail.label !== "Connected" && status.gmail.label !== "Not Connected") {
    throw new Error(`Unexpected gmail label: ${status.gmail.label}`);
  }
  if (status.drive.label !== "Connected" && status.drive.label !== "Not Connected") {
    throw new Error(`Unexpected drive label: ${status.drive.label}`);
  }
  // Ensure we never accidentally surface tokens on this object
  const raw = JSON.stringify(status);
  if (raw.includes("refresh_token") || raw.includes("access_token")) {
    throw new Error("Status payload must not include OAuth tokens");
  }
  console.log("PASS shared connection status shape");
}

main().catch((err) => {
  console.error("FAIL", err);
  process.exit(1);
});
