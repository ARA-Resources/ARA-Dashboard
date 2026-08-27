/**
 * Step 18 — PostgreSQL sync for `lateral_master.posted`.
 *
 * Writes ONLY:
 *   - posted ('Yes' | '-')
 *   - updated_at
 *
 * Does NOT touch job_status, skills, location, priority, JD, created_at, etc.
 *
 * Empty Posted JR input is a safe no-op (never mass-resets existing Yes rows).
 * Matching is by exact `job_requisition_id` against existing lateral_master rows.
 *
 * Ordering note (processor): PG sync currently runs before the Excel final write.
 * There is no cross-system transaction between PostgreSQL and XLSM.
 */
import { getDbClient } from "@/lib/persistence/db-client";

export interface LateralPostedUpdateResult {
  total: number;
  matched: number;
  unmatched: number;
  markedYes: number;
  resetToDash: number;
  matchedIds: string[];
  /** True when empty input skipped all writes (safety no-op). */
  skippedEmptyInput: boolean;
}

const ATCI_JR_RE = /^ATCI-[A-Za-z0-9-]+$/;

export async function syncLateralPostedStatus(
  jobRequisitionIds: string[],
  persistDatabase = true
): Promise<LateralPostedUpdateResult> {
  const ids = [
    ...new Set(
      jobRequisitionIds
        .map((id) => id.trim())
        .filter((id) => ATCI_JR_RE.test(id))
    ),
  ];

  /**
   * Critical safety: empty Posted list must NOT reset all posted='Yes' to '-'.
   * PostgreSQL `NOT (jr = ANY('{}'))` would otherwise match every row.
   */
  if (ids.length === 0) {
    return {
      total: 0,
      matched: 0,
      unmatched: 0,
      markedYes: 0,
      resetToDash: 0,
      matchedIds: [],
      skippedEmptyInput: true,
    };
  }

  const sql = getDbClient();

  return await sql.begin(async (tx) => {
    const matchedRows = await tx<{ job_requisition_id: string }[]>`
      SELECT job_requisition_id
      FROM lateral_master
      WHERE job_requisition_id = ANY(${tx.array(ids)})
    `;

    const matchedIds = matchedRows.map((row) => row.job_requisition_id);
    const matchedSet = new Set(matchedIds);
    const unmatched = ids.filter((id) => !matchedSet.has(id));

    const yesResult =
      persistDatabase && matchedIds.length > 0
        ? await tx`
            UPDATE lateral_master
            SET
              posted = 'Yes',
              updated_at = NOW()
            WHERE job_requisition_id = ANY(${tx.array(matchedIds)})
              AND posted IS DISTINCT FROM 'Yes'
          `
        : { count: 0 };

    const dashResult = persistDatabase
      ? await tx`
          UPDATE lateral_master
          SET
            posted = '-',
            updated_at = NOW()
          WHERE posted = 'Yes'
            AND NOT (
              job_requisition_id = ANY(${tx.array(ids)})
            )
        `
      : { count: 0 };

    return {
      total: ids.length,
      matched: matchedIds.length,
      unmatched: unmatched.length,
      markedYes: yesResult.count ?? 0,
      resetToDash: dashResult.count ?? 0,
      matchedIds,
      skippedEmptyInput: false,
    };
  });
}
