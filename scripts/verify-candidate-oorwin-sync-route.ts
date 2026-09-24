/**
 * C7 validation — the upload API route
 * (POST /api/dataset/candidate/oorwin-sync).
 *
 * Invokes the route handler directly with a constructed multipart Request
 * (same technique as scripts/verify-rbac-sessions.ts), so the real
 * authorizeRequest gate + validateExcelBuffer integrity check + sync job
 * all run for real — no live HTTP server needed.
 *
 * DESTRUCTIVE — the real-file case writes to candidate_master /
 * candidate_sync_history / candidate_sync_changes / candidate_review_flags.
 * Throwaway/test DB only. Also creates + deletes rbactest.* fixture users.
 *
 * Run: npx tsx scripts/verify-candidate-oorwin-sync-route.ts [pathToXlsFile]
 */
import fs from "node:fs/promises";
import path from "node:path";
import {
  assert,
  assertEq,
  bodyOf,
  cleanup,
  closeDb,
  cookieFor,
  createUser,
  loadEnv,
  openDb,
  Suite,
  type Db,
} from "./verify-rbac-harness";

function multipartReq(
  pathname: string,
  opts: { cookie?: string; formData?: FormData }
): Request {
  const headers: Record<string, string> = {};
  if (opts.cookie) headers.cookie = opts.cookie;
  return new Request(`http://localhost${pathname}`, {
    method: "POST",
    headers,
    body: opts.formData,
  });
}

function fileFormData(filename: string, bytes: Buffer | Uint8Array, mime = "application/octet-stream"): FormData {
  const fd = new FormData();
  fd.set("file", new File([new Uint8Array(bytes)], filename, { type: mime }));
  return fd;
}

