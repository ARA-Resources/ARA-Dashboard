/**
 * Phase 5 — Req 5: deactivated accounts are rejected (new + existing sessions).
 *          Req 6: password change — current-password required, other sessions
 *                 invalidated, old password stops working.
 *
 * Run standalone:  npx tsx scripts/verify-rbac-sessions.ts
 */
import {
  Suite,
  assert,
  assertEq,
  bodyOf,
  cleanup,
  closeDb,
  cookieFor,
  createUser,
  getUserRow,
  invalidate,
  loadEnv,
  openDb,
  req,
  sleep,
  TEST_PASSWORD,
  type Db,
} from "./verify-rbac-harness";

export async function suite(db: Db): Promise<Suite> {
  const s = new Suite("sessions");

  const { authorizeRequest, verifySession } = await import("../src/lib/auth/dal");
  const { verifyLoginCredentials } = await import("../src/lib/auth/users-db");
  const { tokenPredatesPasswordChange } = await import(
    "../src/lib/auth/session-freshness"
  );
  const { POST: login } = await import("../src/app/api/auth/login/route");
  const { POST: changePassword } = await import(
    "../src/app/api/auth/change-password/route"
  );

  /* ----------------------- Req 5: deactivation ---------------------- */

  await s.test("deactivated user cannot authenticate a new session (login → 401)", async () => {
    const u = await createUser(db, { role: "editor", active: false });
    assertEq(
      await verifyLoginCredentials(u.email, TEST_PASSWORD),
      null,
      "verifyLoginCredentials returns null"
    );
    const res = await login(
      req("/api/auth/login", {
        method: "POST",
        body: { username: u.email, password: TEST_PASSWORD },
      })
    );
    assertEq(res.status, 401, "login status");
  });

  await s.test("existing valid session is rejected on next request after deactivation", async () => {
    const u = await createUser(db, { role: "editor", active: true });
    const cookie = await cookieFor(u);

    // session works while active
    const before = await authorizeRequest(req("/api/auth/me", { cookie }));
    assert(before.ok, "session valid while active");

    await db`UPDATE users SET active = false WHERE id = ${u.id}`;
    await invalidate(u.id); // skip the 10s cache for the test

    const gate = await authorizeRequest(req("/api/auth/me", { cookie }));
    assert(!gate.ok, "denied after deactivation");
    assertEq(gate.failure.reason, "deactivated", "reason");
    assertEq(gate.failure.status, 403, "status");

    assertEq(await verifySession(req("/api/auth/me", { cookie })), null, "verifySession → null");

    // reactivate → same cookie works again
    await db`UPDATE users SET active = true WHERE id = ${u.id}`;
    await invalidate(u.id);
    const after = await authorizeRequest(req("/api/auth/me", { cookie }));
    assert(after.ok, "session valid again after reactivation");
  });

  /* --------------------- Req 6: password change -------------------- */

  await s.test("tokenPredatesPasswordChange logic (unit)", async () => {
    const TTL = 60 * 60 * 12;
    const nowSec = Math.floor(Date.now() / 1000);
    assertEq(
      tokenPredatesPasswordChange(nowSec - 100 + TTL, new Date().toISOString()),
      true,
      "old token vs recent change"
    );
    assertEq(
      tokenPredatesPasswordChange(nowSec + TTL, new Date(Date.now() - 5000).toISOString()),
      false,
      "token newer than change"
    );
    assertEq(tokenPredatesPasswordChange(nowSec + TTL, null), false, "no change stamped");
  });

  await s.test("wrong current password is rejected, no change made", async () => {
    const u = await createUser(db, { role: "admin" });
    const before = await getUserRow(db, u.email);
    const res = await changePassword(
      req("/api/auth/change-password", {
        method: "POST",
        cookie: await cookieFor(u),
        body: {
          currentPassword: "definitely-not-it",
          newPassword: "BrandNewPass99!",
          confirmPassword: "BrandNewPass99!",
        },
      })
    );
    const body = await bodyOf(res);
    assertEq(res.status, 400, "status");
    assertEq(body.code, "CURRENT_PASSWORD_WRONG", "code");
    const after = await getUserRow(db, u.email);
    assertEq(after!.password_hash, before!.password_hash, "hash unchanged");
    const rows = await db<{ n: string }[]>`
      SELECT COUNT(*)::text AS n FROM users WHERE id = ${u.id} AND password_changed_at IS NOT NULL
    `;
    assertEq(rows[0]!.n, "0", "password_changed_at NOT stamped");
  });

  await s.test("successful change: other sessions invalidated, changer keeps a working cookie, old password dead", async () => {
    const u = await createUser(db, { role: "admin" });
    const otherDevice = await cookieFor(u, 2); // issued 2s ago → deterministically predates the change
    const changer = await cookieFor(u, 0);

    // other device works beforehand
    assert((await authorizeRequest(req("/api/auth/me", { cookie: otherDevice }))).ok, "other device ok before");

    const res = await changePassword(
      req("/api/auth/change-password", {
        method: "POST",
        cookie: changer,
        body: {
          currentPassword: TEST_PASSWORD,
          newPassword: "FreshPass2026!",
          confirmPassword: "FreshPass2026!",
        },
      })
    );
    const body = await bodyOf(res);
    assertEq(res.status, 200, `status: ${JSON.stringify(body)}`);
    const setCookie = res.headers.get("set-cookie") ?? "";
    assert(setCookie.startsWith("ara_session="), "response re-issues a session cookie");
    const freshCookie = setCookie.split(";")[0]!;
    await invalidate(u.id);

    // other device: rejected on next request
    const otherGate = await authorizeRequest(req("/api/auth/me", { cookie: otherDevice }));
    assert(!otherGate.ok, "other device rejected after change");

    // changer's fresh cookie from the response: still valid
    const freshGate = await authorizeRequest(req("/api/auth/me", { cookie: freshCookie }));
    assert(freshGate.ok, "changer's fresh cookie still valid");

    // old password no longer works for a new login
    assertEq(await verifyLoginCredentials(u.email, TEST_PASSWORD), null, "old password rejected");
    const relogin = await login(
      req("/api/auth/login", {
        method: "POST",
        body: { username: u.email, password: "FreshPass2026!" },
      })
    );
    assertEq(relogin.status, 200, "login with new password works");
  });

  return s;
}

const isMain =
  typeof process.argv[1] === "string" &&
  process.argv[1].replace(/\\/g, "/").endsWith("verify-rbac-sessions.ts");

if (isMain) {
  void (async () => {
    await loadEnv();
    const db = await openDb();
    await cleanup(db);
    const s = await suite(db);
    await cleanup(db);
    await closeDb();
    const failed = s.results.filter((r) => !r.ok);
    console.log(`\nsessions: ${s.results.length - failed.length}/${s.results.length} passed`);
    process.exitCode = failed.length ? 1 : 0;
  })();
}
