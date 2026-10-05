/**
 * Parses an uploaded "Accenture Final Report" export (.xlsx) into raw,
 * field-keyed rows.
 *
 * Mirrors candidate-oorwin-parser.ts's shape exactly (SheetJS `xlsx`,
 * anchor-row scan, exact-header match, reject-on-missing-header) — see that
 * file's own doc comment for why `xlsx` (not ExcelJS/openpyxl) is used here.
 *
 * Rejects a wrong file BEFORE any DB access, in both directions: an Oorwin
 * export fed to this parser is missing "Candidate Name"/"Candidate Email"/
 * "Management Level"/etc (Oorwin's own header row has "First Name"/"Email"/
 * "Status" instead) and is rejected here; an Accenture export fed to the
 * Oorwin parser is missing "First Name"/"Last Name"/"Mobile"/"Client
 * Submission JR"/etc and is rejected there — no extra code needed in either
 * parser for this, it falls out of each one's own exact-header-match check.
 * Both parsers' anchor header happens to be the same literal text
 * ("Candidate ID"), which only decides which row to start matching from —
 * the full required-header set still has to match for either parser to
 * accept the file.
 */
import * as XLSX from "xlsx";
import {
  CANDIDATE_ACCENTURE_ANCHOR_HEADER,
  CANDIDATE_ACCENTURE_COLUMN_MAP,
  type CandidateAccentureField,
} from "./candidate-accenture-column-map";

export interface CandidateAccentureParsedRow {
  /** 1-based row number in the source file, for error messages / audit trails. */
  sheetRowNumber: number;
  cid: string;
  name: string;
  email: string;
  /** Raw file text, e.g. "9-Team Lead/Consultant" or "CL9" — reduced to a number by candidate-jml-format.ts, not here. */
  level: string;
  applicationCompletionStatus: string;
  candidateStage: string;
  currentCidSource: string;
}

export interface CandidateAccentureParseSuccess {
  ok: true;
  rows: CandidateAccentureParsedRow[];
  matchedHeaders: Record<CandidateAccentureField, string>;
}

export interface CandidateAccentureParseFailure {
  ok: false;
  message: string;
}

export type CandidateAccentureParseResult =
  | CandidateAccentureParseSuccess
  | CandidateAccentureParseFailure;

function cellToText(raw: unknown): string {
  if (raw === null || raw === undefined) return "";
  if (typeof raw === "number") return Number.isFinite(raw) ? String(raw) : "";
  if (typeof raw === "string") return raw.trim();
  return String(raw).trim();
}

export function parseCandidateAccentureWorkbook(
  buffer: Buffer | ArrayBuffer
): CandidateAccentureParseResult {
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

  let headerRowIndex = -1;
  for (let i = 0; i < grid.length; i += 1) {
    const row = grid[i] ?? [];
    if (row.some((cell) => cellToText(cell) === CANDIDATE_ACCENTURE_ANCHOR_HEADER)) {
      headerRowIndex = i;
      break;
    }
  }
  if (headerRowIndex === -1) {
    return {
      ok: false,
      message: `Could not find a header row containing "${CANDIDATE_ACCENTURE_ANCHOR_HEADER}". Is this a real Accenture Final Report export?`,
    };
  }

  const headerRow = (grid[headerRowIndex] ?? []).map(cellToText);

  const colIndex: Partial<Record<CandidateAccentureField, number>> = {};
  const matchedHeaders: Partial<Record<CandidateAccentureField, string>> = {};
  const missing: string[] = [];

  for (const def of CANDIDATE_ACCENTURE_COLUMN_MAP) {
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
        `Accenture Final Report sheet is missing required column(s): ${missing.join(", ")}.`,
        `Found headers: ${headerRow.filter(Boolean).join(" | ")}`,
      ].join(" "),
    };
  }

  const get = (row: unknown[], field: CandidateAccentureField): string => {
    const idx = colIndex[field];
    return idx === undefined ? "" : cellToText(row[idx]);
  };

  const rows: CandidateAccentureParsedRow[] = [];
  for (let i = headerRowIndex + 1; i < grid.length; i += 1) {
    const row = grid[i] ?? [];
    const isBlank = row.every((cell) => cellToText(cell) === "");
    if (isBlank) continue;

    rows.push({
      sheetRowNumber: i + 1,
      cid: get(row, "cid"),
      name: get(row, "name"),
      email: get(row, "email"),
      level: get(row, "level"),
      applicationCompletionStatus: get(row, "applicationCompletionStatus"),
      candidateStage: get(row, "candidateStage"),
      currentCidSource: get(row, "currentCidSource"),
    });
  }

  return {
    ok: true,
    rows,
    matchedHeaders: matchedHeaders as Record<CandidateAccentureField, string>,
  };
}
