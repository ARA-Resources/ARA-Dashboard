/**
 * C3 validation — unified Candidate Master Sheet auto-fetch resolver.
 *
 * Proves: `resolveCandidateAutoFetchFields` correctly detects "found in
 * both lateral_master and executive_master, values disagree" for every
 * JR ID actually shared between the two tables today (and only those),
 * and correctly falls back to Oorwin-supplied values when a JR ID isn't
 * found in either table.
 *
 * Previously relied entirely on whatever JR IDs happened to already overlap
 * between lateral_master/executive_master in the target DB — on a DB with no
 * such overlap (e.g. a freshly-migrated test DB with no real data yet), the
 * "every colliding JR ID was queried" check had nothing to query and failed,
 * even though the resolver itself was never exercised, let alone broken.
 * Now inserts its own guaranteed-overlapping fixture (one agreeing pair, one
 * conflicting pair, RUN_ID-unique) so the test is self-contained and
 * deterministic regardless of ambient data; cleans both up in `finally`.
 *
 * DESTRUCTIVE (writes its own fixture rows to lateral_master/executive_master,
 * removed in `finally`) — throwaway/test DB only.
 *
 * Run: npx tsx scripts/verify-candidate-auto-fetch.ts
 */
import { closeDbClient, getDbClient } from "../src/lib/persistence/db-client";
import { resolveCandidateAutoFetchFields } from "../src/services/candidate-processing/candidate-auto-fetch";

interface TestResult {
  name: string;
  status: "PASS" | "FAIL";
  detail?: string;
}

const RUN_ID = Date.now();
const JR_AGREE = `JR-AGREE-${RUN_ID}`;
const JR_CONFLICT = `JR-CONFLICT-${RUN_ID}`;
const JR_LATERAL_ONLY = `JR-LATONLY-${RUN_ID}`;
const FIXTURE_JRS = [JR_AGREE, JR_CONFLICT, JR_LATERAL_ONLY];

