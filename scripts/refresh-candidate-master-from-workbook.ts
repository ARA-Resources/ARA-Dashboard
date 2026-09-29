/**
 * ONE-TIME refresh of `candidate_master` from the ACCI "Candidate Master
 * Tracker" workbook (sheet "ATCI") — a separate, independently-maintained
 * export, NOT an Oorwin sheet. Deliberately bypasses the live Oorwin
 * Upload/sync engine (candidate-sync-engine.ts), whose semantics are wrong
 * for this case: it skips blank CIDs, quarantines invalid ones, and
 * collapses same-name duplicate CIDs down to one row. This script instead
 * matches every workbook row to at most one existing `candidate_master`
 * row, keeps every row (never merges/deletes), and inserts what's left.
 *
 * Run AFTER scripts/cleanup-candidate-master-rows.ts and its migration
 * (020) have already been applied — this script does not depend on either,
 * but the row-reconciliation numbers it reports assume the cleanup already
 * ran (see the investigation this came out of for the exact expected
 * counts).
 *
 * ============================= MATCHING =============================
 * Five passes, each only touching workbook rows the previous pass left
 * unpaired:
 *  1. CID-based: group workbook + DB rows by a normalized CID (valid
 *     format as-is; paren-wrapped stripped; "X / X" identical-halves
 *     collapsed to X). Within a group, pair by exact normalized name in
 *     TWO PHASES — every exact-name match is claimed first, regardless of
 *     row order, and only THEN are any still-unmatched members in the group
 *     filled from whatever's left in the DB pool. (A single order-dependent
 *     pass here is a real bug, not just a style choice: found live in group
 *     C18916281, which has workbook rows [Devesh Goyal, Devesh Goyal (dup),
 *     Virendra Patel] against DB rows [Devesh Goyal, Virendra Patel] — a
 *     one-pass greedy fallback let the duplicate "Devesh Goyal" row grab the
 *     "Virendra Patel" DB row before the real Virendra Patel workbook row
 *     had a turn, which would have silently overwritten that DB row's name.
 *     Two phases fix this: exact matches always win, no matter where they
 *     fall in excelRow order.) Leftover workbook members with no DB partner
 *     left in the group become inserts.
 *  2. Malformed/blank-CID workbook rows (phone numbers, "submitted", two
 *     different CIDs joined by "/", blank cells, and everything else that
 *     doesn't parse as a CID): match by exact raw CID text against the DB
 *     first (the original 2026-09-15 legacy import stored these verbatim,
 *     so most of them find an exact textual match), then fall back to
 *     Name, then Name+UploadDate, then Name+UploadDate+ContactNumber.
 *  3. Still-unpaired workbook rows with a normalized CID that doesn't
 *     exist anywhere in `candidate_master`: try to backfill onto an
 *     existing `cid='-'` placeholder row by Name+UploadDate+ContactNumber,
 *     then Name+UploadDate+ContactNumber+Submitter, then ContactNumber
 *     alone.
 *  4. GENERALIZED cross-match: for every `candidate_master` row that is
 *     STILL untouched after passes 1-3 and has a real (non-'-') `cid`,
 *     search the remaining unpaired workbook rows for a Name+ContactNumber
 *     match (contact normalized to 10 digits either side). This is how a
 *     workbook CID typo (e.g. an extra digit) doesn't strand a real
 *     existing row as a false "new candidate" — but see the CID guard
 *     below: pass-4 matches NEVER touch `cid`.
 *  5. "Possible same person" overrides (see classifySamePerson): a dashboard
 *     cid that's the SAME cid as an unpaired workbook row's, differing only
 *     by case (e.g. "c27835193" vs "C27835193" — dbResolvedForMatch is
 *     case-sensitive so pass 1 can't group these), or that isn't a valid CID
 *     shape at all (a phone number, free text, ...), matched by Contact
 *     Number ALONE (not name — a mangled CID often comes with a mangled
 *     name too). Unlike pass 4, cid IS written here. A workbook row sharing
 *     Contact Number with a DB row that has a different but validly-shaped
 *     CID is NOT paired here (see POSSIBLE SAME PERSON, categories c/d,
 *     report-only).
 *
 * ============================== WRITE RULES ==============================
 * - Never write: job_requisition_id, submission_comments, email,
 *   client_spoc (no workbook source; untouched on update, '-' on insert).
 * - A blank workbook cell never overwrites an existing non-blank value.
 * - CID:
 *   - Pass-1 matches: write the normalized CID (paren-stripped /
 *     double-identical-collapsed) if it differs from the stored value.
 *   - "Other-malformed" CIDs (no valid CID extractable) are NEVER written
 *     — there's nothing to clean, matches the "left unchanged" rule.
 *   - Pass-2/3 matches ARE cid-based (raw-text or backfilling a blank), so
 *     cid still writes there (blank → real, or malformed-text → same
 *     malformed text, a no-op).
 *   - Pass-4 matches are NOT cid-based by construction (that's why they
 *     needed pass 4) — cid is NEVER written for a pass-4 match, regardless
 *     of what the workbook's CID column says. The existing dashboard cid
 *     is authoritative; the mismatch is flagged for human review instead.
 *   - Pass-5 matches DO write cid (the workbook's clean value) — that's the
 *     entire point of pass 5 (fixing a case-mangled or malformed dashboard
 *     cid), unlike pass 4 (a genuinely different real person's cid).
 * - contact_number / gender ("UNCLEANABLE VALUES"): a workbook value that
 *   doesn't parse (contact isn't 10 digits; gender isn't Male/Female) is
 *   normally just skipped, same as any other blank-never-overwrites case.
 *   BUT if the stored dashboard value is currently '-' (nothing to lose)
 *   and the row's FINAL cid isn't '-' (not a shared placeholder row), the
 *   workbook's raw text is written as-is and flagged (unclean_contact_number
 *   / unclear_gender) instead of silently dropped — applies to inserts too
 *   (a brand-new row's value is '-' by construction). An existing non-'-'
 *   value is NEVER overwritten with an uncleanable one, no matter what.
 * - Real (non-blank, non-'-') `job_requisition_id` on the EXISTING
 *   dashboard row (checked live, not a hardcoded id list): skip `status`,
 *   `submitter`, `submitted_date`, `primary_skills`, `job_management_level`,
 *   `market` entirely for that row. Every other mapped column still
 *   updates normally.
 * - Inserts: every blank workbook value becomes '-'; the 4 never-touched
 *   columns are always '-'; `inserted_sync_id` is set to this run's sync
 *   id; `last_touched_at` is NEVER stamped (neither inserts nor updates).
 * - No `candidate_sync_changes` rows are written by this script, by
 *   design — the operator does not want these rows highlighted green
 *   under "Recently changed". One `candidate_sync_history` row is written
 *   for the whole run (so any flags below have a real sync_id).
 *
 * ================================ FLAGS ================================
 * Never written for a row whose FINAL cid is '-' (that placeholder value
 * is shared by hundreds of unrelated rows — a flag keyed to '-' would
 * incorrectly "light up" all of them; see the investigation for why).
 *  - duplicate_cid: one flag per row, for every non-'-' cid that ends up
 *    on more than one row in the final table (computed from the
 *    PROJECTED post-refresh state, not just the workbook's own
 *    duplicates) — regardless of whether the names agree.
 *  - unclear_gender / unclean_contact_number: written ONLY when the raw
 *    uncleanable value is actually written (see UNCLEANABLE VALUES above)
 *    — i.e. the stored value was '-' and got filled with the workbook's raw
 *    text. NOT written just because the workbook value is unclear; a row
 *    whose existing value is already non-'-' is untouched and unflagged.
 *  - invalid_candidate_id: ANY row in the final table (touched or not —
 *    a live, full-table check, not a hardcoded id list) whose cid is
 *    non-'-' and doesn't match /^C[0-9]+$/.
 *
 * ================================ APPLY ================================
 * Dry-run by default — prints the full report above and writes NOTHING.
 * --apply requires the explicit flag, and even then hard-fails with ZERO
 * writes unless every safety check below holds (never a partial write —
 * either the whole transaction commits, or nothing happens):
 *  - Every count in APPROVED_BASELINE (existing row count, workbook row
 *    count, UPDATE/NO-OP/INSERT/untouched counts, the 4 flag counts) must
 *    match EXACTLY — this re-runs the fixed 5-pass matching + full diff
 *    computation fresh against the CURRENT live DB and workbook file, not
 *    a cached prior result, so any drift since approval (someone edited
 *    candidate_master, re-exported the workbook, a flag got written) is
 *    caught before a single byte changes.
 *  - The untouched row ids and the cid-guard-tripped row ids must match
 *    the approved EXACT sets, not just counts.
 *  - Migration 020 must already be applied — checked live via
 *    `pg_get_constraintdef` on `candidate_review_flags_reason_check`
 *    (must contain both 'duplicate_cid' and 'unclear_gender'), because a
 *    review-flag insert for either reason would otherwise violate the
 *    constraint mid-transaction.
 * If every check passes: one transaction writes the `candidate_sync_history`
 * row, all UPDATEs (only the 12 mapped columns — `inserted_sync_id` and
 * `last_touched_at` are never touched on an update), all INSERTs (with
 * `inserted_sync_id` set to this run's sync id, `last_touched_at` left
 * NULL), then all `candidate_review_flags` rows (duplicate_cid,
 * invalid_candidate_id, unclean_contact_number, unclear_gender — each
 * `detail` carries the real row id, resolved from the just-inserted id for
 * new rows). No `candidate_sync_changes` rows, by design (see FLAGS above).
 *
 * Usage:
 *   npx tsx scripts/refresh-candidate-master-from-workbook.ts               (dry run, default)
 *   npx tsx scripts/refresh-candidate-master-from-workbook.ts --apply       (writes, if every check passes)
 *
 * Before running --apply against prod: take an off-container pg_dump of the
 * 4 touched tables to a file OUTSIDE the repo, e.g.:
 *   pg_dump "$POSTGRES_URL" -t candidate_master -t candidate_review_flags \
 *     -t candidate_sync_changes -t candidate_sync_history \
 *     --no-owner --no-privileges > /path/outside/repo/candidate_tables_$(date +%Y%m%d_%H%M%S).sql
 *   chmod 600 that file.
 * This script does not take the dump itself — do it as a separate step
 * first, same as scripts/cleanup-candidate-master-rows.ts.
 */

