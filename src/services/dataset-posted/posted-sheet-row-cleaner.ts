/**
 * Shared "Posted" button row cleaner — pure text logic, zero I/O.
 *
 * Used by BOTH Lateral's and Executive's new Posted services. Deliberately
 * independent of `lateral-posted-sheet-processor.ts` (Run All's Step 18) and
 * `executive-posted-sheet-cleaner.ts` (Executive Run All's read-only Posted
 * matcher) — those two files are untouched by this feature; see the parity
 * test (`scripts/verify-posted-sheet-cleaner-parity.ts`) for proof that both
 * of their existing JR-ID extractors still read this module's output
 * correctly, so Run All keeps working whether the tab is raw or already
 * cleaned by the Posted button.
 *
 * Canonical format: "<JR ID> | Posting Date: MM/DD/YYYY | <City>"
 *
 * Rules (decided with the user):
 * - A line with NO recognizable JR ID (e.g. a bare job-title line like
 *   "Custom Software Engineer") is deleted and counted, regardless of
 *   content otherwise.
 * - A line that IS blank (empty after whitespace collapse) is deleted and
 *   counted separately.
 * - A line WITH a JR ID is never deleted, even if the posting date or city
 *   can't be confidently parsed — it is left byte-for-byte as it was and
 *   counted as "needs a look."
 * - A line with a second, distinct JR-ID-shaped token elsewhere in the text
 *   is also treated as "needs a look" rather than guessed at — ambiguous
 *   structure gets a human, not a silent pick of the first match.
 * - The posting date substring is never parsed into a Date or reformatted —
 *   whatever digits/slashes already follow "Posting Date:" are carried
 *   through verbatim. This is deliberate: guessing at day/month order for an
 *   ambiguous date (e.g. 03/04/2026) is exactly the kind of silent mistake
 *   this feature must never make.
 * - Idempotent: feeding this module's own canonical output back in (for any
 *   "clean" row) reproduces the identical string — required for the
 *   Drive-skip-if-unchanged behavior and for clicking the button twice in a
 *   row to produce identical results.
 */

/** Same shape the real workbook's JR IDs always take (mirrors `ATCI_JR_RE` in lateral-master-postgres.ts). */
const JR_ID_PATTERN = /ATCI-[A-Za-z0-9-]+/;
const LEADING_JR_ID_PATTERN = new RegExp(`^(${JR_ID_PATTERN.source})`);
const POSTING_DATE_PATTERN = /Posting\s*Date\s*:?\s*(\d{1,2}\/\d{1,2}\/\d{4})/i;

export type PostedRowOutcome =
  | {
      kind: "clean";
      rowNumber: number;
      jobRequisitionId: string;
      columnA: string;
      /** True when the rebuilt string is byte-identical to the original — no edit needed for this row. */
      unchanged: boolean;
    }
  | {
      kind: "needsLook";
      rowNumber: number;
      jobRequisitionId: string;
      /** Original text, left completely untouched. */
      columnA: string;
      reason: "no_posting_date" | "no_city" | "ambiguous_second_jr_id";
    }
  | {
      kind: "deleteBlank";
      rowNumber: number;
    }
  | {
      kind: "deleteNoJrId";
      rowNumber: number;
      columnA: string;
    };

export interface PostedSheetCleanResult {
  /** One entry per input row, in original order — for diagnostics/tests. */
  rows: PostedRowOutcome[];
  /** Rows that survive (clean + needsLook), in final sheet order, 2..N. */
  kept: Array<{ jobRequisitionId: string; columnA: string }>;
  blankRowsRemoved: number;
  noJrIdRowsRemoved: number;
  needsLookCount: number;
  /**
   * True if anything about the sheet's content would change (a row removed,
   * or a "clean" row's text rebuilt differently from its original). False
   * means every surviving row is already byte-identical to what cleaning
   * would produce — the caller should skip the Drive upload entirely.
   */
  changed: boolean;
}

function collapseWhitespace(value: unknown): string {
  if (value == null) return "";
  const raw = String(value)
    .replace(/ /g, " ")
    .replace(/\r\n/g, " ")
    .replace(/\r/g, " ")
    .replace(/\n/g, " ")
    .replace(/\t/g, " ");
  return raw.split(/\s+/).join(" ").trim();
}

