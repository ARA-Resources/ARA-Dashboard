/**
 * Validates that LATER, SMALL dated Accenture uploads work through the
 * HTTP route (POST /api/dataset/candidate/accenture-sync) — not just the
 * CLI — because both callers go through the same `invokeCandidateAccentureSync`
 * dispatch (confirmed by reading both files during planning). The 51k-row
 * historical backfill stays CLI-only by design; this script is about a
 * normal, small, later report arriving through the dashboard screen.
 *
 * Invokes the route handler directly with a constructed multipart Request
 * (same technique as verify-candidate-oorwin-sync-route.ts) — no live HTTP
 * server needed.
 *
 * Covers: a one-new-date dated file processed in replay mode through the
 * route; re-uploading the SAME file producing ZERO duplicate history rows
 * (derived-checkpoint idempotency, exercised for real through the route);
 * and a classic (no-Date-column) file still taking the unmodified classic
 * path through the same route.
 *
 * DESTRUCTIVE — throwaway/test DB only. Self-cleans, plus rbactest.* users.
 *
 * Run: npx tsx scripts/verify-candidate-accenture-replay-route.ts
 */
import * as XLSX from "xlsx";
import {
  cleanup,
  closeDb,
  cookieFor,
  createUser,
  loadEnv,
  openDb,
  type Db,
} from "./verify-rbac-harness";

interface TestResult {
  name: string;
  status: "PASS" | "FAIL";
  detail?: string;
}
const results: TestResult[] = [];
function check(name: string, pass: boolean, detail?: string) {
  results.push({ name, status: pass ? "PASS" : "FAIL", detail });
}

const RUN_ID = Date.now();
const CID = (n: number) => `C6${RUN_ID}${n}`;
const cidsUsed: string[] = [];

function serial(dateStr: string): number {
  const EXCEL_EPOCH_UTC_MS = Date.UTC(1899, 11, 30);
  const ms = new Date(`${dateStr}T00:00:00.000Z`).getTime();
  return Math.round((ms - EXCEL_EPOCH_UTC_MS) / 86_400_000);
}

const DATED_HEADER = [
  "Date",
  "Candidate Name",
  "Candidate Email",
  "Candidate ID",
  "Management Level",
  "Application Completion Status",
  "Candidate Stage",
  "Current CID Source (As per candidate latest application)",
];
const CLASSIC_HEADER = DATED_HEADER.slice(1); // same, minus "Date"