import postgres from "postgres";
import * as XLSX from "xlsx";
import { readFileSync, writeFileSync, mkdirSync } from "fs";

const WORKBOOK_PATH = "data/excel/ACCI Candidate Master Tracker 28092026.xlsx";
const WORKBOOK_SHEET = "ATCI";
const REPORT_DIR = "/tmp/candidate-refresh-report";

const HARDCODED_UPLOAD_DATES: Record<number, string> = {
  8317: "11/07/2026", 8318: "11/07/2026", 8319: "11/07/2026", 8320: "11/07/2026",
  8321: "11/07/2026", 8322: "11/07/2026", 8323: "11/07/2026", 8324: "11/07/2026",
  8325: "11/07/2026", 11916: "26/09/2026",
};

const VALID_CID_REGEX = /^C[0-9]+$/;

// ============================== CLEANING ==============================

type CidCategory =
  | "valid" | "paren" | "double-identical" | "blank-in-workbook"
  | "submitted-word" | "double-different" | "phone" | "other-malformed";

interface CidClean {
  category: CidCategory;
  /** Normalized CID used for pass-1 grouping; null if this row can't be grouped this way. */
  resolvedForMatch: string | null;
  /** What pass-1/2/3 (CID-based matches) would write into cid; null means "never write". */
  finalValue: string | null;
  /** Exact raw text used for pass-2's literal-text match attempt. */
  matchByRawText: string | null;
}

function normalizeMobile(raw: string): string | null {
  const digits = (raw || "").replace(/\D/g, "");
  const withoutCC = digits.length === 12 && digits.startsWith("91") ? digits.slice(2) : digits;
  return withoutCC.length === 10 ? withoutCC : null;
}

function cleanCid(raw: string): CidClean {
  const t = (raw || "").trim();
  if (t === "") return { category: "blank-in-workbook", resolvedForMatch: null, finalValue: "-", matchByRawText: null };
  if (VALID_CID_REGEX.test(t)) return { category: "valid", resolvedForMatch: t, finalValue: t, matchByRawText: t };
  const stripped = t.replace(/[()\s]/g, "");
  if (VALID_CID_REGEX.test(stripped) && stripped !== t) {
    return { category: "paren", resolvedForMatch: stripped, finalValue: stripped, matchByRawText: t };
  }
  if (/submitted/i.test(t)) return { category: "submitted-word", resolvedForMatch: null, finalValue: "-", matchByRawText: t };
  const cMatches = t.match(/C[0-9]+/gi) || [];
  if (/\//.test(t) && cMatches.length >= 2) {
    const parts = t.split("/").map((s) => s.trim());
    if (parts.length === 2 && parts[0].toUpperCase() === parts[1].toUpperCase() && VALID_CID_REGEX.test(parts[0])) {
      return { category: "double-identical", resolvedForMatch: parts[0], finalValue: parts[0], matchByRawText: t };
    }
    return { category: "double-different", resolvedForMatch: null, finalValue: "-", matchByRawText: t };
  }
  if (normalizeMobile(t) !== null) return { category: "phone", resolvedForMatch: null, finalValue: "-", matchByRawText: t };
  // Other-malformed: no valid CID extractable — never written (nothing to clean).
  return { category: "other-malformed", resolvedForMatch: null, finalValue: null, matchByRawText: t };
}

interface GenderClean {
  /** null means "don't write" (blank, or unclear — unclear never overwrites). */
  value: "Male" | "Female" | null;
  unclear: boolean;
  rawIfUnclear: string | null;
}
function cleanGender(raw: string): GenderClean {
  const t = (raw || "").trim();
  if (t === "") return { value: null, unclear: false, rawIfUnclear: null };
  const low = t.toLowerCase();
  if (["male", "mle", "m"].includes(low)) return { value: "Male", unclear: false, rawIfUnclear: null };
  if (low === "female") return { value: "Female", unclear: false, rawIfUnclear: null };
  return { value: null, unclear: true, rawIfUnclear: t };
}

function cleanJobManagementLevel(raw: string): string | null {
  const t = (raw || "").trim();
  if (t === "") return null;
  const m = /^cl-?\s*(\d+)$/i.exec(t);
  return m ? `CL${m[1]}` : t;
}

interface ContactClean {
  value: string | null;
  unclean: boolean;
}
function cleanContact(raw: string): ContactClean {
  const t = (raw || "").trim();
  if (t === "") return { value: null, unclean: false };
  const noSpace = t.replace(/\s/g, "");
  if (/^\d{10}$/.test(noSpace)) return { value: noSpace, unclean: false };
  if (/^91\d{10}$/.test(noSpace) && noSpace.length === 12) return { value: noSpace.slice(2), unclean: false };
  return { value: null, unclean: true };
}

function cleanCustomer(raw: string): string | null {
  const t = (raw || "").trim();
  if (t === "") return null;
  return t === "ATCI Vertical" ? "ATCI Lateral" : t;
}

