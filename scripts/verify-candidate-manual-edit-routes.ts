/**
 * Ad hoc HTTP-contract smoke test for the migration 021 route handlers
 * (POST /rows, PATCH /rows/[id], DELETE /rows/[id], GET /jr-lookup) — NOT a
 * committed part of the permanent verify-*.ts suite. Reuses
 * scripts/verify-rbac-harness.ts's own technique and helpers: import the
 * real Route Handler functions and invoke them with a constructed Request,
 * no running server needed — the same approach verify-rbac-access-matrix.ts
 * already uses, extended here to check the actual response bodies (not
 * just status codes) the UI's mutation hooks depend on.
 *
 * DESTRUCTIVE — throwaway/test DB only.
 */
import {
  cleanup,
  closeDb,
  cookieFor,
  createUser,
  loadEnv,
  openDb,
} from "./verify-rbac-harness";

const RUN_ID = Date.now();
const CID = `C9${RUN_ID}1`;

async function main() {
  await loadEnv();
  const db = await openDb();
  await cleanup(db);

  let failures = 0;
  function assert(name: string, pass: boolean, detail?: unknown) {
    console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? ` (${JSON.stringify(detail)})` : ""}`);
    if (!pass) failures += 1;
  }

  const viewer = await createUser(db, { role: "viewer" });
  const admin = await createUser(db, { role: "admin" });
  const viewerCookie = await cookieFor(viewer);
  const adminCookie = await cookieFor(admin);

  const fullValues = {
    cid: CID,
    name: "Route Smoke Test",
    email: "-",
    contact_number: "-",
    date_of_upload: "-",
    submitter: "-",
    customer: "-",
    job_requisition_id: "-",
    primary_skills: "-",
    job_management_level: "-",
    market: "-",
    client_spoc: "-",
    status: "-",
    submitted_date: "-",
    submission_comments: "-",
    gender: "-",
  };

  let rowId: number | null = null;

  try {
    const { POST } = await import("../src/app/api/excel/candidate-master-sheet/rows/route");
    const { PATCH, DELETE } = await import("../src/app/api/excel/candidate-master-sheet/rows/[id]/route");
    const { GET: jrLookupGet } = await import("../src/app/api/excel/candidate-master-sheet/jr-lookup/route");

    // ---- POST /rows as viewer (Add) ----
    const addRes = await POST(
      new Request("http://localhost/api/excel/candidate-master-sheet/rows", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: viewerCookie },
        body: JSON.stringify({ values: fullValues }),
      })
    );
    const addBody = (await addRes.json()) as { ok: boolean; row?: { id: number; cid: string } };
    assert(
      "POST /rows as viewer -> 200 ok, row inserted",
      addRes.status === 200 && addBody.ok === true && addBody.row?.cid === CID,
      { status: addRes.status, ok: addBody.ok }
    );
    rowId = addBody.row?.id ?? null;

    // ---- POST /rows again, same CID, no onDuplicate -> 409 ----
    const dupRes = await POST(
      new Request("http://localhost/api/excel/candidate-master-sheet/rows", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: viewerCookie },
        body: JSON.stringify({ values: { ...fullValues, name: "Second" } }),
      })
    );
    const dupBody = (await dupRes.json()) as { ok: boolean; duplicates?: unknown[] };
    assert(
      "POST /rows duplicate CID -> 409 with duplicates list",
      dupRes.status === 409 && Array.isArray(dupBody.duplicates) && dupBody.duplicates.length === 1,
      { status: dupRes.status }
    );

    if (rowId != null) {
      // ---- PATCH /rows/[id] as viewer (Modify) ----
      // Fetch the row's REAL current values first — date_of_upload was
      // "-" in fullValues but the server defaults a blank Upload Date to
      // today on insert (see validateCandidateManualInput), so `fullValues`
      // itself is not a valid "original" snapshot for the stale-edit guard.
      const currentRowForOriginal = (
        (await (await import("../src/services/persistence/read-candidate-master")).getCandidateMasterById(
          rowId,
          db
        )) as unknown as Record<string, string>
      );
      const originalSnapshot = { ...fullValues, date_of_upload: currentRowForOriginal.date_of_upload };
      const modifyRes = await PATCH(
        new Request(`http://localhost/api/excel/candidate-master-sheet/rows/${rowId}`, {
          method: "PATCH",
          headers: { "content-type": "application/json", cookie: viewerCookie },
          body: JSON.stringify({
            values: { ...originalSnapshot, name: "Route Smoke Test — Modified" },
            original: originalSnapshot,
          }),
        }),
        { params: Promise.resolve({ id: String(rowId) }) }
      );
      const modifyBody = (await modifyRes.json()) as { ok: boolean; changedFields?: string[] };
      assert(
        "PATCH /rows/[id] as viewer -> 200 ok, name changed",
        modifyRes.status === 200 && modifyBody.ok === true && (modifyBody.changedFields ?? []).includes("name"),
        { status: modifyRes.status, changedFields: modifyBody.changedFields }
      );

      // ---- DELETE /rows/[id] as viewer -> 403 (server-side enforcement, not just a hidden button) ----
      const deleteAsViewerRes = await DELETE(
        new Request(`http://localhost/api/excel/candidate-master-sheet/rows/${rowId}`, {
          method: "DELETE",
          headers: { cookie: viewerCookie },
        }),
        { params: Promise.resolve({ id: String(rowId) }) }
      );
      assert("DELETE /rows/[id] as viewer -> 403", deleteAsViewerRes.status === 403, {
        status: deleteAsViewerRes.status,
      });

      // ---- DELETE /rows/[id] as admin -> 200, soft deleted ----
      const deleteAsAdminRes = await DELETE(
        new Request(`http://localhost/api/excel/candidate-master-sheet/rows/${rowId}`, {
          method: "DELETE",
          headers: { cookie: adminCookie },
        }),
        { params: Promise.resolve({ id: String(rowId) }) }
      );
      const deleteBody = (await deleteAsAdminRes.json()) as { ok: boolean; cid?: string };
      assert(
        "DELETE /rows/[id] as admin -> 200, soft-deleted",
        deleteAsAdminRes.status === 200 && deleteBody.ok === true && deleteBody.cid === CID,
        { status: deleteAsAdminRes.status }
      );
    }

    // ---- GET /jr-lookup, not found ----
    const jrRes = await jrLookupGet(
      new Request("http://localhost/api/excel/candidate-master-sheet/jr-lookup?jr=TOTALLY-NOT-FOUND-JR")
    );
    const jrBody = (await jrRes.json()) as { ok: boolean; sources?: { lateral: boolean; executive: boolean } };
    assert(
      "GET /jr-lookup not-found JR -> 200, sources both false",
      jrRes.status === 200 && jrBody.ok === true && jrBody.sources?.lateral === false && jrBody.sources?.executive === false
    );
  } finally {
    await db`DELETE FROM candidate_review_flags WHERE cid = ${CID}`;
    await db`DELETE FROM candidate_sync_changes WHERE cid = ${CID}`;
    await db`DELETE FROM candidate_master WHERE cid = ${CID}`;
    await db`DELETE FROM candidate_sync_history WHERE source_filename IN ('manual-add', 'manual-modify') AND triggered_by IN (${viewer.email}, ${admin.email})`;
    await cleanup(db);
    await closeDb();
  }

  console.log(failures === 0 ? "\nAll route smoke checks passed." : `\n${failures} check(s) FAILED.`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
