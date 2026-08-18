/**
 * Shared Dataset Google connection (ONE OAuth for all dataset types).
 *
 * Architecture:
 *   Common Gmail Connection  → Lateral / Executive / Consulting
 *   Common Drive Connection  → Lateral / Executive / Consulting
 *
 * Tokens live only in the encrypted backend store (gmail-oauth.enc.json).
 * Never expose refresh/access tokens to the frontend.
 */

import { readDatasetSetup } from "@/services/dataset/secure-store";
import { readSyncWatermark } from "@/services/dataset/sync-watermark-store";
import {
  getAuthorizedGmailClient,
  isGmailOAuthConfigured,
  readGmailAuth,
} from "@/services/gmail/oauth";
import { getCalendarDateInTimezone } from "@/services/gmail/query";
import {
  SHARED_DATASET_CONNECTION_TYPES,
  type DatasetConnectionLabel,
  type SharedGoogleConnectionStatus,
} from "@/types/dataset-google-connection";

function connectionLabel(connected: boolean): DatasetConnectionLabel {
  return connected ? "Connected" : "Not Connected";
}

function hasDriveScope(scope: string | null | undefined): boolean {
  if (!scope) return false;
  return (
    scope.includes("https://www.googleapis.com/auth/drive") ||
    scope.includes("https://www.googleapis.com/auth/drive.file")
  );
}

function hasGmailScope(scope: string | null | undefined): boolean {
  if (!scope) return false;
  return (
    scope.includes("https://www.googleapis.com/auth/gmail.readonly") ||
    scope.includes("https://www.googleapis.com/auth/gmail.")
  );
}

/**
 * Resolve shared Gmail + Drive connection status from the single OAuth store.
 * Optionally probes Drive about.get when tokens are present to confirm Drive access.
 */
export async function getSharedGoogleConnectionStatus(options?: {
  probeDrive?: boolean;
}): Promise<SharedGoogleConnectionStatus> {
  const probeDrive = options?.probeDrive !== false;
  const oauthConfigured = isGmailOAuthConfigured();
  const setup = await readDatasetSetup();
  const watermark = await readSyncWatermark();
  const stored = await readGmailAuth();

  const base = {
    oauthConfigured,
    shared: true as const,
    datasetTypes: SHARED_DATASET_CONNECTION_TYPES,
    today: getCalendarDateInTimezone(),
    lastSuccessfulSyncAt: watermark.lastSuccessfulSyncAt,
    lastSuccessfulSyncAtMs: watermark.lastSuccessfulSyncAtMs,
    lastTrigger: watermark.lastTrigger,
  };

  if (!stored?.tokens.refresh_token && !stored?.tokens.access_token) {
    return {
      ...base,
      email: null,
      expectedEmail: setup?.gmailAddress ?? null,
      connectedAt: null,
      updatedAt: null,
      gmail: { connected: false, label: connectionLabel(false) },
      drive: { connected: false, label: connectionLabel(false) },
      scope: null,
      error:
        "Google account is not connected. Complete OAuth once for Gmail and Drive.",
    };
  }

  try {
    const { auth, drive } = await getAuthorizedGmailClient();
    const scope = auth.tokens.scope ?? null;
    const gmailOk = hasGmailScope(scope) || Boolean(auth.tokens.access_token);
    let driveOk = hasDriveScope(scope);

    if (probeDrive) {
      try {
        await drive.about.get({ fields: "user(emailAddress)" });
        driveOk = true;
      } catch {
        driveOk = hasDriveScope(scope);
      }
    }

    return {
      ...base,
      email: auth.email,
      expectedEmail: setup?.gmailAddress ?? auth.expectedEmail,
      connectedAt: auth.connectedAt,
      updatedAt: auth.updatedAt,
      gmail: { connected: gmailOk, label: connectionLabel(gmailOk) },
      drive: { connected: driveOk, label: connectionLabel(driveOk) },
      scope,
    };
  } catch (error) {
    return {
      ...base,
      email: stored.email ?? null,
      expectedEmail: setup?.gmailAddress ?? stored.expectedEmail ?? null,
      connectedAt: stored.connectedAt ?? null,
      updatedAt: stored.updatedAt ?? null,
      gmail: { connected: false, label: connectionLabel(false) },
      drive: { connected: false, label: connectionLabel(false) },
      scope: stored.tokens.scope ?? null,
      error:
        error instanceof Error
          ? error.message
          : "Shared Google connection is not available.",
    };
  }
}

/**
 * Backward-compatible Gmail status shape used by existing callers,
 * extended with explicit shared Drive status.
 */
export async function getGmailConnectionStatus() {
  const status = await getSharedGoogleConnectionStatus({ probeDrive: true });
  return {
    oauthConfigured: status.oauthConfigured,
    connected: status.gmail.connected,
    email: status.email,
    expectedEmail: status.expectedEmail,
    connectedAt: status.connectedAt,
    updatedAt: status.updatedAt,
    today: status.today,
    lastSuccessfulSyncAt: status.lastSuccessfulSyncAt,
    lastSuccessfulSyncAtMs: status.lastSuccessfulSyncAtMs,
    lastTrigger: status.lastTrigger,
    shared: status.shared,
    datasetTypes: status.datasetTypes,
    gmail: status.gmail,
    drive: status.drive,
    scope: status.scope,
    ...(status.error ? { error: status.error } : {}),
  };
}