/**
 * Parse a single, already-whitespace-collapsed, non-blank line.
 * Exported for the parity test — not used outside this module otherwise.
 */
export function parsePostedSheetLine(
  collapsed: string
):
  | { kind: "noJrId" }
  | {
      kind: "clean";
      jobRequisitionId: string;
      columnA: string;
    }
  | {
      kind: "needsLook";
      jobRequisitionId: string;
      reason: "no_posting_date" | "no_city" | "ambiguous_second_jr_id";
    } {
  const leadingMatch = collapsed.match(LEADING_JR_ID_PATTERN);
  if (!leadingMatch) return { kind: "noJrId" };

  const jobRequisitionId = leadingMatch[0];
  const remainder = collapsed.slice(jobRequisitionId.length);

  // A second JR-ID-shaped token anywhere after the first is ambiguous —
  // never silently pick one.
  const secondJrIdMatch = remainder.match(JR_ID_PATTERN);
  if (secondJrIdMatch) {
    return { kind: "needsLook", jobRequisitionId, reason: "ambiguous_second_jr_id" };
  }

  const dateMatch = remainder.match(POSTING_DATE_PATTERN);
  if (!dateMatch || dateMatch.index == null) {
    return { kind: "needsLook", jobRequisitionId, reason: "no_posting_date" };
  }

  // City is whatever remains strictly AFTER the date match, not "whatever
  // follows the last pipe" — a line with only one pipe (JR | Posting Date,
  // no trailing city segment) would otherwise have the date text itself
  // misread as the city.
  const textAfterDate = remainder.slice(dateMatch.index + dateMatch[0].length);
  const city = textAfterDate.replace(/^[\s|]+/, "").trim();
  if (!city) {
    return { kind: "needsLook", jobRequisitionId, reason: "no_city" };
  }

  const postingDateVerbatim = dateMatch[1];
  const columnA = `${jobRequisitionId} | Posting Date: ${postingDateVerbatim} | ${city}`;
  return { kind: "clean", jobRequisitionId, columnA };
}

export function cleanPostedSheetRows(
  rawRows: Array<{ rowNumber: number; columnA: unknown }>
): PostedSheetCleanResult {
  const rows: PostedRowOutcome[] = [];
  const kept: Array<{ jobRequisitionId: string; columnA: string }> = [];
  let blankRowsRemoved = 0;
  let noJrIdRowsRemoved = 0;
  let needsLookCount = 0;
  let changed = false;

  for (const raw of rawRows) {
    const original = raw.columnA == null ? "" : String(raw.columnA);
    const collapsed = collapseWhitespace(raw.columnA);

    if (!collapsed) {
      rows.push({ kind: "deleteBlank", rowNumber: raw.rowNumber });
      blankRowsRemoved += 1;
      changed = true;
      continue;
    }

    const parsed = parsePostedSheetLine(collapsed);

    if (parsed.kind === "noJrId") {
      rows.push({ kind: "deleteNoJrId", rowNumber: raw.rowNumber, columnA: original });
      noJrIdRowsRemoved += 1;
      changed = true;
      continue;
    }

    if (parsed.kind === "needsLook") {
      rows.push({
        kind: "needsLook",
        rowNumber: raw.rowNumber,
        jobRequisitionId: parsed.jobRequisitionId,
        columnA: original,
        reason: parsed.reason,
      });
      needsLookCount += 1;
      kept.push({ jobRequisitionId: parsed.jobRequisitionId, columnA: original });
      continue;
    }

    const unchanged = parsed.columnA === original;
    if (!unchanged) changed = true;
    rows.push({
      kind: "clean",
      rowNumber: raw.rowNumber,
      jobRequisitionId: parsed.jobRequisitionId,
      columnA: parsed.columnA,
      unchanged,
    });
    kept.push({ jobRequisitionId: parsed.jobRequisitionId, columnA: parsed.columnA });
  }

  return { rows, kept, blankRowsRemoved, noJrIdRowsRemoved, needsLookCount, changed };
}
