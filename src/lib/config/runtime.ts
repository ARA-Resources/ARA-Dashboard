/**
 * Server-side runtime configuration.
 * No personal Windows paths, no production secrets, no Drive IDs in source.
 */
import fs from "node:fs";
import path from "node:path";

export function isProductionEnv(): boolean {
  return process.env.NODE_ENV === "production";
}

export function missingConfigError(name: string): Error {
  return new Error(`Required production configuration ${name} is missing.`);
}

function trimEnv(name: string): string {
  return process.env[name]?.trim() ?? "";
}

export function peekAppUrl(): string {
  const value = trimEnv("ARA_APP_URL") || trimEnv("NEXT_PUBLIC_APP_URL");
  return value.replace(/\/$/, "");
}

export function getAppUrl(): string {
  const configured = peekAppUrl();
  if (configured) return configured;
  if (!isProductionEnv()) return "http://localhost:3000";
  throw missingConfigError("ARA_APP_URL");
}

export function getGmailAccount(): string {
  return trimEnv("GMAIL_ACCOUNT") || trimEnv("ARA_GMAIL_ADDRESS");
}

export function getLateralMasterDriveFileId(): string {
  const id = trimEnv("ARA_LATERAL_MASTER_DRIVE_FILE_ID");
  if (!id) {
    throw missingConfigError("ARA_LATERAL_MASTER_DRIVE_FILE_ID");
  }
  return id;
}

export function getLateralMasterDriveViewUrl(): string {
  return `https://drive.google.com/file/d/${getLateralMasterDriveFileId()}/view`;
}

export function getLateralExcelPath(): string | undefined {
  const fromEnv = trimEnv("ARA_LATERAL_EXCEL_PATH");
  if (fromEnv) return fromEnv;
  return undefined;
}

/** If ARA_LATERAL_EXCEL_PATH is set, it must exist. Does not print the path. */
export function assertConfiguredLateralExcelPath(): void {
  const configured = getLateralExcelPath();
  if (!configured) return;
  try {
    fs.accessSync(configured);
  } catch {
    throw new Error(
      "Configured ARA_LATERAL_EXCEL_PATH does not exist or is not readable."
    );
  }
}

export function getBundledLateralExcelPath(): string {
  return path.join(process.cwd(), "data", "excel", "lateral-mastersheet.xlsm");
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
    fs.accessSync(configured);
  } catch {
    throw new Error(
      "Configured ARA_EXECUTIVE_EXCEL_PATH does not exist or is not readable."
    );
  }
}

export function getBundledExecutiveExcelPath(): string {
  return path.join(process.cwd(), "data", "excel", "executive-mastersheet.xlsm");
}

/** Optional Executive Gmail sender filter (`from:`). Empty = not configured. */
export function peekExecutiveGmailFrom(): string {
  return trimEnv("ARA_EXECUTIVE_GMAIL_FROM");
}

/** Optional Executive Gmail subject filter (`subject:`). Empty = not configured. */
export function peekExecutiveGmailSubject(): string {
  return trimEnv("ARA_EXECUTIVE_GMAIL_SUBJECT");
}

/**
 * Optional comma-separated Gmail keyword terms for Executive discovery.
 * Empty = not configured. Do not invent defaults in code.
 */
export function peekExecutiveGmailKeywords(): string[] {
  const raw = trimEnv("ARA_EXECUTIVE_GMAIL_KEYWORDS");
  if (!raw) return [];
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * Optional attachment filename pattern (substring or /regex/).
 * Empty = any .xlsm matching other search criteria.
 */
export function peekExecutiveAttachmentPattern(): string {
  return trimEnv("ARA_EXECUTIVE_ATTACHMENT_PATTERN");
}

/** Optional Google Drive folder for Executive source workbook uploads. */
export function peekExecutiveDriveFolderId(): string {
  return trimEnv("ARA_EXECUTIVE_DRIVE_FOLDER_ID");
}

/**
 * Destination Google Spreadsheet for Executive New Sheet import (Phase 4B).
 * Empty → use the confirmed default ID in executive-dataset-mapping.
 */
export function peekExecutiveNewSheetSpreadsheetId(): string {
  return trimEnv("ARA_EXECUTIVE_NEW_SHEET_SPREADSHEET_ID");
}

export function getOAuthRedirectUri(): string {
  return (
    trimEnv("GOOGLE_GMAIL_REDIRECT_URI") ||
    trimEnv("GOOGLE_REDIRECT_URI") ||
    `${getAppUrl()}/api/dataset/gmail/oauth/callback`
  );
}

export function getDatasetSetupSecret(): string {
  return trimEnv("ARA_DATASET_SETUP_SECRET") || trimEnv("ARA_SETUP_SECRET");
}

export const PRODUCTION_REQUIRED_ENV = [
  "ARA_SESSION_SECRET",
  "ARA_DASHBOARD_PASSWORD",
  "ARA_DATASET_SETUP_SECRET",
  "ARA_APP_URL",
  "ARA_LATERAL_MASTER_DRIVE_FILE_ID",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
] as const;

export function missingProductionConfigNames(): string[] {
  const missing: string[] = [];
  for (const name of PRODUCTION_REQUIRED_ENV) {
    if (name === "ARA_APP_URL") {
      if (!peekAppUrl()) missing.push("ARA_APP_URL");
      continue;
    }
    if (name === "ARA_DATASET_SETUP_SECRET") {
      if (!getDatasetSetupSecret()) missing.push("ARA_DATASET_SETUP_SECRET");
      continue;
    }
    if (!trimEnv(name)) missing.push(name);
  }
  return missing;
}

export function assertProductionConfig(): void {
  if (!isProductionEnv()) return;
  const missing = missingProductionConfigNames();
  if (missing.length === 0) return;
  throw new Error(
    missing
      .map((name) => `Required production configuration ${name} is missing.`)
      .join(" ")
  );
}

export function logProductionConfigStatus(): void {
  if (!isProductionEnv()) return;
  const missing = missingProductionConfigNames();
  if (missing.length === 0) {
    console.info("[config] Production configuration variables are present.");
  } else {
    for (const name of missing) {
      console.error(
        `[config] Required production configuration ${name} is missing.`
      );
    }
  }
  try {
    assertConfiguredLateralExcelPath();
  } catch (error) {
    console.error(
      "[config]",
      error instanceof Error ? error.message : error
    );
  }
}
