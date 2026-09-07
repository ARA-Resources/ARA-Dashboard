/**
 * Phase 5 — Req 2: only super_admin can manage users / invites.
 *          Req 7: super_admin self-protection guards.
 *
 * Run standalone:  npx tsx scripts/verify-rbac-user-management.ts
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
  loadEnv,
  openDb,
  req,
  type Db,
  type Fixture,
  type Role,
} from "./verify-rbac-harness";

type Endpoint = {
  label: string;
  call: (cookie: string | undefined, targetId: string) => Promise<Response>;
};

export async function suite(db: Db): Promise<Suite> {
  const s = new Suite("user-management");

  const { GET: listUsers } = await import("../src/app/api/admin/users/route");
  const { GET: listInvites, POST: createInviteRoute } = await import(
    "../src/app/api/admin/invites/route"
  );
  const { PATCH: patchRole } = await import(
    "../src/app/api/admin/users/[id]/role/route"
  );
  const { PATCH: patchActive } = await import(
    "../src/app/api/admin/users/[id]/active/route"
  );

  const viewer = await createUser(db, { role: "viewer" });
  const editor = await createUser(db, { role: "editor" });
  const admin = await createUser(db, { role: "admin" });
  const superAdmin = await createUser(db, { role: "super_admin" });
  const target = await createUser(db, { role: "editor" });

  const cookies: Record<"none" | Role, string | undefined> = {
    none: undefined,
    viewer: await cookieFor(viewer),
    editor: await cookieFor(editor),
    admin: await cookieFor(admin),
    super_admin: await cookieFor(superAdmin),
  };

  const endpoints: Endpoint[] = [
    {
      label: "GET /api/admin/users",
      call: (cookie) => listUsers(req("/api/admin/users", { cookie })),
    },
    {
      label: "GET /api/admin/invites",
      call: (cookie) => listInvites(req("/api/admin/invites", { cookie })),
    },
    {
      label: "POST /api/admin/invites",
      call: (cookie) =>
        createInviteRoute(
          req("/api/admin/invites", {
            method: "POST",
            cookie,
            body: { email: "rbactest.invitee@araresources.com", role: "editor" },
          })
        ),
    },
    {
      label: "PATCH /api/admin/users/:id/role",
      call: (cookie, targetId) =>
        patchRole(
          req(`/api/admin/users/${targetId}/role`, {
            method: "PATCH",
            cookie,
            body: { role: "admin" },
          }),
          { params: Promise.resolve({ id: targetId }) }
        ),
    },
    {
      label: "PATCH /api/admin/users/:id/active",
      call: (cookie, targetId) =>
        patchActive(
          req(`/api/admin/users/${targetId}/active`, {
            method: "PATCH",
            cookie,
            body: { active: false },
          }),
          { params: Promise.resolve({ id: targetId }) }
        ),
    },
  ];

  for (const ep of endpoints) {
    await s.test(`${ep.label} — unauthenticated → 401`, async () => {
      const res = await ep.call(cookies.none, target.id);
      assertEq(res.status, 401, "status");
    });
    for (const role of ["viewer", "editor", "admin"] as Role[]) {
      await s.test(`${ep.label} — ${role} → 403`, async () => {
        const res = await ep.call(cookies[role], target.id);
        const body = await bodyOf(res);
        assertEq(res.status, 403, "status");
        assertEq(body.code, "INSUFFICIENT_ROLE", "code");
      });
    }
    await s.test(`${ep.label} — super_admin → 2xx`, async () => {
      // fresh target per call so PATCH ops don't collide
      const t =
        ep.label.includes(":id")
          ? await createUser(db, { role: "editor" })
          : target;
      const res = await ep.call(cookies.super_admin, t.id);
      assert(
        res.status >= 200 && res.status < 300,
        `expected 2xx, got ${res.status}: ${JSON.stringify(await bodyOf(res))}`
      );
    });
  }

  /* -------------------------- Req 7: self-guards ------------------------- */

  await s.test("super_admin CANNOT change their own role → 400 SELF_ROLE_CHANGE", async () => {
    const res = await patchRole(
      req(`/api/admin/users/${superAdmin.id}/role`, {
        method: "PATCH",
        cookie: cookies.super_admin,
        body: { role: "admin" },
      }),
      { params: Promise.resolve({ id: superAdmin.id }) }
    );
    const body = await bodyOf(res);
    assertEq(res.status, 400, "status");
    assertEq(body.code, "SELF_ROLE_CHANGE", "code");
    // and the DB role is untouched
    const rows = await db<{ role: string }[]>`SELECT role FROM users WHERE id = ${superAdmin.id}`;
    assertEq(rows[0]!.role, "super_admin", "role unchanged");
  });

  await s.test("super_admin CANNOT deactivate their own account → 400 SELF_DEACTIVATE", async () => {
    const res = await patchActive(
      req(`/api/admin/users/${superAdmin.id}/active`, {
        method: "PATCH",
        cookie: cookies.super_admin,
        body: { active: false },
      }),
      { params: Promise.resolve({ id: superAdmin.id }) }
    );
    const body = await bodyOf(res);
    assertEq(res.status, 400, "status");
    assertEq(body.code, "SELF_DEACTIVATE", "code");
    const rows = await db<{ active: boolean }[]>`SELECT active FROM users WHERE id = ${superAdmin.id}`;
    assertEq(rows[0]!.active, true, "still active");
  });

  await s.test("super_admin CAN deactivate a DIFFERENT user", async () => {
    const other = await createUser(db, { role: "editor" });
    const res = await patchActive(
      req(`/api/admin/users/${other.id}/active`, {
        method: "PATCH",
        cookie: cookies.super_admin,
        body: { active: false },
      }),
      { params: Promise.resolve({ id: other.id }) }
    );
    assertEq(res.status, 200, "status");
  });

  await s.test("role change to 'viewer' is rejected (signup-only)", async () => {
    const other = await createUser(db, { role: "editor" });
    const res = await patchRole(
      req(`/api/admin/users/${other.id}/role`, {
        method: "PATCH",
        cookie: cookies.super_admin,
        body: { role: "viewer" },
      }),
      { params: Promise.resolve({ id: other.id }) }
    );
    const body = await bodyOf(res);
    assertEq(res.status, 400, "status");
    assertEq(body.code, "ROLE_INVALID", "code");
  });

  return s;
}

const isMain =
  typeof process.argv[1] === "string" &&
  process.argv[1].replace(/\\/g, "/").endsWith("verify-rbac-user-management.ts");

if (isMain) {
  void (async () => {
    await loadEnv();
    const db = await openDb();
    await cleanup(db);
    const s = await suite(db);
    await cleanup(db);
    await closeDb();
    const failed = s.results.filter((r) => !r.ok);
    console.log(
      `\nuser-management: ${s.results.length - failed.length}/${s.results.length} passed`
    );
    process.exitCode = failed.length ? 1 : 0;
  })();
}