function serialToDdMmYyyy(serial: string): string | null {
  const n = Number(serial);
  if (!Number.isFinite(n) || n <= 0 || n > 60000) return null;
  const epoch = Date.UTC(1899, 11, 30);
  const d = new Date(epoch + n * 86400000);
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${d.getUTCFullYear()}`;
}

function normName(n: string): string {
  return (n || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function isPlaceholder(v: string | null | undefined): boolean {
  const t = (v ?? "").trim();
  return t === "" || t === "-";
}

/** Uppercase + paren/whitespace-stripped — looser than dbResolvedForMatch: doesn't require the result to match VALID_CID_REGEX, only used to detect a same-cid case/whitespace variant. */
function normCidLoose(cid: string): string {
  return (cid || "").replace(/[()\s]/g, "").toUpperCase();
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

/** Loose "is this plausibly the same person's name" check used only for the (c)/(d) split below — never for anything that writes to the DB. */
function namesLookSame(a: string, b: string): boolean {
  const clean = (s: string) => normName(s.replace(/[.,]/g, ""));
  const na = clean(a);
  const nb = clean(b);
  if (na === nb) return true;
  const ta = na.split(" ").filter(Boolean);
  const tb = nb.split(" ").filter(Boolean);
  if (ta.length > 0 && tb.length > 0) {
    const sa = new Set(ta);
    const sb = new Set(tb);
    const subset = (x: Set<string>, y: Set<string>) => [...x].every((t) => y.has(t));
    if (subset(sa, sb) || subset(sb, sa)) return true;
  }
  const compact = (s: string) => s.replace(/\s+/g, "");
  return levenshtein(compact(na), compact(nb)) <= 2;
}

// ============================== TYPES ==============================

interface WbRow {
  excelRow: number;
  cidRaw: string;
  name: string;
  gender: string;
  contact: string;
  uploadRaw: string;
  recruiter: string;
  roleSkill: string;
  mgmtLevel: string;
  vertical: string;
  market: string;
  submittedDateRaw: string;
  remarksStatus: string;
  cidClean: CidClean;
  genderClean: GenderClean;
  jmlClean: string | null;
  contactClean: ContactClean;
  customerClean: string | null;
  uploadDdMmYyyy: string | null;
}

interface DbRow {
  id: number;
  cid: string;
  name: string;
  gender: string;
  contact_number: string;
  date_of_upload: string;
  submitter: string;
  customer: string;
  primary_skills: string;
  job_management_level: string;
  market: string;
  submitted_date: string;
  status: string;
  job_requisition_id: string;
  resolvedForMatch: string | null;
}

function getDb() {
  const url = process.env.POSTGRES_URL?.trim();
  if (!url) throw new Error("POSTGRES_URL is not set. Provide it in the environment or .env.local.");
  return postgres(url, {
    max: 1,
    connect_timeout: 15,
    idle_timeout: 20,
    prepare: false,
    ssl: url.includes("localhost") || url.includes("127.0.0.1") ? false : "require",
  });
}

function dbResolvedForMatch(cid: string): string | null {
  const t = (cid || "").trim();
  if (VALID_CID_REGEX.test(t)) return t;
  const stripped = t.replace(/[()\s]/g, "");
  if (VALID_CID_REGEX.test(stripped) && stripped !== t) return stripped;
  const cMatches = t.match(/C[0-9]+/gi) || [];
  if (/\//.test(t) && cMatches.length >= 2) {
    const parts = t.split("/").map((s) => s.trim());
    if (parts.length === 2 && parts[0].toUpperCase() === parts[1].toUpperCase() && VALID_CID_REGEX.test(parts[0])) {
      return parts[0];
    }
  }
  return null;
}

type SamePersonCategory = "a" | "b" | "c" | "d" | "twin";

/**
 * Classifies a "workbook row shares Contact Number with a differently-CID'd
 * DB row" candidate (see POSSIBLE SAME PERSON below):
 *  - "twin": dbResolvedForMatch already resolves the DB row's cid to the SAME
 *    key as the workbook row's — pass 1 COULD have paired them; any leftover
 *    here is pool exhaustion from a duplicate workbook row (see RESTORED
 *    TWINS), not a same-person bug. Never paired by pass 5, never reported
 *    under POSSIBLE SAME PERSON (already covered by RESTORED TWINS).
 *  - "a": same cid once case AND paren/whitespace are normalized away, but
 *    NOT resolvable by dbResolvedForMatch (which is case-sensitive) — e.g.
 *    dashboard "c27835193" vs workbook "C27835193". Paired by pass 5; CID
 *    written (the workbook's already-clean value).
 *  - "b": the DB cid isn't a valid CID shape at all even loosely (a phone
 *    number, free text, ...). Paired by pass 5; CID replaced with the
 *    workbook's valid one.
 *  - "c" / "d": DB cid is a valid, genuinely different real CID. "c" if the
 *    names plausibly belong to the same person (namesLookSame), else "d".
 *    Both are report-only — never paired, CID never touched.
 */
function classifySamePerson(
  wbResolvedCid: string,
  dbCidRaw: string,
  wbName: string,
  dbName: string
): SamePersonCategory {
  const dbStrict = dbResolvedForMatch(dbCidRaw);
  if (dbStrict === wbResolvedCid) return "twin";
  if (normCidLoose(dbCidRaw) === wbResolvedCid) return "a";
  if (dbStrict === null) return "b";
  return namesLookSame(wbName, dbName) ? "c" : "d";
}

function loadWorkbook(): WbRow[] {
  const buf = readFileSync(WORKBOOK_PATH);
  const wb = XLSX.read(buf, { type: "buffer", raw: true });
  const sheet = wb.Sheets[WORKBOOK_SHEET];
  if (!sheet) throw new Error(`Sheet "${WORKBOOK_SHEET}" not found in ${WORKBOOK_PATH}`);
  const grid: unknown[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null });
  const cellToText = (raw: unknown): string => {
    if (raw === null || raw === undefined) return "";
    if (typeof raw === "number") return Number.isFinite(raw) ? String(raw) : "";
    if (typeof raw === "string") return raw.trim();
    return String(raw).trim();
  };
  const header = (grid[0] || []).map(cellToText);
  const col = (name: string) => header.indexOf(name);
  const IDX = {
    CID: col("CID"), Name: col("Name"), Diversity: col("Diversity"), Contact: col("Contact Number"),
    Upload: col("Date of Upload"), Recruiter: col("Recruiter"), RoleSkill: col("Role Name/Primary Skill"),
    MgmtLevel: col("Management Level /Career Level"), Vertical: col("ATCI - Vertical"), Market: col("Market"),
    SubmittedDate: col("Submitted Date - Tracker (dd/mm/yyyy)"), RemarksStatus: col("Remarks - Status"),
  };
  for (const [k, v] of Object.entries(IDX)) {
    if (v === -1) throw new Error(`Workbook is missing expected column for "${k}"`);
  }

  const rows: WbRow[] = [];
  for (let i = 1; i < grid.length; i += 1) {
    const row = grid[i] || [];
    const isBlank = row.every((c) => cellToText(c) === "");
    if (isBlank) continue;
    const excelRow = i + 1;
    const wr: WbRow = {
      excelRow,
      cidRaw: cellToText(row[IDX.CID]),
      name: cellToText(row[IDX.Name]),
      gender: cellToText(row[IDX.Diversity]),
      contact: cellToText(row[IDX.Contact]),
      uploadRaw: cellToText(row[IDX.Upload]),
      recruiter: cellToText(row[IDX.Recruiter]),
      roleSkill: cellToText(row[IDX.RoleSkill]),
      mgmtLevel: cellToText(row[IDX.MgmtLevel]),
      vertical: cellToText(row[IDX.Vertical]),
      market: cellToText(row[IDX.Market]),
      submittedDateRaw: cellToText(row[IDX.SubmittedDate]),
      remarksStatus: cellToText(row[IDX.RemarksStatus]),
      cidClean: null as unknown as CidClean,
      genderClean: null as unknown as GenderClean,
      jmlClean: null,
      contactClean: null as unknown as ContactClean,
      customerClean: null,
      uploadDdMmYyyy: null,
    };
    wr.cidClean = cleanCid(wr.cidRaw);
    wr.genderClean = cleanGender(wr.gender);
    wr.jmlClean = cleanJobManagementLevel(wr.mgmtLevel);
    wr.contactClean = cleanContact(wr.contact);
    wr.customerClean = cleanCustomer(wr.vertical);
    wr.uploadDdMmYyyy = HARDCODED_UPLOAD_DATES[excelRow] || serialToDdMmYyyy(wr.uploadRaw) || null;
    rows.push(wr);
  }
  return rows;
}

// ============================== PAIRING ==============================

type MatchMethod =
  | "cid-group"
  | "raw-text"
  | "name-fallback"
  | "placeholder-backfill"
  | "cross-match"
  | "same-person-case"
  | "same-person-malformed";

interface PairingResult {
  wbPairedDbId: Map<number, number>; // excelRow -> db id
  matchMethod: Map<number, MatchMethod>;
  dbPaired: Set<number>;
}

function runPairing(wbRows: WbRow[], dbRows: DbRow[]): PairingResult {
  const dbPaired = new Set<number>();
  const wbPairedDbId = new Map<number, number>();
  const matchMethod = new Map<number, MatchMethod>();

  const dbByResolvedCid = new Map<string, DbRow[]>();
  const dbByRawCidText = new Map<string, DbRow[]>();
  const dbByName = new Map<string, DbRow[]>();
  for (const r of dbRows) {
    if (r.resolvedForMatch) {
      const list = dbByResolvedCid.get(r.resolvedForMatch) ?? [];
      list.push(r);
      dbByResolvedCid.set(r.resolvedForMatch, list);
    }
    const rawList = dbByRawCidText.get(r.cid) ?? [];
    rawList.push(r);
    dbByRawCidText.set(r.cid, rawList);
    const nk = normName(r.name);
    const nameList = dbByName.get(nk) ?? [];
    nameList.push(r);
    dbByName.set(nk, nameList);
  }

  // PASS 1: cid-group matching
  const wbByResolved = new Map<string, WbRow[]>();
  for (const r of wbRows) {
    if (r.cidClean.resolvedForMatch) {
      const list = wbByResolved.get(r.cidClean.resolvedForMatch) ?? [];
      list.push(r);
      wbByResolved.set(r.cidClean.resolvedForMatch, list);
    }
  }
  for (const [cidKey, members] of wbByResolved) {
    const dbMembers = (dbByResolvedCid.get(cidKey) ?? []).filter((d) => !dbPaired.has(d.id));
    members.sort((a, b) => a.excelRow - b.excelRow);
    dbMembers.sort((a, b) => a.id - b.id);
    const dbPool = [...dbMembers];
    // Two phases, not one pass with an inline fallback: an exact-name match
    // for a LATER member in this group must not be stolen by an EARLIER
    // member that only matches via the "whatever's left" fallback. (Found
    // live: group C18916281 has workbook members [Devesh Goyal, Devesh
    // Goyal (dup), Virendra Patel] against DB members [Devesh Goyal,
    // Virendra Patel] — a single fallback pass paired the duplicate "Devesh
    // Goyal" row to the "Virendra Patel" DB row before the real Virendra
    // Patel workbook row got a turn, corrupting that DB row's name. Phase 1
    // below claims every exact-name match first, regardless of row order;
    // phase 2 only fills what's left over for members with no exact match.)
    const unmatched: WbRow[] = [];
    for (const w of members) {
      const wn = normName(w.name);
      const idx = dbPool.findIndex((d) => normName(d.name) === wn);
      if (idx !== -1) {
        const d = dbPool.splice(idx, 1)[0];
        dbPaired.add(d.id);
        wbPairedDbId.set(w.excelRow, d.id);
        matchMethod.set(w.excelRow, "cid-group");
      } else {
        unmatched.push(w);
      }
    }
    for (const w of unmatched) {
      if (dbPool.length === 0) break;
      const d = dbPool.shift()!;
      dbPaired.add(d.id);
      wbPairedDbId.set(w.excelRow, d.id);
      matchMethod.set(w.excelRow, "cid-group");
    }
  }

  // PASS 2: malformed/blank-cid rows
  const specialRows = wbRows.filter((r) => !r.cidClean.resolvedForMatch);
  for (const r of specialRows) {
    let matchedDb: DbRow | null = null;
    let method: MatchMethod = "raw-text";
    if (r.cidClean.matchByRawText) {
      const cands = (dbByRawCidText.get(r.cidClean.matchByRawText) ?? []).filter((d) => !dbPaired.has(d.id));
      if (cands.length === 1) matchedDb = cands[0];
    }
    if (!matchedDb) {
      method = "name-fallback";
      const nk = normName(r.name);
      const cands = (dbByName.get(nk) ?? []).filter((d) => !dbPaired.has(d.id));
      if (cands.length === 1) matchedDb = cands[0];
      else if (cands.length > 1) {
        const wbDate = r.uploadDdMmYyyy;
        const dateMatches = cands.filter((d) => wbDate && d.date_of_upload === wbDate);
        if (dateMatches.length === 1) matchedDb = dateMatches[0];
        else {
          const wbMobile = normalizeMobile(r.contact);
          const contactMatches = (dateMatches.length > 1 ? dateMatches : cands).filter(
            (d) => wbMobile && d.contact_number === wbMobile
          );
          if (contactMatches.length === 1) matchedDb = contactMatches[0];
        }
      }
    }
    if (matchedDb) {
      dbPaired.add(matchedDb.id);
      wbPairedDbId.set(r.excelRow, matchedDb.id);
      matchMethod.set(r.excelRow, method);
    }
  }

  // PASS 3: placeholder-cid backfill
  const placeholders = dbRows.filter((d) => d.cid === "-" && !dbPaired.has(d.id));
  const placeholderByName = new Map<string, DbRow[]>();
  for (const p of placeholders) {
    const k = normName(p.name);
    const list = placeholderByName.get(k) ?? [];
    list.push(p);
    placeholderByName.set(k, list);
  }
  const placeholderByContact = new Map<string, DbRow[]>();
  for (const p of placeholders) {
    if (/^\d{10}$/.test(p.contact_number || "")) {
      const list = placeholderByContact.get(p.contact_number) ?? [];
      list.push(p);
      placeholderByContact.set(p.contact_number, list);
    }
  }
  const stillUnpairedValid = wbRows.filter((r) => !wbPairedDbId.has(r.excelRow) && r.cidClean.resolvedForMatch);
  for (const r of stillUnpairedValid) {
    const nk = normName(r.name);
    const nameCands = (placeholderByName.get(nk) ?? []).filter((d) => !dbPaired.has(d.id));
    let matched: DbRow | null = null;
    if (nameCands.length === 1) matched = nameCands[0];
    else if (nameCands.length > 1) {
      const wbDate = r.uploadDdMmYyyy;
      const wbMobile = normalizeMobile(r.contact);
      const both = nameCands.filter((d) => wbDate && d.date_of_upload === wbDate && wbMobile && d.contact_number === wbMobile);
      if (both.length === 1) matched = both[0];
    }
    if (!matched) {
      const wbMobile = normalizeMobile(r.contact);
      const contactCands = wbMobile ? (placeholderByContact.get(wbMobile) ?? []).filter((d) => !dbPaired.has(d.id)) : [];
      if (contactCands.length === 1) matched = contactCands[0];
    }
    if (matched) {
      dbPaired.add(matched.id);
      wbPairedDbId.set(r.excelRow, matched.id);
      matchMethod.set(r.excelRow, "placeholder-backfill");
    }
  }

  // PASS 4: generalized cross-match (untouched real-cid DB rows vs remaining unpaired workbook rows, by Name+Contact)
  const untouchedRealCid = dbRows.filter((d) => !dbPaired.has(d.id) && d.cid !== "-" && d.cid.trim() !== "");
  const untouchedByName = new Map<string, DbRow[]>();
  for (const d of untouchedRealCid) {
    const k = normName(d.name);
    const list = untouchedByName.get(k) ?? [];
    list.push(d);
    untouchedByName.set(k, list);
  }
  const stillUnpairedAny = wbRows.filter((r) => !wbPairedDbId.has(r.excelRow));
  for (const r of stillUnpairedAny) {
    const nk = normName(r.name);
    const cands = (untouchedByName.get(nk) ?? []).filter((d) => !dbPaired.has(d.id));
    if (cands.length !== 1) continue;
    const wbMobile = normalizeMobile(r.contact);
    if (!wbMobile || wbMobile !== cands[0].contact_number) continue;
    dbPaired.add(cands[0].id);
    wbPairedDbId.set(r.excelRow, cands[0].id);
    matchMethod.set(r.excelRow, "cross-match");
  }

  // PASS 5: "possible same person" overrides — categories (a) and (b) only
  // (see classifySamePerson). Matched by Contact Number alone (NOT name,
  // unlike pass 4): a case-mangled or malformed CID is often accompanied by
  // a garbled name too (e.g. a missing middle name), which is exactly why
  // these survived passes 1-4 as unmatched. CID IS written here — that's the
  // whole point, unlike pass 4 which deliberately never touches CID for a
  // genuinely different real person. Categories (c)/(d) are NOT paired here;
  // they stay inserts and are report-only (see POSSIBLE SAME PERSON below).
  const p5DbPool = dbRows.filter((d) => !dbPaired.has(d.id) && d.cid.trim() !== "" && d.cid.trim() !== "-");
  const p5DbByContact = new Map<string, DbRow[]>();
  for (const d of p5DbPool) {
    if (/^\d{10}$/.test(d.contact_number || "")) {
      const list = p5DbByContact.get(d.contact_number) ?? [];
      list.push(d);
      p5DbByContact.set(d.contact_number, list);
    }
  }
  const p5WbPool = wbRows.filter((r) => !wbPairedDbId.has(r.excelRow) && r.cidClean.resolvedForMatch);
  for (const r of p5WbPool) {
    const wbMobile = normalizeMobile(r.contact);
    if (!wbMobile) continue;
    const cands = (p5DbByContact.get(wbMobile) ?? []).filter((d) => !dbPaired.has(d.id));
    const eligible = cands
      .map((d) => ({ d, category: classifySamePerson(r.cidClean.resolvedForMatch!, d.cid, r.name, d.name) }))
      .filter((x) => x.category === "a" || x.category === "b");
    if (eligible.length !== 1) continue; // ambiguous (>1) or none — leave as a report-only insert
    const { d, category } = eligible[0];
    dbPaired.add(d.id);
    wbPairedDbId.set(r.excelRow, d.id);
    matchMethod.set(r.excelRow, category === "a" ? "same-person-case" : "same-person-malformed");
  }

  return { wbPairedDbId, matchMethod, dbPaired };
}

// ============================== MAIN ==============================

/**
 * Approved dry-run baseline (the exact run reviewed and approved before
 * --apply was built) — --apply hard-fails with ZERO writes if a freshly
 * recomputed plan against the CURRENT live DB differs from this in any way.
 * This is deliberately exact-match, not "at least" — any drift (someone
 * edited candidate_master, re-ran the workbook export, touched a flag) means
 * the approval no longer covers what's about to be written.
 */
const APPROVED_BASELINE = {
  existingRowCount: 11192,
  workbookRowCount: 11949,
  updateCount: 10973,
  noOpCount: 216,
  insertCount: 760,
  untouchedIds: [8352, 9612, 12056],
  // cidGuardTripped rows: 10 other-malformed + 1 cross-match-nonblank (id 12018).
  otherMalformedGuardTrippedIds: [1502, 1691, 2065, 2281, 2670, 5046, 5342, 5580, 5754, 8934],
  crossMatchNonblankGuardTrippedIds: [12018],
  duplicateCidFlagCount: 416,
  invalidCidFlagCount: 12,
  uncleanContactNumberFlagCount: 26,
  unclearGenderFlagCount: 1,
} as const;

function sameIdSet(actual: number[], expected: readonly number[]): boolean {
  const a = [...actual].sort((x, y) => x - y);
  const e = [...expected].sort((x, y) => x - y);
  return a.length === e.length && a.every((v, i) => v === e[i]);
}

/** Migration 020 adds 'duplicate_cid' and 'unclear_gender' to this CHECK
 * constraint — required before --apply, since review-flag inserts for those
 * two reasons would otherwise violate the constraint mid-transaction. */
async function checkMigration020Applied(sql: ReturnType<typeof getDb>): Promise<{ ok: boolean; definition: string | null }> {
  const rows = await sql<{ definition: string }[]>`
    SELECT pg_get_constraintdef(oid) AS definition
    FROM pg_constraint
    WHERE conname = 'candidate_review_flags_reason_check'
  `;
  const definition = rows[0]?.definition ?? null;
  const ok = Boolean(definition && definition.includes("duplicate_cid") && definition.includes("unclear_gender"));
  return { ok, definition };
}

async function main() {
  const apply = process.argv.includes("--apply");

  mkdirSync(REPORT_DIR, { recursive: true });

  const wbRows = loadWorkbook();
  console.log(`Workbook rows: ${wbRows.length}`);

  const sql = getDb();
  try {
    const dbRowsRaw = await sql<
      {
        id: string; cid: string; name: string; gender: string; contact_number: string; date_of_upload: string;
        submitter: string; customer: string; primary_skills: string; job_management_level: string; market: string;
        submitted_date: string; status: string; job_requisition_id: string;
      }[]
    >`
      SELECT id, cid, name, gender, contact_number, date_of_upload, submitter, customer,
             primary_skills, job_management_level, market, submitted_date, status, job_requisition_id
      FROM candidate_master
    `;
    const dbRows: DbRow[] = dbRowsRaw.map((r) => ({
      ...r,
      id: Number(r.id),
      resolvedForMatch: dbResolvedForMatch(r.cid),
    }));
    console.log(`candidate_master rows: ${dbRows.length}`);

    const { wbPairedDbId, matchMethod, dbPaired } = runPairing(wbRows, dbRows);
    const dbById = new Map(dbRows.map((d) => [d.id, d]));
    const wbByExcelRow = new Map(wbRows.map((r) => [r.excelRow, r]));

    function submittedDateResolve(raw: string): string | null {
      const t = (raw || "").trim();
      return t === "" ? null : serialToDdMmYyyy(t);
    }

    const JR_EXCLUDED_COLS = new Set(["status", "submitter", "submitted_date", "primary_skills", "job_management_level", "market"]);
    const AUTO_FETCH_COLS = new Set(["primary_skills", "job_management_level", "market"]);
    const COLS = [
      "cid", "date_of_upload", "name", "contact_number", "submitter", "customer",
      "primary_skills", "job_management_level", "market", "status", "submitted_date", "gender",
    ] as const;

    interface CellDiff { col: string; old: string; new: string; kind: "real" | "ws"; }
    interface RowResult {
      excelRow: number; dbId: number; method: MatchMethod;
      diffs: CellDiff[]; changed: boolean;
      cidGuardTripped: "other-malformed" | "cross-match-nonblank" | null;
      jrExcluded: boolean;
      uncleanContactNumber: boolean;
      unclearGender: boolean;
      /** Full final value for every one of the 12 mapped columns — existing
       * value where unchanged/jr-excluded/cleaned-is-null, new value where
       * diffed. This (not `diffs`) is what --apply actually writes, so the
       * write path can never drift from what the dry run reported. */
      finalValues: Record<(typeof COLS)[number], string>;
    }
    const updateResults: RowResult[] = [];
    const noOpResults: { excelRow: number; dbId: number }[] = [];
    const insertRows: WbRow[] = [];

    function normLoose(s: string) { return (s || "").trim().toLowerCase().replace(/\s+/g, " "); }

    for (const r of wbRows) {
      const dbId = wbPairedDbId.get(r.excelRow);
      if (dbId === undefined) { insertRows.push(r); continue; }
      const d = dbById.get(dbId)!;
      const method = matchMethod.get(r.excelRow)!;
      const hasRealJr = Boolean(d.job_requisition_id && d.job_requisition_id.trim() !== "" && d.job_requisition_id.trim() !== "-");
      const nonBlankExistingCid = Boolean(d.cid && d.cid.trim() !== "" && d.cid.trim() !== "-");

      let cidVal: string | null = r.cidClean.finalValue;
      let cidGuardTripped: RowResult["cidGuardTripped"] = null;
      if (r.cidClean.category === "other-malformed") { cidVal = null; cidGuardTripped = "other-malformed"; }
      if (method === "cross-match" && nonBlankExistingCid) { cidVal = null; cidGuardTripped = "cross-match-nonblank"; }
      const rowFinalCid = cidVal !== null ? cidVal : d.cid;

      // UNCLEANABLE VALUES: a workbook value that doesn't parse (contact
      // isn't 10 digits, gender isn't Male/Female) is normally just skipped
      // (cleaned value null -> no write). But if the DASHBOARD value is
      // currently '-' (nothing to lose) and this row's final cid isn't '-'
      // (not one of the shared placeholder rows), write the workbook's raw
      // text as-is and flag it — never silently drop the only information
      // we have. An existing non-'-' value is never overwritten with an
      // uncleanable one, so no write (and no flag) in that case.
      let contactVal: string | null = r.contactClean.value;
      let uncleanContactNumber = false;
      if (contactVal === null && r.contactClean.unclean && isPlaceholder(d.contact_number) && rowFinalCid !== "-") {
        contactVal = r.contact.trim();
        uncleanContactNumber = true;
      }
      let genderVal: string | null = r.genderClean.value;
      let unclearGender = false;
      if (genderVal === null && r.genderClean.unclear && isPlaceholder(d.gender) && rowFinalCid !== "-") {
        genderVal = r.gender.trim();
        unclearGender = true;
      }

      const cleaned: Record<string, string | null> = {
        cid: cidVal,
        date_of_upload: r.uploadDdMmYyyy,
        name: r.name || null,
        contact_number: contactVal,
        submitter: r.recruiter || null,
        customer: r.customerClean,
        primary_skills: r.roleSkill || null,
        job_management_level: r.jmlClean,
        market: r.market || null,
        status: r.remarksStatus || null,
        submitted_date: submittedDateResolve(r.submittedDateRaw),
        gender: genderVal,
      };

      const diffs: CellDiff[] = [];
      let jrExcluded = false;
      const finalValues = {} as Record<(typeof COLS)[number], string>;
      for (const c of COLS) {
        const oldVal = (d as unknown as Record<string, string>)[c] || "";
        if (hasRealJr && JR_EXCLUDED_COLS.has(c)) { jrExcluded = true; finalValues[c] = oldVal; continue; }
        const newVal = cleaned[c];
        if (newVal === null) { finalValues[c] = oldVal; continue; }
        finalValues[c] = newVal;
        if (newVal === oldVal) continue;
        const kind = normLoose(newVal) === normLoose(oldVal) ? "ws" : "real";
        diffs.push({ col: c, old: oldVal, new: newVal, kind });
      }

      if (diffs.length > 0) {
        updateResults.push({
          excelRow: r.excelRow, dbId, method, diffs, changed: true, cidGuardTripped, jrExcluded,
          uncleanContactNumber, unclearGender, finalValues,
        });
      } else {
        noOpResults.push({ excelRow: r.excelRow, dbId });
      }
    }

    // Same insert-cid rule used everywhere an insert's would-be cid is needed
    // (other-malformed keeps its raw text since there's no valid CID to
    // write; everything else uses the cleaned value, defaulting to '-').
    function insertCidValue(r: WbRow): string {
      return r.cidClean.category === "other-malformed" ? (r.cidClean.matchByRawText ?? "-") : (r.cidClean.finalValue ?? "-");
    }

    // Full final value set for every insert — same UNCLEANABLE VALUES rule as
    // the update loop above, but for inserts: a brand-new row's contact/
    // gender is '-' by construction, so "dashboard value is '-'" is
    // trivially true — the only gate is the row's own final cid not being
    // '-'. This (not just the flag booleans) is what --apply writes.
    interface InsertProjection {
      excelRow: number;
      uncleanContactNumber: boolean;
      unclearGender: boolean;
      values: Record<(typeof COLS)[number], string>;
    }
    const insertProjections: InsertProjection[] = insertRows.map((r) => {
      const finalCid = insertCidValue(r);
      const uncleanContactNumber = r.contactClean.value === null && r.contactClean.unclean && finalCid !== "-";
      const unclearGender = r.genderClean.value === null && r.genderClean.unclear && finalCid !== "-";
      const values: Record<(typeof COLS)[number], string> = {
        cid: finalCid,
        date_of_upload: r.uploadDdMmYyyy || "-",
        name: r.name || "-",
        contact_number: uncleanContactNumber ? r.contact.trim() : (r.contactClean.value ?? "-"),
        submitter: r.recruiter || "-",
        customer: r.customerClean ?? "-",
        primary_skills: r.roleSkill || "-",
        job_management_level: r.jmlClean ?? "-",
        market: r.market || "-",
        status: r.remarksStatus || "-",
        submitted_date: submittedDateResolve(r.submittedDateRaw) ?? "-",
        gender: unclearGender ? r.gender.trim() : (r.genderClean.value ?? "-"),
      };
      return { excelRow: r.excelRow, uncleanContactNumber, unclearGender, values };
    });
    const insertProjectionByExcelRow = new Map(insertProjections.map((p) => [p.excelRow, p]));

    // ===================== RECONCILIATION =====================
    const total = updateResults.length + noOpResults.length + insertRows.length;
    console.log("\n========================= RECONCILIATION =========================");
    console.log(`UPDATE: ${updateResults.length}`);
    console.log(`NO-OP:  ${noOpResults.length}`);
    console.log(`INSERT: ${insertRows.length}`);
    console.log(`SUM:    ${total}  (workbook rows: ${wbRows.length}) — ${total === wbRows.length ? "MATCH" : "MISMATCH"}`);
    const projectedFinal = dbRows.length + insertRows.length;
    console.log(`Projected final candidate_master count: ${dbRows.length} + ${insertRows.length} = ${projectedFinal}`);
    const untouchedDb = dbRows.filter((d) => !dbPaired.has(d.id));
    console.log(`Untouched existing rows: ${untouchedDb.length}`);

    // ===================== RESTORED TWINS (computed early — reused by INSERT BREAKDOWN below) =====================
    const restoredTwins: { excelRow: number; cid: string; name: string; dbIdDuplicated: number; uploadAfter15Sep: boolean }[] = [];
    for (const r of insertRows) {
      if (!r.cidClean.resolvedForMatch) continue;
      // A "restored twin" is an insert whose resolved cid ALSO belongs to an existing paired DB row (name agreeing).
      const siblingExcelRows = [...wbPairedDbId.entries()].filter(([er]) => {
        const wr = wbByExcelRow.get(er);
        return wr?.cidClean.resolvedForMatch === r.cidClean.resolvedForMatch;
      });
      if (siblingExcelRows.length === 0) continue;
      const [, siblingDbId] = siblingExcelRows[0];
      const sibling = dbById.get(siblingDbId)!;
      if (normName(sibling.name) !== normName(r.name)) continue; // name-mismatch case, not a "twin"
      const cutoff = Date.UTC(2026, 8, 15);
      let afterCutoff = false;
      if (r.uploadDdMmYyyy) {
        const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(r.uploadDdMmYyyy);
        if (m) afterCutoff = Date.UTC(+m[3], +m[2] - 1, +m[1]) >= cutoff;
      }
      restoredTwins.push({ excelRow: r.excelRow, cid: r.cidClean.resolvedForMatch, name: r.name, dbIdDuplicated: siblingDbId, uploadAfter15Sep: afterCutoff });
    }
    const restoredTwinExcelRows = new Set(restoredTwins.map((t) => t.excelRow));

    // ===================== POSSIBLE SAME PERSON (c)/(d) — computed early, reused by INSERT BREAKDOWN below =====================
    // (a)/(b) were already paired by pass 5 inside runPairing and show up in
    // updateResults with method same-person-case/same-person-malformed —
    // only (c)/(d) remain as inserts.
    const dbByContactAll = new Map<string, DbRow[]>();
    for (const d of dbRows) {
      if (d.cid === "-" || d.cid.trim() === "") continue;
      if (/^\d{10}$/.test(d.contact_number || "")) {
        const list = dbByContactAll.get(d.contact_number) ?? [];
        list.push(d);
        dbByContactAll.set(d.contact_number, list);
      }
    }
    const samePersonCd: { excelRow: number; wbCid: string; wbName: string; matchedDbId: number; matchedDbCid: string; matchedDbName: string; category: "c" | "d" }[] = [];
    let samePersonTwinExclusions = 0;
    for (const r of insertRows) {
      if (!r.cidClean.resolvedForMatch) continue;
      const wbMobile = normalizeMobile(r.contact);
      if (!wbMobile) continue;
      const cands = dbByContactAll.get(wbMobile) ?? [];
      for (const d of cands) {
        const category = classifySamePerson(r.cidClean.resolvedForMatch, d.cid, r.name, d.name);
        if (category === "twin") { samePersonTwinExclusions++; continue; }
        if (category === "a" || category === "b") continue; // pass 5 should already have paired these — defensive only
        samePersonCd.push({ excelRow: r.excelRow, wbCid: r.cidRaw, wbName: r.name, matchedDbId: d.id, matchedDbCid: d.cid, matchedDbName: d.name, category });
      }
    }
    const samePersonCdExcelRows = new Set(samePersonCd.map((x) => x.excelRow));

    // ===================== INSERT BREAKDOWN BY REASON =====================
    console.log("\n========================= INSERT BREAKDOWN BY REASON =========================");
    const insertReasonCounts = new Map<string, number>();
    for (const r of insertRows) {
      let reason: string;
      if (restoredTwinExcelRows.has(r.excelRow)) reason = "restored_twin_of_paired_workbook_row";
      else if (samePersonCdExcelRows.has(r.excelRow)) reason = "possible_same_person_c_or_d";
      else if (r.cidClean.category === "other-malformed") reason = "other_malformed_cid_no_match";
      else if (r.cidClean.category === "phone") reason = "phone_cid_no_match";
      else if (r.cidClean.category === "submitted-word") reason = "submitted_word_cid_no_match";
      else if (r.cidClean.category === "double-different") reason = "double_different_cid_no_match";
      else if (r.cidClean.category === "blank-in-workbook") reason = "blank_cid_no_placeholder_match";
      else reason = "valid_cid_not_in_db"; // valid / paren / double-identical, genuinely not found anywhere
      insertReasonCounts.set(reason, (insertReasonCounts.get(reason) ?? 0) + 1);
    }
    let insertReasonSum = 0;
    for (const [reason, count] of [...insertReasonCounts.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${reason}: ${count}`);
      insertReasonSum += count;
    }
    console.log(`SUM: ${insertReasonSum} (insert rows: ${insertRows.length}) — ${insertReasonSum === insertRows.length ? "MATCH" : "MISMATCH"}`);

    // ===================== PER-COLUMN DIFF STATS =====================
    console.log("\n========================= PER-COLUMN DIFF =========================");
    const colStats: Record<string, { real: number; ws: number }> = {};
    for (const c of COLS) colStats[c] = { real: 0, ws: 0 };
    for (const u of updateResults) for (const diff of u.diffs) colStats[diff.col][diff.kind]++;
    let totalChangedCells = 0;
    for (const c of COLS) {
      console.log(`  ${c}: real=${colStats[c].real} ws=${colStats[c].ws}`);
      totalChangedCells += colStats[c].real + colStats[c].ws;
    }
    console.log(`Total changed cells: ${totalChangedCells}`);

    // ===================== STATUS OLD->NEW PAIRS =====================
    console.log("\n========================= STATUS CHANGES =========================");
    const statusPairs = new Map<string, { count: number; isFill: boolean }>();
    for (const u of updateResults) {
      const d = u.diffs.find((x) => x.col === "status");
      if (!d) continue;
      const key = `${d.old} -> ${d.new}`;
      const entry = statusPairs.get(key) ?? { count: 0, isFill: d.old === "-" || d.old === "" };
      entry.count++;
      statusPairs.set(key, entry);
    }
    const fills = [...statusPairs.entries()].filter(([, v]) => v.isFill).sort((a, b) => b[1].count - a[1].count);
    const overwrites = [...statusPairs.entries()].filter(([, v]) => !v.isFill).sort((a, b) => b[1].count - a[1].count);
    console.log(`Distinct old->new pairs: ${statusPairs.size} (fills: ${fills.length}, overwrites: ${overwrites.length})`);
    console.log("\n-- Fills (old status was blank/'-') --");
    for (const [k, v] of fills) console.log(`  [${v.count}]  ${k}`);
    console.log("\n-- Overwrites (old status was a real value) --");
    for (const [k, v] of overwrites) console.log(`  [${v.count}]  ${k}`);

    // ===================== GENDER CHANGES (ALL) =====================
    console.log("\n========================= GENDER CHANGES (all) =========================");
    const genderChanges = updateResults.flatMap((u) => u.diffs.filter((x) => x.col === "gender").map((x) => ({ id: u.dbId, ...x })));
    console.log(`Count: ${genderChanges.length}`);
    for (const g of genderChanges) console.log(`  id=${g.id}: "${g.old}" -> "${g.new}" (${g.kind})`);

    // ===================== UPLOAD DATE SAMPLES =====================
    console.log("\n========================= UPLOAD DATE SAMPLES (30) =========================");
    const uploadChanges = updateResults.flatMap((u) => u.diffs.filter((x) => x.col === "date_of_upload").map((x) => ({ id: u.dbId, ...x })));
    console.log(`Total date_of_upload changes: ${uploadChanges.length}`);
    for (const g of uploadChanges.slice(0, 30)) console.log(`  id=${g.id}: "${g.old}" -> "${g.new}"`);

    // ===================== CID-CHANGING ROWS =====================
    console.log("\n========================= CID-CHANGING ROWS =========================");
    const cidChanges = updateResults.flatMap((u) => u.diffs.filter((x) => x.col === "cid").map((x) => ({ id: u.dbId, method: u.method, ...x })));
    console.log(`Count: ${cidChanges.length}`);
    for (const c of cidChanges) console.log(`  id=${c.id} (${c.method}): "${c.old}" -> "${c.new}"`);
    const cidGuardTripped = updateResults.filter((u) => u.cidGuardTripped);
    console.log(`\nRows where the CID guard tripped (cid intentionally NOT written): ${cidGuardTripped.length}`);
    for (const u of cidGuardTripped) {
      const d = dbById.get(u.dbId)!;
      const r = wbByExcelRow.get(u.excelRow)!;
      console.log(`  id=${u.dbId} cid(kept)="${d.cid}" workbook cid="${r.cidRaw}" reason=${u.cidGuardTripped}`);
    }

    // ===================== RESTORED TWINS =====================
    console.log("\n========================= RESTORED TWINS =========================");
    console.log(`Count: ${restoredTwins.length}`);
    const afterCount = restoredTwins.filter((t) => t.uploadAfter15Sep).length;
    console.log(`  of those, Upload Date >= 15/09/2026: ${afterCount}`);
    for (const t of restoredTwins.slice(0, 20)) {
      console.log(`  excelRow=${t.excelRow} cid=${t.cid} name="${t.name}" duplicates id=${t.dbIdDuplicated} afterCutoff=${t.uploadAfter15Sep}`);
    }

    // ===================== POSSIBLE SAME PERSON — classified (a)/(b)/(c)/(d) =====================
    // (a)/(b) were paired by pass 5 (see runPairing) — listed here from
    // updateResults, CID already changed. (c)/(d) are report-only (computed
    // above, before INSERT BREAKDOWN) — CID never touched either way.
    console.log("\n========================= POSSIBLE SAME PERSON — classified =========================");
    const samePersonA = updateResults.filter((u) => u.method === "same-person-case");
    const samePersonB = updateResults.filter((u) => u.method === "same-person-malformed");
    const samePersonC = samePersonCd.filter((x) => x.category === "c");
    const samePersonD = samePersonCd.filter((x) => x.category === "d");
    const samePersonTotal = samePersonA.length + samePersonB.length + samePersonC.length + samePersonD.length;
    console.log(`Total: ${samePersonTotal}  (a=${samePersonA.length} b=${samePersonB.length} c=${samePersonC.length} d=${samePersonD.length})`);
    console.log(`(${samePersonTwinExclusions} contact-matches excluded — already the SAME cid once normalized, see RESTORED TWINS)`);

    console.log("\n-- (a) same CID, case/whitespace variant — PAIRED, cid normalized --");
    for (const u of samePersonA) {
      const d = dbById.get(u.dbId)!;
      const cidDiff = u.diffs.find((x) => x.col === "cid")!;
      console.log(`  id=${u.dbId} name="${d.name}"  "${cidDiff.old}" -> "${cidDiff.new}"`);
    }
    console.log("\n-- (b) malformed/phone-like dashboard CID, contact+name match — PAIRED, cid replaced with workbook's --");
    for (const u of samePersonB) {
      const d = dbById.get(u.dbId)!;
      const cidDiff = u.diffs.find((x) => x.col === "cid")!;
      console.log(`  id=${u.dbId} name="${d.name}"  "${cidDiff.old}" -> "${cidDiff.new}"`);
    }
    console.log("\n-- (c) different real CID, same person — report only, existing CID kept --");
    for (const s of samePersonC) {
      console.log(`  excelRow=${s.excelRow} wbCid=${s.wbCid} wbName="${s.wbName}"  <-- same person as -->  id=${s.matchedDbId} cid=${s.matchedDbCid} name="${s.matchedDbName}"`);
    }
    console.log("\n-- (d) shared contact, different people — report only, no action --");
    for (const s of samePersonD) {
      console.log(`  excelRow=${s.excelRow} wbCid=${s.wbCid} wbName="${s.wbName}"  <-- shares contact, different person -->  id=${s.matchedDbId} cid=${s.matchedDbCid} name="${s.matchedDbName}"`);
    }

    // ===================== JR-EXCLUDED ROWS =====================
    console.log("\n========================= JR-ID EXCLUDED ROWS =========================");
    const jrRows = updateResults.filter((u) => u.jrExcluded);
    console.log(`Count: ${jrRows.length}`);
    for (const u of jrRows) {
      const d = dbById.get(u.dbId)!;
      console.log(`  id=${u.dbId} cid=${d.cid} name="${d.name}" jrId=${d.job_requisition_id}`);
    }

    // ===================== HARDCODED DATE ROWS =====================
    console.log("\n========================= HARDCODED DATE ROWS (safety check) =========================");
    for (const [excelRowStr, expected] of Object.entries(HARDCODED_UPLOAD_DATES)) {
      const excelRow = Number(excelRowStr);
      const r = wbByExcelRow.get(excelRow);
      console.log(`  excelRow=${excelRow} cid=${r?.cidRaw ?? "(not found)"} name="${r?.name ?? ""}" -> ${expected}`);
    }

    // ===================== FLAG PROJECTIONS =====================
    console.log("\n========================= PROJECTED FLAGS =========================");

    // Projected final cid per db row (for duplicate_cid + invalid_candidate_id)
    const finalCidById = new Map<number, string>();
    for (const d of dbRows) finalCidById.set(d.id, d.cid);
    for (const u of updateResults) {
      const cidDiff = u.diffs.find((x) => x.col === "cid");
      if (cidDiff) finalCidById.set(u.dbId, cidDiff.new);
    }
    // Insert cid keyed by excelRow (not a synthetic id) — traceable straight
    // back to the workbook row, needed once --apply resolves each insert's
    // real new id.
    const insertFinalCid = new Map<number, string>();
    for (const r of insertRows) insertFinalCid.set(r.excelRow, insertCidValue(r));

    const cidGroupCount = new Map<string, number>();
    for (const [, cid] of finalCidById) { if (cid !== "-" && cid.trim() !== "") cidGroupCount.set(cid, (cidGroupCount.get(cid) ?? 0) + 1); }
    for (const [, cid] of insertFinalCid) { if (cid !== "-" && cid.trim() !== "") cidGroupCount.set(cid, (cidGroupCount.get(cid) ?? 0) + 1); }

    // Full-table checks (untouched/no-op rows included, not just updateResults/inserts)
    // — the actual entries here, not just counts, are what --apply writes to
    // candidate_review_flags.
    type FlagPlanEntry =
      | { kind: "existing"; dbId: number; cid: string; extra?: Record<string, unknown> }
      | { kind: "insert"; excelRow: number; cid: string; extra?: Record<string, unknown> };

    const duplicateCidEntries: FlagPlanEntry[] = [];
    for (const [dbId, cid] of finalCidById) if (cid !== "-" && (cidGroupCount.get(cid) ?? 0) > 1) duplicateCidEntries.push({ kind: "existing", dbId, cid });
    for (const [excelRow, cid] of insertFinalCid) if (cid !== "-" && (cidGroupCount.get(cid) ?? 0) > 1) duplicateCidEntries.push({ kind: "insert", excelRow, cid });
    console.log(`duplicate_cid: ${duplicateCidEntries.length} rows (across ${[...cidGroupCount.values()].filter((n) => n > 1).length} distinct duplicated CIDs)`);

    const invalidCidEntries: FlagPlanEntry[] = [];
    for (const [dbId, cid] of finalCidById) if (cid !== "-" && cid.trim() !== "" && !VALID_CID_REGEX.test(cid)) invalidCidEntries.push({ kind: "existing", dbId, cid });
    for (const [excelRow, cid] of insertFinalCid) if (cid !== "-" && cid.trim() !== "" && !VALID_CID_REGEX.test(cid)) invalidCidEntries.push({ kind: "insert", excelRow, cid });
    console.log(`invalid_candidate_id: ${invalidCidEntries.length} rows (full-table check, live regex, not a hardcoded id list)`);

    // unclean_contact_number / unclear_gender: written (and flagged) ONLY
    // when this script actually writes the raw uncleanable value — i.e. the
    // stored value was '-' AND the row's final cid isn't '-'. See the
    // UNCLEANABLE VALUES comment in the update loop above / insertProjections
    // above. This is a strictly narrower — and correct — count than "any
    // touched row with an unclear value", since a row whose EXISTING value
    // is already non-'-' never gets written (or flagged) here.
    const uncleanContactUpdates = updateResults.filter((u) => u.uncleanContactNumber);
    const unclearGenderUpdates = updateResults.filter((u) => u.unclearGender);
    const uncleanContactInserts = insertProjections.filter((x) => x.uncleanContactNumber);
    const unclearGenderInserts = insertProjections.filter((x) => x.unclearGender);
    const uncleanContactFlagCount = uncleanContactUpdates.length + uncleanContactInserts.length;
    const unclearGenderFlagCount = unclearGenderUpdates.length + unclearGenderInserts.length;
    console.log(`unclean_contact_number: ${uncleanContactFlagCount} rows (${uncleanContactUpdates.length} updates + ${uncleanContactInserts.length} inserts)`);
    console.log(`unclear_gender: ${unclearGenderFlagCount} rows (${unclearGenderUpdates.length} updates + ${unclearGenderInserts.length} inserts)`);

    const uncleanContactEntries: FlagPlanEntry[] = [
      ...uncleanContactUpdates.map((u): FlagPlanEntry => ({ kind: "existing", dbId: u.dbId, cid: u.finalValues.cid, extra: { raw: u.finalValues.contact_number } })),
      ...uncleanContactInserts.map((x): FlagPlanEntry => ({ kind: "insert", excelRow: x.excelRow, cid: x.values.cid, extra: { raw: x.values.contact_number } })),
    ];
    const unclearGenderEntries: FlagPlanEntry[] = [
      ...unclearGenderUpdates.map((u): FlagPlanEntry => ({ kind: "existing", dbId: u.dbId, cid: u.finalValues.cid, extra: { raw: u.finalValues.gender } })),
      ...unclearGenderInserts.map((x): FlagPlanEntry => ({ kind: "insert", excelRow: x.excelRow, cid: x.values.cid, extra: { raw: x.values.gender } })),
    ];

    // ===================== OTHER-MALFORMED CID: GUARD TRIPS VS TOTAL =====================
    console.log("\n========================= OTHER-MALFORMED CID ROWS =========================");
    const otherMalformedTotal = wbRows.filter((r) => r.cidClean.category === "other-malformed").length;
    const otherMalformedGuardTrips = updateResults.filter((u) => u.cidGuardTripped === "other-malformed").length;
    const otherMalformedInserts = insertRows.filter((r) => r.cidClean.category === "other-malformed").length;
    const otherMalformedExcelRows = new Set(wbRows.filter((r) => r.cidClean.category === "other-malformed").map((r) => r.excelRow));
    const otherMalformedNoOps = noOpResults.filter((n) => otherMalformedExcelRows.has(n.excelRow)).length;
    console.log(`Total workbook rows with an unparseable ("other-malformed") CID: ${otherMalformedTotal}`);
    console.log(`  paired to an existing row, OTHER fields still diff (cid guard trips, kept unchanged): ${otherMalformedGuardTrips}`);
    console.log(`  paired to an existing row, but truly nothing differs (a no-op — no RowResult, so no "guard trip" to count): ${otherMalformedNoOps}`);
    console.log(`  unpaired (become inserts, cid written as-is — nothing to guard): ${otherMalformedInserts}`);
    console.log(`  ${otherMalformedGuardTrips} + ${otherMalformedNoOps} + ${otherMalformedInserts} = ${otherMalformedGuardTrips + otherMalformedNoOps + otherMalformedInserts} (of ${otherMalformedTotal} total)`);

    // ===================== STATUS READERS (item 1) =====================
    console.log("\n========================= STATUS READERS: VALUE COUNTS BEFORE / AFTER =========================");
    const finalStatusById = new Map<number, string>();
    for (const d of dbRows) finalStatusById.set(d.id, d.status || "-");
    for (const u of updateResults) {
      const sd = u.diffs.find((x) => x.col === "status");
      if (sd) finalStatusById.set(u.dbId, sd.new);
    }
    const statusBefore = new Map<string, number>();
    for (const d of dbRows) statusBefore.set(d.status || "-", (statusBefore.get(d.status || "-") ?? 0) + 1);
    const statusAfter = new Map<string, number>();
    for (const [, s] of finalStatusById) statusAfter.set(s, (statusAfter.get(s) ?? 0) + 1);
    for (const r of insertRows) {
      const s = (r.remarksStatus || "").trim() || "-";
      statusAfter.set(s, (statusAfter.get(s) ?? 0) + 1);
    }
    console.log(`Distinct status values: before=${statusBefore.size} after=${statusAfter.size}`);
    console.log(`Rows with status='-' (blank): before=${statusBefore.get("-") ?? 0} after=${statusAfter.get("-") ?? 0}`);
    console.log(`Rows with a non-'-' status: before=${dbRows.length - (statusBefore.get("-") ?? 0)} after=${(dbRows.length + insertRows.length) - (statusAfter.get("-") ?? 0)}`);
    console.log("\n-- Top 15 status values AFTER refresh --");
    for (const [k, v] of [...statusAfter.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
      console.log(`  [${v}]  before=${statusBefore.get(k) ?? 0}  "${k}"`);
    }

    // ===================== WRITE FULL REPORT TO DISK =====================
    writeFileSync(`${REPORT_DIR}/status-pairs.json`, JSON.stringify({ fills, overwrites }, null, 1));
    writeFileSync(`${REPORT_DIR}/gender-changes.json`, JSON.stringify(genderChanges, null, 1));
    writeFileSync(`${REPORT_DIR}/upload-date-changes.json`, JSON.stringify(uploadChanges, null, 1));
    writeFileSync(`${REPORT_DIR}/cid-changes.json`, JSON.stringify(cidChanges, null, 1));
    writeFileSync(`${REPORT_DIR}/restored-twins.json`, JSON.stringify(restoredTwins, null, 1));
    writeFileSync(
      `${REPORT_DIR}/same-person-classified.json`,
      JSON.stringify(
        {
          a: samePersonA.map((u) => ({ dbId: u.dbId, cidDiff: u.diffs.find((x) => x.col === "cid") })),
          b: samePersonB.map((u) => ({ dbId: u.dbId, cidDiff: u.diffs.find((x) => x.col === "cid") })),
          c: samePersonC,
          d: samePersonD,
        },
        null,
        1
      )
    );
    writeFileSync(`${REPORT_DIR}/jr-excluded-rows.json`, JSON.stringify(jrRows.map((u) => ({ id: u.dbId, ...dbById.get(u.dbId) })), null, 1));
    writeFileSync(
      `${REPORT_DIR}/status-readers.json`,
      JSON.stringify({ before: Object.fromEntries(statusBefore), after: Object.fromEntries(statusAfter) }, null, 1)
    );
    writeFileSync(
      `${REPORT_DIR}/unclean-values.json`,
      JSON.stringify(
        {
          uncleanContactUpdates: uncleanContactUpdates.map((u) => u.dbId),
          uncleanContactInserts: uncleanContactInserts.map((x) => x.excelRow),
          unclearGenderUpdates: unclearGenderUpdates.map((u) => u.dbId),
          unclearGenderInserts: unclearGenderInserts.map((x) => x.excelRow),
        },
        null,
        1
      )
    );
    writeFileSync(
      `${REPORT_DIR}/insert-breakdown.json`,
      JSON.stringify(Object.fromEntries(insertReasonCounts), null, 1)
    );
    writeFileSync(
      `${REPORT_DIR}/full-classification.json`,
      JSON.stringify(
        {
          updates: updateResults.map((u) => ({ dbId: u.dbId, excelRow: u.excelRow, method: u.method })),
          noOps: noOpResults,
          inserts: insertRows.map((r) => r.excelRow),
        },
        null,
        1
      )
    );
    console.log(`\nFull detail JSON written to ${REPORT_DIR}/`);

    if (!apply) {
      console.log("\nDry run OK — no DB writes. Re-run with --apply to write.");
      return;
    }

    // ===================== APPLY: SAFETY CHECKS (re-run, exact match required) =====================
    console.log("\n========================= APPLY: SAFETY CHECKS =========================");
    const mismatches: string[] = [];
    function expect(label: string, actual: unknown, expected: unknown) {
      const ok = JSON.stringify(actual) === JSON.stringify(expected);
      console.log(`  ${ok ? "OK  " : "FAIL"}  ${label}: actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
      if (!ok) mismatches.push(label);
    }

    expect("existing candidate_master row count", dbRows.length, APPROVED_BASELINE.existingRowCount);
    expect("workbook row count", wbRows.length, APPROVED_BASELINE.workbookRowCount);
    expect("UPDATE count", updateResults.length, APPROVED_BASELINE.updateCount);
    expect("NO-OP count", noOpResults.length, APPROVED_BASELINE.noOpCount);
    expect("INSERT count", insertRows.length, APPROVED_BASELINE.insertCount);
    expect("untouched count", untouchedDb.length, APPROVED_BASELINE.untouchedIds.length);
    expect(
      "untouched row ids (exact set)",
      sameIdSet(untouchedDb.map((d) => d.id), APPROVED_BASELINE.untouchedIds),
      true
    );
    const otherMalformedGuardIds = cidGuardTripped.filter((u) => u.cidGuardTripped === "other-malformed").map((u) => u.dbId);
    const crossMatchGuardIds = cidGuardTripped.filter((u) => u.cidGuardTripped === "cross-match-nonblank").map((u) => u.dbId);
    expect(
      "other-malformed cid-guard-tripped ids (exact set — the fixed pass-1 matching)",
      sameIdSet(otherMalformedGuardIds, APPROVED_BASELINE.otherMalformedGuardTrippedIds),
      true
    );
    expect(
      "cross-match-nonblank cid-guard-tripped ids (exact set)",
      sameIdSet(crossMatchGuardIds, APPROVED_BASELINE.crossMatchNonblankGuardTrippedIds),
      true
    );
    expect("duplicate_cid flag count", duplicateCidEntries.length, APPROVED_BASELINE.duplicateCidFlagCount);
    expect("invalid_candidate_id flag count", invalidCidEntries.length, APPROVED_BASELINE.invalidCidFlagCount);
    expect("unclean_contact_number flag count", uncleanContactEntries.length, APPROVED_BASELINE.uncleanContactNumberFlagCount);
    expect("unclear_gender flag count", unclearGenderEntries.length, APPROVED_BASELINE.unclearGenderFlagCount);

    const migration020 = await checkMigration020Applied(sql);
    console.log(`  ${migration020.ok ? "OK  " : "FAIL"}  migration 020 applied (candidate_review_flags_reason_check includes duplicate_cid + unclear_gender)`);
    console.log(`        current constraint: ${migration020.definition ?? "(constraint not found)"}`);
    if (!migration020.ok) mismatches.push("migration 020 not applied");

    if (mismatches.length > 0) {
      console.error(
        `\nHARD FAIL: ${mismatches.length} safety check(s) failed against the approved baseline — ` +
          `the live DB or workbook has changed since approval. Aborting — NO changes made.`
      );
      console.error(`  Failed: ${mismatches.join("; ")}`);
      process.exit(1);
    }
    console.log("\nAll safety checks passed against the approved baseline. Proceeding to write.");

    // ===================== APPLY: SINGLE TRANSACTION =====================
    const startedAt = new Date();
    await sql.begin(async (tx) => {
      const [{ id: syncIdRaw }] = await tx<{ id: string }[]>`
        INSERT INTO candidate_sync_history (
          started_at, result, source_filename, triggered_by,
          rows_in_sheet, inserted_count, updated_count, unchanged_count,
          quarantined_count, review_flag_count
        ) VALUES (
          ${startedAt}, 'success', ${WORKBOOK_PATH}, 'refresh-candidate-master-from-workbook.ts --apply',
          ${wbRows.length}, ${insertRows.length}, ${updateResults.length}, ${noOpResults.length},
          0, ${duplicateCidEntries.length + invalidCidEntries.length + uncleanContactEntries.length + unclearGenderEntries.length}
        ) RETURNING id
      `;
      const syncId = Number(syncIdRaw);
      console.log(`  candidate_sync_history id=${syncId} created`);

      let updateProgress = 0;
      for (const u of updateResults) {
        const v = u.finalValues;
        await tx`
          UPDATE candidate_master SET
            cid = ${v.cid}, date_of_upload = ${v.date_of_upload}, name = ${v.name},
            contact_number = ${v.contact_number}, submitter = ${v.submitter}, customer = ${v.customer},
            primary_skills = ${v.primary_skills}, job_management_level = ${v.job_management_level},
            market = ${v.market}, status = ${v.status}, submitted_date = ${v.submitted_date}, gender = ${v.gender}
          WHERE id = ${u.dbId}
        `;
        updateProgress++;
        if (updateProgress % 2000 === 0) console.log(`  ...${updateProgress}/${updateResults.length} updates applied`);
      }
      console.log(`  ${updateResults.length} UPDATEs applied`);

      const insertedIdByExcelRow = new Map<number, number>();
      for (const p of insertProjections) {
        const v = p.values;
        const [{ id: newIdRaw }] = await tx<{ id: string }[]>`
          INSERT INTO candidate_master (
            cid, name, gender, contact_number, date_of_upload, submitter, customer,
            job_requisition_id, primary_skills, job_management_level, market,
            submitted_date, status, submission_comments, email, client_spoc,
            inserted_sync_id
          ) VALUES (
            ${v.cid}, ${v.name}, ${v.gender}, ${v.contact_number}, ${v.date_of_upload}, ${v.submitter}, ${v.customer},
            '-', ${v.primary_skills}, ${v.job_management_level}, ${v.market},
            ${v.submitted_date}, ${v.status}, '-', '-', '-',
            ${syncId}
          ) RETURNING id
        `;
        insertedIdByExcelRow.set(p.excelRow, Number(newIdRaw));
      }
      console.log(`  ${insertProjections.length} INSERTs applied`);

      function resolveFlagCid(entry: FlagPlanEntry): { rowId: number; cid: string } {
        if (entry.kind === "existing") return { rowId: entry.dbId, cid: entry.cid };
        const rowId = insertedIdByExcelRow.get(entry.excelRow);
        if (rowId === undefined) throw new Error(`No inserted id resolved for excelRow=${entry.excelRow}`);
        return { rowId, cid: entry.cid };
      }

      let flagCount = 0;
      const flagBatches: { reason: string; entries: FlagPlanEntry[] }[] = [
        { reason: "duplicate_cid", entries: duplicateCidEntries },
        { reason: "invalid_candidate_id", entries: invalidCidEntries },
        { reason: "unclean_contact_number", entries: uncleanContactEntries },
        { reason: "unclear_gender", entries: unclearGenderEntries },
      ];
      for (const batch of flagBatches) {
        for (const entry of batch.entries) {
          const { rowId, cid } = resolveFlagCid(entry);
          const detail = { rowId, ...(entry.extra ?? {}) };
          await tx`
            INSERT INTO candidate_review_flags (sync_id, cid, reason, detail)
            VALUES (${syncId}, ${cid}, ${batch.reason}, ${tx.json(JSON.parse(JSON.stringify(detail)))})
          `;
          flagCount++;
        }
        console.log(`  ${batch.entries.length} ${batch.reason} flags written`);
      }

      await tx`UPDATE candidate_sync_history SET finished_at = NOW() WHERE id = ${syncId}`;
      console.log(`  sync history id=${syncId} finished_at stamped (${flagCount} total flags)`);
    });

    const [{ count: finalCountRaw }] = await sql<{ count: string }[]>`SELECT count(*)::text FROM candidate_master`;
    console.log(`\n-- APPLIED --`);
    console.log(`  candidate_master count: ${APPROVED_BASELINE.existingRowCount} -> ${finalCountRaw} (expected ${APPROVED_BASELINE.existingRowCount + APPROVED_BASELINE.insertCount})`);
    console.log("===========================================================================\n");
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
