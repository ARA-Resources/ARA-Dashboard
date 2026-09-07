/**
 * Phase 5 — Req 4: role-based API access matrix.
 *
 * Three layers, all against the documented matrix (docs/rbac-phase2.md +
 * docs/rbac-phase4.md) as the source of truth:
 *   A. requiredAccess()  — the policy table itself
 *   B. authorizeRequest() — the DAL gate: correct allow/deny per role
 *   C. proxy()            — the universal middleware gate agrees with the DAL
 *
 * Run standalone:  npx tsx scripts/verify-rbac-access-matrix.ts
 */
import {
  Suite,
  assert,
  assertEq,
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

type Access = "public" | Role;

export async function suite(db: Db): Promise<Suite> {
  const s = new Suite("access-matrix");

  const { requiredAccess } = await import("../src/lib/auth/access");
  const { authorizeRequest } = await import("../src/lib/auth/dal");

  /* ---------------- A. policy table matches the docs ---------------- */

  const policy: Array<[string, string, Access]> = [
    // public
    ["/api/health", "GET", "public"],
    ["/api/auth/login", "GET", "public"],
    ["/api/auth/login", "POST", "public"],
    ["/api/auth/signup", "POST", "public"],
    ["/api/auth/accept-invite", "GET", "public"],
    ["/api/auth/accept-invite", "POST", "public"],
    ["/accept-invite", "GET", "public"],
    ["/api/dataset/gmail/oauth/callback", "GET", "public"],
    // viewer
    ["/api/auth/me", "GET", "viewer"],
    ["/api/auth/logout", "POST", "viewer"],
    ["/api/auth/change-password", "POST", "viewer"],
    ["/api/auth/profile", "POST", "viewer"],
    ["/api/dataset/notifications", "GET", "viewer"],
    ["/api/dataset/notifications", "POST", "viewer"],
    ["/api/home/widgets", "GET", "viewer"],
    ["/api/excel/lateral-master-sheet", "GET", "viewer"],
    ["/api/excel/executive-p-dashboard", "GET", "viewer"],
    ["/api/dataset/lateral/p-roles", "GET", "viewer"],
    // editor
    ["/api/dataset/configuration", "GET", "editor"],
    ["/api/dataset/configuration", "POST", "editor"],
    ["/api/dataset/ops", "POST", "editor"],
    ["/api/dataset/gmail/sync", "POST", "editor"],
    ["/api/dataset/gmail/messages", "GET", "editor"],
    ["/api/dataset/lateral/scheduler", "GET", "editor"],
    ["/api/cron/lateral", "POST", "editor"],
    // super_admin
    ["/api/admin/users", "GET", "super_admin"],
    ["/api/admin/users/abc-123/role", "PATCH", "super_admin"],
    ["/api/admin/users/abc-123/active", "PATCH", "super_admin"],
    ["/api/admin/invites", "POST", "super_admin"],
    ["/api/admin/invites", "GET", "super_admin"],
    // pages
    ["/", "GET", "viewer"],
    ["/home", "GET", "viewer"],
    ["/company/accenture", "GET", "viewer"],
    ["/candidate/dashboard", "GET", "viewer"],
    ["/dataset/lateral", "GET", "editor"],
    ["/admin", "GET", "admin"],
    ["/settings", "GET", "viewer"],
  ];

  for (const [pathname, method, expected] of policy) {
    await s.test(`requiredAccess ${method} ${pathname} → ${expected}`, async () => {
      assertEq(requiredAccess(pathname, method), expected, "policy");
    });
  }

  /* ------------- B. authorizeRequest enforces the policy ------------- */

  const users: Record<Role, Fixture> = {
    viewer: await createUser(db, { role: "viewer" }),
    editor: await createUser(db, { role: "editor" }),
    admin: await createUser(db, { role: "admin" }),
    super_admin: await createUser(db, { role: "super_admin" }),
  };
  const ck: Record<Role, string> = {
    viewer: await cookieFor(users.viewer),
    editor: await cookieFor(users.editor),
    admin: await cookieFor(users.admin),
    super_admin: await cookieFor(users.super_admin),
  };
  const ROLES: Role[] = ["viewer", "editor", "admin", "super_admin"];

  // representative route per tier → which roles should be allowed
  const cases: Array<{
    label: string;
    pathname: string;
    method: string;
    allowed: Role[];
  }> = [
    { label: "viewer API (GET /api/auth/me)", pathname: "/api/auth/me", method: "GET", allowed: ROLES },
    {
      label: "editor API (GET /api/dataset/configuration)",
      pathname: "/api/dataset/configuration",
      method: "GET",
      allowed: ["editor", "admin", "super_admin"],
    },
    {
      label: "admin page (GET /admin)",
      pathname: "/admin",
      method: "GET",
      allowed: ["admin", "super_admin"],
    },
    {
      label: "super_admin API (GET /api/admin/users)",
      pathname: "/api/admin/users",
      method: "GET",
      allowed: ["super_admin"],
    },
  ];

  for (const c of cases) {
    for (const role of ROLES) {
      const shouldAllow = c.allowed.includes(role);
      await s.test(`${c.label} — ${role} → ${shouldAllow ? "allow" : "deny"}`, async () => {
        const gate = await authorizeRequest(
          req(c.pathname, { method: c.method, cookie: ck[role] })
        );
        if (shouldAllow) {
          assert(gate.ok, `expected allow, got ${!gate.ok && gate.failure.reason}`);
        } else {
          assert(!gate.ok, "expected deny");
          assertEq(gate.failure.reason, "insufficient_role", "reason");
        }
      });
    }
    await s.test(`${c.label} — unauthenticated → deny (401)`, async () => {
      const gate = await authorizeRequest(req(c.pathname, { method: c.method }));
      assert(!gate.ok, "expected deny");
      assertEq(gate.failure.status, 401, "status");
    });
  }

  await s.test("public route (POST /api/auth/login) — unauthenticated → allow", async () => {
    const gate = await authorizeRequest(req("/api/auth/login", { method: "POST" }));
    assert(gate.ok, "public should be allowed with no session");
  });

  /* ----------------- C. proxy() agrees with the DAL ---------------- */

  const { proxy } = await import("../src/proxy");
  const { NextRequest } = await import("next/server");

  function nreq(pathname: string, method: string, cookie?: string) {
    const headers = new Headers();
    if (cookie) headers.set("cookie", cookie);
    return new NextRequest(`http://localhost${pathname}`, { method, headers });
  }

  await s.test("proxy: viewer → /api/dataset/configuration → 403", async () => {
    const res = await proxy(nreq("/api/dataset/configuration", "GET", ck.viewer));
    assertEq(res.status, 403, "status");
  });
  await s.test("proxy: editor → /api/dataset/configuration → passes through", async () => {
    const res = await proxy(nreq("/api/dataset/configuration", "GET", ck.editor));
    assert(res.status === 200 && !res.headers.get("location"), `expected next(), got ${res.status}`);
  });
  await s.test("proxy: viewer → /admin (page) → redirect to /home", async () => {
    const res = await proxy(nreq("/admin", "GET", ck.viewer));
    assertEq(res.status, 307, "status");
    assert((res.headers.get("location") ?? "").endsWith("/home"), "location");
  });
  await s.test("proxy: unauthenticated → /api/admin/users → 401", async () => {
    const res = await proxy(nreq("/api/admin/users", "GET"));
    assertEq(res.status, 401, "status");
  });
  await s.test("proxy: unauthenticated → /api/health (public) → passes through", async () => {
    const res = await proxy(nreq("/api/health", "GET"));
    assert(res.status === 200 && !res.headers.get("location"), `expected next(), got ${res.status}`);
  });

  return s;
}

const isMain =
  typeof process.argv[1] === "string" &&
  process.argv[1].replace(/\\/g, "/").endsWith("verify-rbac-access-matrix.ts");

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
      `\naccess-matrix: ${s.results.length - failed.length}/${s.results.length} passed`
    );
    process.exitCode = failed.length ? 1 : 0;
  })();
}
