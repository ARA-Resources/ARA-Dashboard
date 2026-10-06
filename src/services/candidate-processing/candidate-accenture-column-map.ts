/**
 * Header-alias table for a real "Accenture Final Report" export.
 *
 * Exact header spellings below are confirmed directly from a real sample
 * export (Accenture_Final_report.xlsx, 2026-10). Unlike the Oorwin sheet,
 * the real header row is row 0 — no decorative title row precedes it — but
 * the parser (candidate-accenture-parser.ts) still scans forward for the row
 * containing the anchor header rather than assuming row 0, same defensive
 * pattern as the Oorwin parser, in case a future export adds one.
 *
 * Only the 7 fields below are ever read. The real file also carries Agency
 * Name, Entity Name, SubEntity Name, First Source Category, Comments, and
 * Day since referral — none of those are part of this feature and are
 * never read by this column map or the parser built on it.
 *
 * `aliases` holds the canonical spelling first — add further spellings here
 * (never elsewhere) if a future export uses different header text.
 */

export type CandidateAccentureField =
  | "cid"
  | "name"
  | "email"
  | "level"
  | "applicationCompletionStatus"
  | "candidateStage"
  | "currentCidSource";

export interface CandidateAccentureColumnDef {
  field: CandidateAccentureField;
  aliases: readonly string[];
}

export const CANDIDATE_ACCENTURE_COLUMN_MAP: readonly CandidateAccentureColumnDef[] = [
  { field: "cid", aliases: ["Candidate ID"] },
  { field: "name", aliases: ["Candidate Name"] },
  { field: "email", aliases: ["Candidate Email"] },
  { field: "level", aliases: ["Management Level"] },
  { field: "applicationCompletionStatus", aliases: ["Application Completion Status"] },
  { field: "candidateStage", aliases: ["Candidate Stage"] },
  {
    field: "currentCidSource",
    aliases: ["Current CID Source (As per candidate latest application)"],
  },
] as const;

/** The header text the parser scans for to locate the real header row. */
export const CANDIDATE_ACCENTURE_ANCHOR_HEADER =
  CANDIDATE_ACCENTURE_COLUMN_MAP.find((c) => c.field === "cid")!.aliases[0];
