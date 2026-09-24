/**
 * Header-alias table for a real Oorwin "Candidate Master Tracker" export.
 *
 * Exact header spellings below are confirmed directly from a real sample
 * export ("ACCI Candidate Master Tracker Test - Anurag Shah-4.xls",
 * 2026-09). The sheet's real first row is a decorative "Custom Report"
 * title, not the header row — the parser (candidate-oorwin-parser.ts) scans
 * forward for the row containing the `cid` field's canonical header instead
 * of assuming row 1 is the header row.
 *
 * Modeled on lateral-column-mapping.ts's abort-on-missing-header shape.
 * `aliases` holds the canonical spelling first; add further spellings here
 * (never elsewhere) if a future export uses different header text — no
 * other file should hardcode an Oorwin header string.
 */

export type CandidateOorwinField =
  | "cid"
  | "firstName"
  | "middleName"
  | "lastName"
  | "email"
  | "mobile"
  | "gender"
  | "submitter"
  | "customer"
  | "clientSubmissionJr"
  | "customerJobTitle"
  | "market"
  | "clientSpoc"
  | "status"
  | "submittedDate"
  | "reasonForRejection"
  | "submissionComments";

export interface CandidateOorwinColumnDef {
  field: CandidateOorwinField;
  aliases: readonly string[];
}

export const CANDIDATE_OORWIN_COLUMN_MAP: readonly CandidateOorwinColumnDef[] = [
  { field: "cid", aliases: ["Candidate ID"] },
  { field: "firstName", aliases: ["First Name"] },
  { field: "middleName", aliases: ["Middle Name"] },
  { field: "lastName", aliases: ["Last Name"] },
  { field: "email", aliases: ["Email"] },
  { field: "mobile", aliases: ["Mobile"] },
  { field: "gender", aliases: ["Gender"] },
  { field: "submitter", aliases: ["Submitter"] },
  { field: "customer", aliases: ["Customer"] },
  { field: "clientSubmissionJr", aliases: ["Client Submission JR"] },
  { field: "customerJobTitle", aliases: ["Customer Job Title"] },
  { field: "market", aliases: ["Market"] },
  { field: "clientSpoc", aliases: ["Client SPOC"] },
  { field: "status", aliases: ["Status"] },
  { field: "submittedDate", aliases: ["Submitted Date"] },
  { field: "reasonForRejection", aliases: ["Reason for Rejection"] },
  { field: "submissionComments", aliases: ["Submission Comments"] },
] as const;

/** The header text the parser scans for to locate the real header row. */
export const CANDIDATE_OORWIN_ANCHOR_HEADER =
  CANDIDATE_OORWIN_COLUMN_MAP.find((c) => c.field === "cid")!.aliases[0];