function buildWorkbookBuffer(header: string[], rows: (string | number)[][]): Buffer {
  const ws = XLSX.utils.aoa_to_sheet([header, ...rows]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

function multipartReq(pathname: string, cookie: string, buffer: Buffer, filename: string): Request {
  const fd = new FormData();
  fd.set("file", new File([new Uint8Array(buffer)], filename, { type: "application/octet-stream" }));
  return new Request(`http://localhost${pathname}`, { method: "POST", headers: { cookie }, body: fd });
}

async function main() {
  await loadEnv();
  const db: Db = await openDb();
  await cleanup(db);

  try {
    const existingCount = Number((await db<{ c: string }[]>`SELECT COUNT(*)::text AS c FROM candidate_master`)[0]?.c ?? "0");
    if (existingCount > 100) {
      throw new Error(`candidate_master has ${existingCount} rows — refusing to run against what looks like real data.`);
    }

    const { POST } = await import("../src/app/api/dataset/candidate/accenture-sync/route");
    const editor = await createUser(db, { role: "editor" });
    const editorCookie = await cookieFor(editor);

    // ===== 1. One-new-date dated file through the route -> replay mode =====
    const cid1 = CID(1);
    cidsUsed.push(cid1);
    const datedBuf1 = buildWorkbookBuffer(DATED_HEADER, [
      [serial("2026-01-26"), "File Name", "a@x.com", cid1, "CL9", "Yes", "Screen", "Agency"],
    ]);
    const res1 = await POST(multipartReq("/api/dataset/candidate/accenture-sync", editorCookie, datedBuf1, "dated1.xlsx"));
    check("Route, dated file: 200 ok", res1.status === 200, String(res1.status));
    const body1 = (await res1.json()) as { ok: boolean; counts?: Record<string, unknown> };
    check("Route, dated file: ok:true", body1.ok === true, JSON.stringify(body1));

    const row1 = (await db<{ accenture_candidate_stage: string; last_accenture_report_date: string | null }[]>`
      SELECT accenture_candidate_stage, last_accenture_report_date FROM candidate_master WHERE cid = ${cid1}
    `)[0];
    check("Route, dated file: Stage landed as Screen", row1?.accenture_candidate_stage === "Screen", row1?.accenture_candidate_stage);
    check(
      "Route, dated file: last_accenture_report_date is set (replay path, not classic)",
      row1?.last_accenture_report_date === "2026-01-26",
      row1?.last_accenture_report_date ?? "null"
    );

    // ===== 2. Re-upload the SAME dated file -> zero duplicate history rows =====
    const beforeCount = Number(
      (await db<{ c: string }[]>`SELECT COUNT(*)::text AS c FROM candidate_sync_changes WHERE cid = ${cid1}`)[0].c
    );
    const res2 = await POST(multipartReq("/api/dataset/candidate/accenture-sync", editorCookie, datedBuf1, "dated1.xlsx"));
    check("Route, re-upload same file: 200 ok", res2.status === 200, String(res2.status));
    const afterCount = Number(
      (await db<{ c: string }[]>`SELECT COUNT(*)::text AS c FROM candidate_sync_changes WHERE cid = ${cid1}`)[0].c
    );
    check(
      "Route, re-upload same file: ZERO new history rows (idempotent checkpoint, exercised through the route)",
      afterCount === beforeCount,
      `before=${beforeCount} after=${afterCount}`
    );

    // ===== 3. A NEW date added for the same CID through the route -> one real new step =====
    const datedBuf2 = buildWorkbookBuffer(DATED_HEADER, [
      [serial("2026-02-10"), "File Name", "a@x.com", cid1, "CL9", "Yes", "Interview", "Agency"],
    ]);
    const res3 = await POST(multipartReq("/api/dataset/candidate/accenture-sync", editorCookie, datedBuf2, "dated2.xlsx"));
    check("Route, new-date file: 200 ok", res3.status === 200, String(res3.status));
    const row3 = (await db<{ accenture_candidate_stage: string }[]>`
      SELECT accenture_candidate_stage FROM candidate_master WHERE cid = ${cid1}
    `)[0];
    check("Route, new-date file: Stage advanced to Interview", row3?.accenture_candidate_stage === "Interview", row3?.accenture_candidate_stage);
    const stageSteps = await db<{ old_value: string; new_value: string }[]>`
      SELECT old_value, new_value FROM candidate_sync_changes WHERE cid = ${cid1} AND field_name = 'accenture_candidate_stage' ORDER BY id
    `;
    check(
      "Route, new-date file: exactly 1 real stage step logged (Screen->Interview), no duplicate from the earlier re-upload",
      stageSteps.length === 1 && stageSteps[0].old_value === "Screen" && stageSteps[0].new_value === "Interview",
      JSON.stringify(stageSteps)
    );

    // ===== 4. Classic (no-Date-column) file through the SAME route -> still classic path =====
    const cid2 = CID(2);
    cidsUsed.push(cid2);
    const classicBuf = buildWorkbookBuffer(CLASSIC_HEADER, [["File Name", "b@x.com", cid2, "CL9", "Yes", "Screen", "Agency"]]);
    const res4 = await POST(multipartReq("/api/dataset/candidate/accenture-sync", editorCookie, classicBuf, "classic.xlsx"));
    check("Route, classic file: 200 ok", res4.status === 200, String(res4.status));
    const row4 = (await db<{ accenture_candidate_stage: string; last_accenture_report_date: string | null }[]>`
      SELECT accenture_candidate_stage, last_accenture_report_date FROM candidate_master WHERE cid = ${cid2}
    `)[0];
    check("Route, classic file: Stage landed as Screen (classic engine's plain diff)", row4?.accenture_candidate_stage === "Screen", row4?.accenture_candidate_stage);
    check(
      "Route, classic file: last_accenture_report_date stays NULL (classic path never sets it — positive signal it took the classic engine, not replay)",
      row4?.last_accenture_report_date === null,
      row4?.last_accenture_report_date ?? "null"
    );
  } finally {
    await db`DELETE FROM candidate_sync_changes WHERE cid = ANY(${cidsUsed})`;
    await db`DELETE FROM candidate_master WHERE cid = ANY(${cidsUsed})`;
    await db`DELETE FROM candidate_sync_history WHERE source_filename = ANY(${["dated1.xlsx", "dated2.xlsx", "classic.xlsx"]})`;
    await cleanup(db);
    await closeDb();
  }

  console.log("\n========== TEST RESULTS ==========");
  let failures = 0;
  for (const r of results) {
    console.log(`[${r.status}] ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
    if (r.status === "FAIL") failures += 1;
  }
  console.log(`\n${results.length - failures}/${results.length} passed.`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