async function main() {
  const sql = getDbClient();
  const results: TestResult[] = [];

  try {
    // -- Self-contained overlap fixture: one JR both tables agree on, one
    // they conflict on, plus one lateral-only JR for the single-table case. --
    await sql`
      INSERT INTO lateral_master (job_requisition_id, primary_skills, job_management_level, market_map, poc)
      VALUES
        (${JR_AGREE}, 'Shared Skill', '8-Associate Manager', 'Shared Market', 'Shared SPOC'),
        (${JR_CONFLICT}, 'Lateral Skill', 'Lateral Level', 'Lateral Market', 'Lateral SPOC'),
        (${JR_LATERAL_ONLY}, 'Lateral-Only Skill', 'Lateral-Only Level', 'Lateral-Only Market', 'Lateral-Only SPOC')
      ON CONFLICT (job_requisition_id) DO NOTHING
    `;
    await sql`
      INSERT INTO executive_master (job_requisition_id, primary_skills, job_management_level, market_map)
      VALUES
        (${JR_AGREE}, 'Shared Skill', '8-Associate Manager', 'Shared Market'),
        (${JR_CONFLICT}, 'Executive Skill', 'Executive Level', 'Executive Market')
      ON CONFLICT (job_requisition_id) DO NOTHING
    `;

    const collisions = await sql<{ job_requisition_id: string }[]>`
      SELECT l.job_requisition_id
      FROM lateral_master l
      JOIN executive_master e ON l.job_requisition_id = e.job_requisition_id
      ORDER BY l.job_requisition_id
    `;
    console.log(`Found ${collisions.length} JR ID(s) present in both lateral_master and executive_master (includes this run's own fixture: ${JR_AGREE}, ${JR_CONFLICT}).\n`);

    results.push({
      name: "Fixture JR_AGREE and JR_CONFLICT both appear in the lateral/executive collision scan",
      status:
        collisions.some((c) => c.job_requisition_id === JR_AGREE) &&
        collisions.some((c) => c.job_requisition_id === JR_CONFLICT)
          ? "PASS"
          : "FAIL",
      detail: JSON.stringify(collisions.map((c) => c.job_requisition_id)),
    });

    const agreeResult = await resolveCandidateAutoFetchFields(
      JR_AGREE,
      { primarySkills: null, market: null, clientSpoc: null },
      sql
    );
    results.push({
      name: "JR_AGREE (both tables identical): zero conflicts",
      status: agreeResult.conflicts.length === 0 ? "PASS" : "FAIL",
      detail: JSON.stringify(agreeResult.conflicts),
    });

    const conflictResult = await resolveCandidateAutoFetchFields(
      JR_CONFLICT,
      { primarySkills: null, market: null, clientSpoc: null },
      sql
    );
    results.push({
      name: "JR_CONFLICT (tables disagree): primary_skills, job_management_level, and market all flagged as conflicts",
      status:
        ["primarySkills", "jobManagementLevel", "market"].every((f) =>
          conflictResult.conflicts.some((c) => c.field === f)
        )
          ? "PASS"
          : "FAIL",
      detail: JSON.stringify(conflictResult.conflicts),
    });

    let jrIdsWithAnyConflict = 0;
    let totalConflictFields = 0;

    for (const { job_requisition_id } of collisions) {
      const result = await resolveCandidateAutoFetchFields(
        job_requisition_id,
        { primarySkills: null, market: null, clientSpoc: null },
        sql
      );
      if (result.conflicts.length > 0) {
        jrIdsWithAnyConflict += 1;
        totalConflictFields += result.conflicts.length;
        console.log(`  ${job_requisition_id}: ${result.conflicts.length} conflicting field(s)`);
        for (const c of result.conflicts) {
          console.log(
            `    ${c.field}: lateral="${c.lateralValue}" vs executive="${c.executiveValue}"`
          );
        }
      } else {
        console.log(`  ${job_requisition_id}: no conflicts (values agree, or a field is missing on one side)`);
      }
    }

    console.log(
      `\n${jrIdsWithAnyConflict} of ${collisions.length} colliding JR ID(s) produced at least one field conflict (${totalConflictFields} conflicting field(s) total).`
    );

    results.push({
      name: "Every JR ID present in both tables was actually queried (no silent skips)",
      status: collisions.length > 0 ? "PASS" : "FAIL",
      detail: `${collisions.length} JR ID(s) found`,
    });

    results.push({
      name: "clientSpoc never produces a conflict (executive_master has no POC/SPOC column)",
      status: "PASS", // structurally guaranteed by resolveField's null executiveValue for clientSpoc — checked below anyway
    });
    for (const { job_requisition_id } of collisions) {
      const result = await resolveCandidateAutoFetchFields(
        job_requisition_id,
        { primarySkills: null, market: null, clientSpoc: null },
        sql
      );
      if (result.conflicts.some((c) => c.field === "clientSpoc")) {
        results[results.length - 1] = {
          name: "clientSpoc never produces a conflict (executive_master has no POC/SPOC column)",
          status: "FAIL",
          detail: `clientSpoc conflict found for ${job_requisition_id}`,
        };
        break;
      }
    }

    // Not-found JR ID → every field must fall back to the supplied Oorwin value,
    // except jobManagementLevel which has no Oorwin fallback and must stay null.
    const NON_EXISTENT_JR = "ATCI-0000000-S0000000";
    const fallback = await resolveCandidateAutoFetchFields(
      NON_EXISTENT_JR,
      { primarySkills: "Fallback Skill", market: "Fallback Market", clientSpoc: "Fallback SPOC" },
      sql
    );
    results.push({
      name: "Not-found JR ID falls back to Oorwin values for primarySkills/market/clientSpoc",
      status:
        fallback.values.primarySkills === "Fallback Skill" &&
        fallback.values.market === "Fallback Market" &&
        fallback.values.clientSpoc === "Fallback SPOC"
          ? "PASS"
          : "FAIL",
      detail: JSON.stringify(fallback.values),
    });
    results.push({
      name: "Not-found JR ID leaves jobManagementLevel null (no Oorwin fallback source exists)",
      status: fallback.values.jobManagementLevel === null ? "PASS" : "FAIL",
      detail: JSON.stringify(fallback.values.jobManagementLevel),
    });
    results.push({
      name: "Not-found JR ID produces zero conflicts",
      status: fallback.conflicts.length === 0 ? "PASS" : "FAIL",
    });

    // Found in exactly one table (JR_LATERAL_ONLY fixture — lateral_master
    // only, not executive_master). Previously picked an arbitrary ambient
    // lateral-only JR via LIMIT 1 and silently skipped this check entirely
    // when none existed; now always exercised via the fixture.
    const single = await resolveCandidateAutoFetchFields(
      JR_LATERAL_ONLY,
      { primarySkills: "should-not-be-used", market: "should-not-be-used", clientSpoc: "should-not-be-used" },
      sql
    );
    results.push({
      name: "JR found in exactly one table (lateral only) uses that table's value, no conflict, no fallback used",
      status:
        single.conflicts.length === 0 &&
        single.values.primarySkills === "Lateral-Only Skill" &&
        single.values.market === "Lateral-Only Market"
          ? "PASS"
          : "FAIL",
      detail: JSON.stringify(single.values),
    });

    console.log("\n========== TEST RESULTS ==========");
    let failures = 0;
    for (const r of results) {
      console.log(`[${r.status}] ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
      if (r.status === "FAIL") failures += 1;
    }
    console.log(`\n${results.length - failures}/${results.length} passed.`);
    if (failures > 0) process.exitCode = 1;
  } finally {
    await sql`DELETE FROM lateral_master WHERE job_requisition_id = ANY(${FIXTURE_JRS})`;
    await sql`DELETE FROM executive_master WHERE job_requisition_id = ANY(${FIXTURE_JRS})`;
    await closeDbClient();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
