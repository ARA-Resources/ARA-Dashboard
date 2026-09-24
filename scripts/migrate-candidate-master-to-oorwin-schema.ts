/**
 * ONE-TIME data migration: collapse legacy duplicate CIDs and reformat
 * Contact Number for the 11,951 rows already in `candidate_master`, after
 * migration 015 has renamed its columns to the new Oorwin-sync shape.
 *
 * This does NOT touch schema (migrations 015/016 do that) and does NOT
 * populate email/client_spoc (already backfilled to "-" by migration 015's
 * column defaults) or run the JR-ID auto-fetch lookup (every legacy row's
 * job_requisition_id is "-", so the lookup would find nothing — Primary
 * Skills / Job Management Level / Market / Client SPOC are carried forward
 * as-is from the pre-migration column values, per the confirmed plan).
 *
 * What this script does:
 *  1. Groups rows by non-blank `cid`. For each group with >1 row:
 *     - All names match (case-insensitive, trimmed) → collapse to the
 *       highest-`id` row (= latest original import order), DELETE the rest.
 *     - Names don't all match → don't guess. Keep every row, write one
 *       `candidate_review_flags` row per row in the group
 *       (reason='duplicate_name_mismatch').
 *     Blank-`cid` rows (cid = "" or "-") are left completely alone — not
 *     comparable to each other, can never be matched by a future sync.
 *  2. For every surviving row's `contact_number` (except literal "-",
 *     already-blank placeholders): strip non-digits, strip a leading "91"
 *     country-code prefix, require exactly 10 digits left. Clean → UPDATE
 *     in place. Doesn't reduce cleanly → leave the original value untouched
 *     and write a `candidate_review_flags` row
 *     (reason='legacy_contact_number_unclean', detail={raw: <original>}).
 *  3. Records one `candidate_sync_history` row for the whole run
 *     (source_filename = the LEGACY_MIGRATION_SENTINEL below) so the script
 *     can detect and refuse a second run, and so every review flag this
 *     script writes carries a real, traceable sync_id.
 *
 * Usage:
 *   npx tsx scripts/migrate-candidate-master-to-oorwin-schema.ts [--dry-run]
 *   npm run db:migrate-candidate-master-oorwin
 *
 * Requires migrations 015 and 016 already applied (candidate_master's new
 * column names + candidate_sync_history/candidate_review_flags tables).
 */

import postgres from "postgres";

const LEGACY_MIGRATION_SENTINEL = "legacy-schema-migration-oorwin";

function getDb() {
  const url = process.env.POSTGRES_URL?.trim();
  if (!url) {
    throw new Error(
      "POSTGRES_URL is not set. Provide it in the environment or .env.local."
    );
  }
  return postgres(url, {
    max: 1,
    connect_timeout: 15,
    idle_timeout: 20,
    prepare: false,
    ssl: url.includes("localhost") || url.includes("127.0.0.1") ? false : "require",
  });
}

