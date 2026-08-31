/**
 * Minimal runtime config for encrypted dataset setup reads.
 * Matches Next.js `src/lib/config/runtime.ts` secret semantics.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { resolveRepoRoot } from "./repo-root.js";

export function isProductionEnv(): boolean {
  return process.env.NODE_ENV === "production";
}

export function missingConfigError(name: string): Error {
  return new Error(`Required production configuration ${name} is missing.`);
}

function trimEnv(name: string): string {
  return process.env[name]?.trim() ?? "";
}

export function getDatasetSetupSecret(): string {
  return trimEnv("ARA_DATASET_SETUP_SECRET") || trimEnv("ARA_SETUP_SECRET");
}

export function peekAppUrl(): string {
  return trimEnv("ARA_APP_URL") || trimEnv("NEXT_PUBLIC_APP_URL");
}

export function getAppUrl(): string {
  const configured = peekAppUrl();
  if (configured) return configured;
  if (!isProductionEnv()) return "http://localhost:3000";
  throw missingConfigError("ARA_APP_URL");
}

export function getOAuthRedirectUri(): string {
  return (
    trimEnv("GOOGLE_GMAIL_REDIRECT_URI") ||
    trimEnv("GOOGLE_REDIRECT_URI") ||
    `${getAppUrl()}/api/dataset/gmail/oauth/callback`
  );
}

export function getExecutiveMasterDriveFileId(): string {
  const id = trimEnv("ARA_EXECUTIVE_MASTER_DRIVE_FILE_ID");
  if (!id) {
    throw missingConfigError("ARA_EXECUTIVE_MASTER_DRIVE_FILE_ID");
  }
  return id;
}

/** Non-throwing peek for optional Drive configuration. */
export function peekExecutiveMasterDriveFileId(): string {
  return trimEnv("ARA_EXECUTIVE_MASTER_DRIVE_FILE_ID");
}

export function getExecutiveMasterDriveViewUrl(): string {
  return `https://drive.google.com/file/d/${getExecutiveMasterDriveFileId()}/view`;
}

export function getExecutiveExcelPath(): string | undefined {
  const fromEnv = trimEnv("ARA_EXECUTIVE_EXCEL_PATH");
  if (fromEnv) return fromEnv;
  return undefined;
}

/** If ARA_EXECUTIVE_EXCEL_PATH is set, it must exist. Does not print the path. */
export function assertConfiguredExecutiveExcelPath(): void {
  const configured = getExecutiveExcelPath();
  if (!configured) return;
  try {
    if (!existsSync(configured)) {
      throw new Error("missing");
    }
  } catch {
    throw new Error(
      "Configured ARA_EXECUTIVE_EXCEL_PATH does not exist or is not readable."
    );
  }
}

export function getBundledExecutiveExcelPath(): string {
  return path.join(
    resolveRepoRoot(),
    "data",
    "excel",
    "executive-mastersheet.xlsm"
  );
}
