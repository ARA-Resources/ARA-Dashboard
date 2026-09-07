/**
 * Phase 5 — Req 1: public signup can never create anything above `viewer`.
 *
 * Run standalone:  npx tsx scripts/verify-rbac-signup.ts
 */
import {
  Suite,
  assert,
  assertEq,
  bodyOf,
  cleanup,
  closeDb,
  countUsers,
  getUserRow,
  loadEnv,
  openDb,
  req,
  testEmail,
  TEST_PASSWORD,
  type Db,
} from "./verify-rbac-harness";

export async function suite(db: Db): Promise<Suite> {
  const s = new Suite("signup");
  const { POST: signup } = await import("../src/app/api/auth/signup/route");

  const attempts: Array<{ label: string; extra: Record<string, unknown> }> = [
    { label: "role=super_admin", extra: { role: "super_admin" } },
    { label: "role=admin", extra: { role: "admin" } },
    { label: "role=editor", extra: { role: "editor" } },
    { label: "role=viewer (still a role field)", extra: { role: "viewer" } },
    { label: "roleId=<uuid>", extra: { roleId: "00000000-0000-0000-0000-000000000000" } },
    { label: "role=null", extra: { role: null } },
    { label: "role as array", extra: { role: ["admin"] } },
    { label: "role nested object", extra: { role: { name: "admin" } } },
  ];

  for (const a of attempts) {
    await s.test(`signup with ${a.label} is rejected, no account created`, async () => {
      const email = testEmail("signup");
      const res = await signup(
        req("/api/auth/signup", {
          method: "POST",
          body: { username: email, password: TEST_PASSWORD, ...a.extra },
        })
      );
      const body = await bodyOf(res);
      assertEq(res.status, 400, `status for ${a.label}`);
      assertEq(body.code, "ROLE_NOT_ALLOWED", `code for ${a.label}`);
      assertEq(await countUsers(db, email), 0, `no user row for ${a.label}`);
    });
  }

  await s.test("clean signup (no role field) creates a viewer", async () => {
    const email = testEmail("signup.ok");
    const res = await signup(
      req("/api/auth/signup", {
        method: "POST",
        body: { username: email, password: TEST_PASSWORD },
      })
    );
    const body = await bodyOf(res);
    assertEq(res.status, 201, "status");
    assertEq(body.role, "viewer", "response role");
    const row = await getUserRow(db, email);
    assert(row, "user row exists");
    assertEq(row!.role, "viewer", "DB role");
    assertEq(row!.active, true, "DB active");
  });

  await s.test("signup outside the allowed email domain is rejected", async () => {
    const res = await signup(
      req("/api/auth/signup", {
        method: "POST",
        body: { username: "someone@gmail.com", password: TEST_PASSWORD },
      })
    );
    assertEq(res.status, 400, "status");
  });

  return s;
}

const isMain =
  typeof process.argv[1] === "string" &&
  process.argv[1].replace(/\\/g, "/").endsWith("verify-rbac-signup.ts");

if (isMain) {
  void (async () => {
    await loadEnv();
    const db = await openDb();
    await cleanup(db);
    const s = await suite(db);
    await cleanup(db);
    await closeDb();
    const failed = s.results.filter((r) => !r.ok);
    console.log(`\nsignup: ${s.results.length - failed.length}/${s.results.length} passed`);
    process.exitCode = failed.length ? 1 : 0;
  })();
}
