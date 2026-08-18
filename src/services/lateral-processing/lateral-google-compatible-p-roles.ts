/**
 * Google-Sheets-compatible P-Roles display inside the production XLSM.
 *
 * Writes Excel-safe IF/COUNTIFS formulas onto the existing P-Roles worksheet
 * below the Excel PivotTable skeleton (rows 1-7). Does not create a new spreadsheet.
 * Does not rewrite PivotCache / pivotTable XML / VBA / Master / Posted / New Sheet.
 */
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getAuthorizedGmailClient } from "@/services/gmail/oauth";
import { XLSM_MIME } from "@/services/lateral-processing/lateral-final-master-save";
import {
  extractMasterPRolesFeed,
  getProductionXlsmId,
  JML_ORDER,
  type PRolesFeedExtract,
} from "@/services/lateral-processing/lateral-google-p-roles-native";

const execFileAsync = promisify(execFile);

export function getProductionPRolesFileId(): string {
  return getProductionXlsmId();
}
export const PRODUCTION_P_ROLES_FILE_NAME =
  "Copy of ATCI Lateral DS AI MasterSheet Final 2026.xlsm";

const INJECT_PY = path.join(
  process.cwd(),
  "scripts",
  "_inject-p-roles-google-display.py"
);

export interface GoogleCompatiblePRolesIndependent {
  defaultStatus: string[];
  jmlCounts: Record<string, number>;
  grandTotal: number;
  withClosedGrandTotal: number;
  pairCount: number;
}

export interface RefreshGoogleCompatiblePRolesResult {
  ok: true;
  fileId: string;
  uploaded: boolean;
  sheetPart: string;
  pairCount: number;
  masterRowCount: number;
  independent: GoogleCompatiblePRolesIndependent;
  headerRow: number;
  dataStartRow: number;
  totalRow: number;
  jmlOrder: string[];
}

function independentCounts(rows: string[][], statuses: string[]) {
  const statusSet = new Set(statuses);
  const jmlCounts: Record<string, number> = {
    "8-Associate Manager": 0,
    "9-Team Lead/Consultant": 0,
    "10-Senior Analyst": 0,
    "11-Analyst": 0,
    "12-Associate": 0,
  };
  for (const row of rows) {
    const jml = row[3] || "";
    const status = row[4] || "";
    if (!statusSet.has(status)) continue;
    if (jml in jmlCounts) jmlCounts[jml] += 1;
  }
  const grandTotal = JML_ORDER.reduce((sum, name) => sum + jmlCounts[name], 0);
  return { jmlCounts, grandTotal };
}

export function buildPRolesDisplaySpec(extract: PRolesFeedExtract) {
  const seen = new Set<string>();
  const pairs: string[][] = [];
  const markets = new Set<string>();
  for (const row of extract.rows) {
    const skill = row[1] || "";
    const cat = row[2] || "";
    const jml = row[3] || "";
    const market = row[6] || "";
    if (market) markets.add(market);
    if (!(JML_ORDER as readonly string[]).includes(jml)) continue;
    const key = `${skill}\u0000${cat}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push([skill, cat]);
  }
  const defaultStatus = ["Active", "New", "Reopen"];
  const independent = independentCounts(extract.rows, defaultStatus);
  const withClosed = independentCounts(extract.rows, [
    "Active",
    "New",
    "Reopen",
    "Closed",
  ]);
  return {
    pairs,
    markets: Array.from(markets).sort((a, b) => a.localeCompare(b)),
    independent: {
      defaultStatus,
      jmlCounts: independent.jmlCounts,
      grandTotal: independent.grandTotal,
      withClosedGrandTotal: withClosed.grandTotal,
      pairCount: pairs.length,
    } satisfies GoogleCompatiblePRolesIndependent,
  };
}

async function downloadProductionXlsm(dest: string) {
  const { drive } = await getAuthorizedGmailClient();
  const meta = await drive.files.get({
    fileId: getProductionPRolesFileId(),
    fields: "id,name,md5Checksum,size,modifiedTime,trashed,mimeType",
    supportsAllDrives: true,
  });
  if (meta.data.trashed) {
    throw new Error("Production XLSM is in trash. Refusing to untrash or modify it.");
  }
  if (meta.data.id !== getProductionPRolesFileId()) {
    throw new Error("Production file ID mismatch.");
  }
  const media = await drive.files.get(
    { fileId: getProductionPRolesFileId(), alt: "media", supportsAllDrives: true },
    { responseType: "arraybuffer" }
  );
  await fs.writeFile(dest, Buffer.from(media.data as ArrayBuffer));
  return meta.data;
}

async function runInject(src: string, specPath: string, dest: string) {
  const { stdout } = await execFileAsync("python", [INJECT_PY, src, specPath, dest], {
    windowsHide: true,
    timeout: 180_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  const parsed = JSON.parse((stdout || "").trim() || "{}") as {
    ok?: boolean;
    error?: string;
    sheetPart?: string;
    pairCount?: number;
    headerRow?: number;
    dataStartRow?: number;
    totalRow?: number;
    jmlOrder?: string[];
  };
  if (!parsed.ok) {
    throw new Error(parsed.error || "P-Roles display inject failed");
  }
  return parsed;
}

/**
 * Rebuild the Google-compatible P-Roles display on a local XLSM copy.
 * Set commitToProduction true only after pivot/VBA validation passes.
 */
export async function refreshGoogleCompatiblePRoles(options?: {
  commitToProduction?: boolean;
  localXlsmPath?: string;
  outputPath?: string;
}): Promise<RefreshGoogleCompatiblePRolesResult> {
  const workDir = path.join(os.tmpdir(), `p-roles-gs-display-${Date.now()}`);
  await fs.mkdir(workDir, { recursive: true });
  const downloaded = options?.localXlsmPath
    ? options.localXlsmPath
    : path.join(workDir, "production.xlsm");
  if (!options?.localXlsmPath) {
    await downloadProductionXlsm(downloaded);
  }
  const extract = await extractMasterPRolesFeed(downloaded);
  const spec = buildPRolesDisplaySpec(extract);
  const specPath = path.join(workDir, "spec.json");
  await fs.writeFile(
    specPath,
    JSON.stringify({ pairs: spec.pairs, markets: spec.markets }),
    "utf8"
  );
  const dest = options?.outputPath || path.join(workDir, "with-display.xlsm");
  const injected = await runInject(downloaded, specPath, dest);

  if (options?.commitToProduction) {
    const { drive } = await getAuthorizedGmailClient();
    await drive.files.update({
      fileId: getProductionPRolesFileId(),
      requestBody: {
        name: PRODUCTION_P_ROLES_FILE_NAME,
        mimeType: XLSM_MIME,
      },
      media: {
        mimeType: XLSM_MIME,
        body: createReadStream(dest),
      },
      fields: "id,name,mimeType",
      supportsAllDrives: true,
    });
  }

  return {
    ok: true,
    fileId: getProductionPRolesFileId(),
    uploaded: Boolean(options?.commitToProduction),
    sheetPart: injected.sheetPart || "",
    pairCount: spec.pairs.length,
    masterRowCount: extract.rowCount,
    independent: spec.independent,
    headerRow: injected.headerRow || 17,
    dataStartRow: injected.dataStartRow || 18,
    totalRow: injected.totalRow || 18 + spec.pairs.length,
    jmlOrder: injected.jmlOrder || [...JML_ORDER],
  };
}