async function main() {
  await loadEnv();
  const db: Db = await openDb();
  await cleanup(db);

  const results: Suite[] = [];
  let realSyncId: number | null = null;
  let editorId: string | null = null;
  let viewerId: string | null = null;

  try {
    const existingCount = Number(
      (await db<{ c: string }[]>`SELECT COUNT(*)::text AS c FROM candidate_master`)[0]?.c ?? "0"
    );
    if (existingCount > 100) {
      throw new Error(
        `candidate_master has ${existingCount} rows — refusing to run this destructive test against what looks like real data. Point POSTGRES_URL at a throwaway database.`
      );
    }

    const { POST } = await import("../src/app/api/dataset/candidate/oorwin-sync/route");

    const editor = await createUser(db, { role: "editor" });
    const viewer = await createUser(db, { role: "viewer" });
    editorId = editor.id;
    viewerId = viewer.id;
    const editorCookie = await cookieFor(editor);
    const viewerCookie = await cookieFor(viewer);

    const s = new Suite("candidate-oorwin-sync-route");
    results.push(s);

    await s.test("no session cookie -> 401", async () => {
      const res = await POST(
        multipartReq("/api/dataset/candidate/oorwin-sync", {
          formData: fileFormData("x.xls", Buffer.from("irrelevant")),
        })
      );
      assertEq(res.status, 401, "status");
    });

    await s.test("viewer role -> 403 (editor required)", async () => {
      const res = await POST(
        multipartReq("/api/dataset/candidate/oorwin-sync", {
          cookie: viewerCookie,
          formData: fileFormData("x.xls", Buffer.from("irrelevant")),
        })
      );
      assertEq(res.status, 403, "status");
    });

    await s.test("editor, no file field -> 400", async () => {
      const res = await POST(
        multipartReq("/api/dataset/candidate/oorwin-sync", {
          cookie: editorCookie,
          formData: new FormData(),
        })
      );
      assertEq(res.status, 400, "status");
      const body = await bodyOf(res);
      assert(body.ok === false, "ok false");
    });

    await s.test("editor, unsupported extension (.txt) -> 400", async () => {
      const res = await POST(
        multipartReq("/api/dataset/candidate/oorwin-sync", {
          cookie: editorCookie,
          formData: fileFormData("notes.txt", Buffer.from("hello")),
        })
      );
      assertEq(res.status, 400, "status");
    });

    await s.test("editor, OLE2-signed but unparseable .xls -> job records a 'failed' run (200, ok:true wrapper, result:'failed')", async () => {
      // Valid OLE2 magic bytes (passes validateExcelBuffer's signature check)
      // followed by garbage (fails XLSX.read / header-anchor detection inside
      // the job itself) — exercises the route's success-path wrapping of a
      // job-level failure, distinct from the 400 integrity-rejection case above.
      const ole2Garbage = Buffer.concat([
        Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
        Buffer.from("not actually a real workbook body"),
      ]);
      const res = await POST(
        multipartReq("/api/dataset/candidate/oorwin-sync", {
          cookie: editorCookie,
          formData: fileFormData("bad.xls", ole2Garbage),
        })
      );
      assertEq(res.status, 200, "status");
      const body = await bodyOf(res);
      const garbageSyncId = typeof body.syncId === "number" ? body.syncId : null;
      try {
        assertEq(body.ok, false, "ok reflects job failure");
        assertEq(body.result, "failed", "result");
        assert(typeof body.failureReason === "string" && (body.failureReason as string).length > 0, "failureReason set");
        assert(garbageSyncId !== null, "syncId recorded for audit even on parse failure");
      } finally {
        if (garbageSyncId !== null) {
          await db`DELETE FROM candidate_sync_history WHERE id = ${garbageSyncId}`;
        }
      }
    });

    await s.test("editor, real Oorwin sample file -> 200, partial result, matches DB history row", async () => {
      const filePath =
        process.argv[2] ||
        path.join(process.cwd(), "data", "excel", "ACCI Candidate Master Tracker Test - Anurag Shah-4.xls");
      const buffer = await fs.readFile(filePath);

      const res = await POST(
        multipartReq("/api/dataset/candidate/oorwin-sync", {
          cookie: editorCookie,
          formData: fileFormData("anurag-sample.xls", buffer),
        })
      );
      assertEq(res.status, 200, "status");
      const body = await bodyOf(res);
      // Capture syncId for cleanup BEFORE any assertion that could throw —
      // otherwise a failed assertion below leaves this run's rows committed
      // and uncleaned (each row commits independently, not one transaction),
      // silently poisoning a later re-run of this same script.
      if (typeof body.syncId === "number") realSyncId = body.syncId;
      assertEq(body.ok, true, "ok true (partial is still a completed run)");
      assertEq(body.result, "partial", "result (2 known duplicate-mismatch pairs need review)");
      assertEq((body.counts as Record<string, number>).rowsInSheet, 60, "rowsInSheet");
      assertEq((body.counts as Record<string, number>).quarantined, 5, "quarantined (2 duplicate-mismatch pairs + 1 invalid-CID row)");
      assertEq((body.counts as Record<string, number>).inserted, 55, "inserted (fresh DB)");
      assert(typeof body.syncId === "number", "syncId set");

      const historyRow = (await db`SELECT * FROM candidate_sync_history WHERE id = ${realSyncId}`)[0];
      assert(historyRow !== undefined, "history row exists");
      assertEq(historyRow?.result, "partial", "history row result");
      assertEq(historyRow?.triggered_by, editor.email, "history row triggered_by === authenticated user's email");
      assertEq(Number(historyRow?.inserted_count), 55, "history row inserted_count matches response");
    });
  } finally {
    // -- cleanup --
    if (realSyncId !== null) {
      // UNION with a date_of_upload fallback: a pure insert has no prior
      // value to diff against, so it never gets a candidate_sync_changes
      // row — that table alone would miss every freshly-inserted CID here.
      const realCids = (
        await db<{ cid: string }[]>`
          SELECT DISTINCT cid FROM candidate_sync_changes WHERE sync_id = ${realSyncId}
          UNION
          SELECT cid FROM candidate_master WHERE date_of_upload = to_char(NOW(), 'DD/MM/YYYY')
        `
      ).map((r) => r.cid);
      if (realCids.length > 0) {
        await db`DELETE FROM candidate_master WHERE cid = ANY(${realCids})`;
      }
      await db`DELETE FROM candidate_review_flags WHERE sync_id = ${realSyncId}`;
      await db`DELETE FROM candidate_sync_changes WHERE sync_id = ${realSyncId}`;
      await db`DELETE FROM candidate_sync_history WHERE id = ${realSyncId}`;
    }
    await cleanup(db);
    void editorId;
    void viewerId;
    await closeDb();
  }

  console.log("\n========== TEST RESULTS ==========");
  let total = 0;
  let failed = 0;
  for (const s of results) {
    for (const r of s.results) {
      total += 1;
      if (!r.ok) failed += 1;
      console.log(`[${r.ok ? "PASS" : "FAIL"}] ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
    }
  }
  console.log(`\n${total - failed}/${total} passed.`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