interface CandidateRow {
  id: number;
  cid: string;
  name: string;
  contact_number: string;
  [key: string]: unknown;
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

function isBlankCid(cid: string): boolean {
  const trimmed = cid.trim();
  return trimmed === "" || trimmed === "-";
}

interface MobileResult {
  ok: boolean;
  normalized: string | null;
}

/** Strict 10-digit normalize: strip non-digits, strip a leading "91" country
 * code if present, require exactly 10 digits left. */
function normalizeMobile(raw: string): MobileResult {
  const digits = raw.replace(/\D/g, "");
  const withoutCountryCode =
    digits.length === 12 && digits.startsWith("91") ? digits.slice(2) : digits;
  if (withoutCountryCode.length === 10) {
    return { ok: true, normalized: withoutCountryCode };
  }
  return { ok: false, normalized: null };
}

interface DuplicateGroupPlan {
  cid: string;
  action: "collapse" | "quarantine";
  survivorId?: number;
  deleteIds: number[];
  allIds: number[];
}

function planDuplicateGroups(rows: CandidateRow[]): DuplicateGroupPlan[] {
  const groups = new Map<string, CandidateRow[]>();
  for (const row of rows) {
    if (isBlankCid(row.cid)) continue;
    const key = row.cid.trim();
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }

  const plans: DuplicateGroupPlan[] = [];
  for (const [cid, groupRows] of groups) {
    if (groupRows.length < 2) continue;
    const names = new Set(groupRows.map((r) => normalizeName(r.name)));
    const allIds = groupRows.map((r) => r.id).sort((a, b) => a - b);
    if (names.size === 1) {
      const survivor = groupRows.reduce((best, r) => (r.id > best.id ? r : best));
      plans.push({
        cid,
        action: "collapse",
        survivorId: survivor.id,
        deleteIds: allIds.filter((id) => id !== survivor.id),
        allIds,
      });
    } else {
      plans.push({ cid, action: "quarantine", deleteIds: [], allIds });
    }
  }
  return plans;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const startedAt = new Date();

  const sql = getDb();
  try {
    const alreadyRun = await sql<{ id: number }[]>`
      SELECT id FROM candidate_sync_history
      WHERE source_filename = ${LEGACY_MIGRATION_SENTINEL}
      LIMIT 1
    `;
    if (alreadyRun.length > 0) {
      console.error(
        `This legacy migration has already run (candidate_sync_history.id=${alreadyRun[0].id}). Refusing to run again.`
      );
      process.exit(1);
    }

    const rows = await sql<CandidateRow[]>`
      SELECT id, cid, name, contact_number FROM candidate_master ORDER BY id ASC
    `;
    console.log(`[migrate-candidate-master] Read ${rows.length} row(s).`);

    const dupPlans = planDuplicateGroups(rows);
    const collapsePlans = dupPlans.filter((p) => p.action === "collapse");
    const quarantinePlans = dupPlans.filter((p) => p.action === "quarantine");
    const totalDeleteIds = collapsePlans.flatMap((p) => p.deleteIds);
    const quarantineRowCount = quarantinePlans.reduce((n, p) => n + p.allIds.length, 0);

    const survivingIds = new Set(rows.map((r) => r.id));
    for (const id of totalDeleteIds) survivingIds.delete(id);

    const mobilePlans: { id: number; raw: string; normalized: string | null; ok: boolean }[] = [];
    for (const row of rows) {
      if (!survivingIds.has(row.id)) continue;
      const raw = row.contact_number;
      if (raw.trim() === "-") continue; // already-blank placeholder, not "unclean"
      const result = normalizeMobile(raw);
      if (result.ok && result.normalized !== raw) {
        mobilePlans.push({ id: row.id, raw, normalized: result.normalized, ok: true });
      } else if (!result.ok) {
        mobilePlans.push({ id: row.id, raw, normalized: null, ok: false });
      }
    }
    const mobileReformatted = mobilePlans.filter((p) => p.ok);
    const mobileFlagged = mobilePlans.filter((p) => !p.ok);

    console.log("\n========== LEGACY CANDIDATE_MASTER MIGRATION ==========");
    console.log(`Total rows:                          ${rows.length}`);
    console.log(`Duplicate-CID groups found:          ${dupPlans.length}`);
    console.log(`  → collapse (name match):           ${collapsePlans.length} groups, ${totalDeleteIds.length} row(s) to delete`);
    console.log(`  → quarantine (name mismatch):      ${quarantinePlans.length} groups, ${quarantineRowCount} row(s) flagged`);
    console.log(`Contact Number reformatted cleanly:  ${mobileReformatted.length}`);
    console.log(`Contact Number flagged (unclean):    ${mobileFlagged.length}`);

    if (dryRun) {
      console.log("\n-- Sample collapse plans --");
      for (const p of collapsePlans.slice(0, 5)) {
        console.log(`  cid=${p.cid} survivor=${p.survivorId} delete=[${p.deleteIds.join(",")}]`);
      }
      console.log("-- Sample quarantine plans --");
      for (const p of quarantinePlans.slice(0, 5)) {
        console.log(`  cid=${p.cid} rows=[${p.allIds.join(",")}]`);
      }
      console.log("-- Sample unclean contact numbers --");
      for (const p of mobileFlagged.slice(0, 10)) {
        console.log(`  id=${p.id} raw=${JSON.stringify(p.raw)}`);
      }
      console.log("\nDry run OK — no DB writes.");
      console.log("=======================================================\n");
      return;
    }

    const reviewFlagCount = quarantineRowCount + mobileFlagged.length;
    const result = reviewFlagCount > 0 ? "partial" : "success";

    // A row can receive more than one flag (e.g. both duplicate-mismatch and
    // unclean-mobile) — dedupe by row id so unchanged_count isn't
    // double-subtracted for those rows.
    const flaggedRowIds = new Set<number>();
    for (const p of quarantinePlans) for (const id of p.allIds) flaggedRowIds.add(id);
    for (const p of mobileFlagged) flaggedRowIds.add(p.id);
    const unchangedCount = survivingIds.size - mobileReformatted.length - flaggedRowIds.size;

    await sql.begin(async (tx) => {
      const [historyRow] = await tx<{ id: number }[]>`
        INSERT INTO candidate_sync_history
          (started_at, finished_at, result, source_filename, triggered_by,
           rows_in_sheet, inserted_count, updated_count, unchanged_count,
           quarantined_count, review_flag_count)
        VALUES
          (${startedAt}, NOW(), ${result}, ${LEGACY_MIGRATION_SENTINEL}, 'legacy-migration-script',
           ${rows.length}, 0, ${mobileReformatted.length},
           ${unchangedCount},
           ${quarantineRowCount}, ${reviewFlagCount})
        RETURNING id
      `;
      const syncId = historyRow.id;

      for (const p of quarantinePlans) {
        for (const rowId of p.allIds) {
          await tx`
            INSERT INTO candidate_review_flags (sync_id, cid, reason, detail)
            VALUES (${syncId}, ${p.cid}, 'duplicate_name_mismatch', ${sql.json({ rowId, allIds: p.allIds })})
          `;
        }
      }

      for (const p of mobileFlagged) {
        await tx`
          INSERT INTO candidate_review_flags (sync_id, cid, reason, detail)
          VALUES (
            ${syncId},
            (SELECT cid FROM candidate_master WHERE id = ${p.id}),
            'legacy_contact_number_unclean',
            ${sql.json({ rowId: p.id, raw: p.raw })}
          )
        `;
      }

      for (const p of mobileReformatted) {
        await tx`
          UPDATE candidate_master SET contact_number = ${p.normalized} WHERE id = ${p.id}
        `;
      }

      if (totalDeleteIds.length > 0) {
        await tx`
          DELETE FROM candidate_master WHERE id IN ${tx(totalDeleteIds)}
        `;
      }
    });

    const finalCount = Number(
      (await sql<{ c: string }[]>`SELECT COUNT(*)::text AS c FROM candidate_master`)[0]?.c ?? "0"
    );
    console.log("\n-- Database --");
    console.log(`Rows deleted (collapsed duplicates): ${totalDeleteIds.length}`);
    console.log(`Final candidate_master row count:    ${finalCount}`);
    console.log(`Review flags written:                ${reviewFlagCount}`);
    console.log("=======================================================\n");
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
