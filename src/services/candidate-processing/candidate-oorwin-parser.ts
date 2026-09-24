/**
 * Parses an uploaded Oorwin "Candidate Master Tracker" export (.xls, .xlsx,
 * or .xlsm) into raw, field-keyed rows.
 *
 * Uses SheetJS (`xlsx`, installed from SheetJS's own CDN — the public npm
 * release has an unpatched prototype-pollution/ReDoS advisory) instead of
 * ExcelJS/openpyxl: verified directly against a real Oorwin .xls export
 * (genuine legacy OLE/BIFF binary format) that BOTH openpyxl and xlrd
 * failed to parse, while `xlsx` reads it correctly in pure JS with no
 * external process.
 *
 * Does NOT combine Name parts, does NOT normalize Mobile, does NOT run the
 * auto-fetch lookup — purely raw extraction. See candidate-field-utils.ts
 * for the name-combining/mobile-normalizing utilities and the sync engine
 * (C5) for how a parsed row becomes a candidate_master row.
 */
import * as XLSX from "xlsx";
import {
  CANDIDATE_OORWIN_ANCHOR_HEADER,
  CANDIDATE_OORWIN_COLUMN_MAP,
  type CandidateOorwinField,
} from "./candidate-oorwin-column-map";

export interface CandidateOorwinParsedRow {
  /** 1-based row number in the source file, for error messages / audit trails. */
  sheetRowNumber: number;
  cid: string;
  firstName: string;
  middleName: string;
  lastName: string;
  email: string;
  /** Raw, unformatted — normalization happens separately. */
  mobile: string;
  gender: string;
  submitter: string;
  customer: string;
  clientSubmissionJr: string;
  customerJobTitle: string;
  market: string;
  clientSpoc: string;
  status: string;
  submittedDate: string;
  reasonForRejection: string;
  submissionComments: string;
}

export interface CandidateOorwinParseSuccess {
  ok: true;
  rows: CandidateOorwinParsedRow[];
  matchedHeaders: Record<CandidateOorwinField, string>;
}

export interface CandidateOorwinParseFailure {
  ok: false;
  message: string;
}

export type CandidateOorwinParseResult =
  | CandidateOorwinParseSuccess
  | CandidateOorwinParseFailure;

/** Oorwin's real Mobile cells are numeric — stringify without scientific notation or a trailing ".0". */
function cellToText(raw: unknown): string {
  if (raw === null || raw === undefined) return "";
  if (typeof raw === "number") return Number.isFinite(raw) ? String(raw) : "";
  if (typeof raw === "string") return raw.trim();
  return String(raw).trim();
}

export function parseCandidateOorwinWorkbook(
  buffer: Buffer | ArrayBuffer
): CandidateOorwinParseResult {
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(buffer, { type: "buffer", raw: true });
  } catch (err) {
    return {
      ok: false,
      message: `Failed to read workbook: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const sheetName = workbook.SheetNames[0];
  if (!sheetName) return { ok: false, message: "Workbook has no sheets." };
  const sheet = workbook.Sheets[sheetName];
  const grid = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    raw: true,
    defval: null,
  });

  // The real header row isn't necessarily row 1 — a decorative title row
  // ("Custom Report") can precede it. Scan for the row containing the
  // anchor header instead of assuming the first non-blank row is it.
  let headerRowIndex = -1;
  for (let i = 0; i < grid.length; i += 1) {
    const row = grid[i] ?? [];
    if (row.some((cell) => cellToText(cell) === CANDIDATE_OORWIN_ANCHOR_HEADER)) {
      headerRowIndex = i;
      break;
    }
  }
  if (headerRowIndex === -1) {
    return {
      ok: false,
      message: `Could not find a header row containing "${CANDIDATE_OORWIN_ANCHOR_HEADER}". Is this a real Oorwin candidate export?`,
    };
  }

  const headerRow = (grid[headerRowIndex] ?? []).map(cellToText);

  const colIndex: Partial<Record<CandidateOorwinField, number>> = {};
  const matchedHeaders: Partial<Record<CandidateOorwinField, string>> = {};
  const missing: string[] = [];

  for (const def of CANDIDATE_OORWIN_COLUMN_MAP) {
    let foundIndex = -1;
    let foundHeader = "";
    for (const alias of def.aliases) {
      const idx = headerRow.findIndex((h) => h === alias);
      if (idx !== -1) {
        foundIndex = idx;
        foundHeader = alias;
        break;
      }
    }
    if (foundIndex === -1) {
      missing.push(def.aliases[0]);
      continue;
    }
    colIndex[def.field] = foundIndex;
    matchedHeaders[def.field] = foundHeader;
  }

  if (missing.length > 0) {
    return {
      ok: false,
      message: [
        `Oorwin sheet is missing required column(s): ${missing.join(", ")}.`,
        `Found headers: ${headerRow.filter(Boolean).join(" | ")}`,
      ].join(" "),
    };
  }

  const get = (row: unknown[], field: CandidateOorwinField): string => {
    const idx = colIndex[field];
    return idx === undefined ? "" : cellToText(row[idx]);
  };

  const rows: CandidateOorwinParsedRow[] = [];
  for (let i = headerRowIndex + 1; i < grid.length; i += 1) {
    const row = grid[i] ?? [];
    const isBlank = row.every((cell) => cellToText(cell) === "");
    if (isBlank) continue;

    rows.push({
      sheetRowNumber: i + 1,
      cid: get(row, "cid"),
      firstName: get(row, "firstName"),
      middleName: get(row, "middleName"),
      lastName: get(row, "lastName"),
      email: get(row, "email"),
      mobile: get(row, "mobile"),
      gender: get(row, "gender"),
      submitter: get(row, "submitter"),
      customer: get(row, "customer"),
      clientSubmissionJr: get(row, "clientSubmissionJr"),
      customerJobTitle: get(row, "customerJobTitle"),
      market: get(row, "market"),
      clientSpoc: get(row, "clientSpoc"),
      status: get(row, "status"),
      submittedDate: get(row, "submittedDate"),
      reasonForRejection: get(row, "reasonForRejection"),
      submissionComments: get(row, "submissionComments"),
    });
  }

  return {
    ok: true,
    rows,
    matchedHeaders: matchedHeaders as Record<CandidateOorwinField, string>,
  };
}
