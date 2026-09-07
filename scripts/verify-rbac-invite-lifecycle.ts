/**
 * Phase 5 — Req 3: invite token lifecycle.
 *   - valid unused unexpired token redeems exactly once
 *   - second redemption fails cleanly (no dup account, no crash)
 *   - expired token rejected
 *   - created account role always == the invite record's role, never client input
 *
 * Run standalone:  npx tsx scripts/verify-rbac-invite-lifecycle.ts
 */
import {
  Suite,
  assert,
  assertEq,
  bodyOf,
  cleanup,
  closeDb,
  cookieFor,
  countUsers,
  createUser,
  getUserRow,
  loadEnv,
  openDb,
  req,
  TEST_PASSWORD,
  type Db,
} from "./verify-rbac-harness";

export async function suite(db: Db): Promise<Suite> {
  const s = new Suite("invite-lifecycle");

  const { POST: createInviteRoute } = await import(
    "../src/app/api/admin/invites/route"
  );
  const { GET: validateInvite, POST: acceptInvite } = await import(
    "../src/app/api/auth/accept-invite/route"
  );

  const superAdmin = await createUser(db, { role: "super_admin" });
  const saCookie = await cookieFor(superAdmin);

  async function newInvite(role: string, email?: string): Promise<{ email: string; token: string }> {
    const target = (email ?? `rbactest.inv.${Math.random().toString(36).slice(2, 8)}@araresources.com`).toLowerCase();
    const res = await createInviteRoute(
      req("/api/admin/invites", {
        method: "POST",
        cookie: saCookie,
        body: { email: target, role },
      })
    );
    const body = await bodyOf(res);
    assertEq(res.status, 201, `create invite (${role}): ${JSON.stringify(body)}`);
    const invite = body.invite as { email: string; token: string; role: string };
    assertEq(invite.role, role, "invite record role");
    return { email: invite.email, token: invite.token };
  }

  await s.test("valid token: GET validate returns email + role", async () => {
    const inv = await newInvite("editor");
    const res = await validateInvite(
      req(`/api/auth/accept-invite?token=${encodeURIComponent(inv.token)}`)
    );
    const body = await bodyOf(res);
    assertEq(res.status, 200, "status");
    assertEq(body.ok, true, "ok");
    assertEq(body.email, inv.email, "email");
    assertEq(body.role, "editor", "role");
  });

  await s.test("valid token redeems exactly once; account gets the invite role", async () => {
    const inv = await newInvite("admin");
    const first = await acceptInvite(
      req("/api/auth/accept-invite", {
        method: "POST",
        body: { token: inv.token, password: TEST_PASSWORD, confirmPassword: TEST_PASSWORD },
      })
    );
    const firstBody = await bodyOf(first);
    assertEq(first.status, 201, `first redeem: ${JSON.stringify(firstBody)}`);
    assertEq(firstBody.role, "admin", "response role");

    const row = await getUserRow(db, inv.email);
    assert(row, "user created");
    assertEq(row!.role, "admin", "DB role == invite role");
    assertEq(await countUsers(db, inv.email), 1, "exactly one account");

    // second attempt with the same token
    const second = await acceptInvite(
      req("/api/auth/accept-invite", {
        method: "POST",
        body: { token: inv.token, password: "OtherPass456!", confirmPassword: "OtherPass456!" },
      })
    );
    const secondBody = await bodyOf(second);
    assertEq(second.status, 410, `second redeem status: ${JSON.stringify(secondBody)}`);
    assertEq(secondBody.code, "INVITE_USED", "code");
    assertEq(await countUsers(db, inv.email), 1, "still exactly one account (no dup)");
  });

  await s.test("expired token is rejected (GET validate + POST redeem)", async () => {
    const inv = await newInvite("editor");
    await db`UPDATE invites SET expires_at = NOW() - INTERVAL '1 day' WHERE token = ${inv.token}`;

    const get = await validateInvite(
      req(`/api/auth/accept-invite?token=${encodeURIComponent(inv.token)}`)
    );
    assertEq(get.status, 410, "GET status");
    assertEq((await bodyOf(get)).code, "INVITE_EXPIRED", "GET code");

    const post = await acceptInvite(
      req("/api/auth/accept-invite", {
        method: "POST",
        body: { token: inv.token, password: TEST_PASSWORD, confirmPassword: TEST_PASSWORD },
      })
    );
    assertEq(post.status, 410, "POST status");
    assertEq((await bodyOf(post)).code, "INVITE_EXPIRED", "POST code");
    assertEq(await countUsers(db, inv.email), 0, "no account created from expired invite");
  });

  await s.test("invalid / unknown token is rejected cleanly", async () => {
    const res = await acceptInvite(
      req("/api/auth/accept-invite", {
        method: "POST",
        body: { token: "not-a-real-token-xxxxxxxx", password: TEST_PASSWORD },
      })
    );
    assertEq(res.status, 404, "status");
    assertEq((await bodyOf(res)).code, "INVITE_INVALID", "code");
  });

  for (const role of ["editor", "admin", "super_admin"] as const) {
    await s.test(`redeemed account role == invite role (${role}), ignoring client 'role' in body`, async () => {
      const inv = await newInvite(role);
      const res = await acceptInvite(
        req("/api/auth/accept-invite", {
          method: "POST",
          body: {
            token: inv.token,
            password: TEST_PASSWORD,
            confirmPassword: TEST_PASSWORD,
            // hostile client input — must be ignored
            role: "super_admin",
            roleId: "x",
          },
        })
      );
      assertEq(res.status, 201, `redeem ${role}: ${JSON.stringify(await bodyOf(res))}`);
      const row = await getUserRow(db, inv.email);
      assert(row, "user created");
      assertEq(row!.role, role, `DB role must be '${role}', not the body's 'super_admin'`);
    });
  }

  return s;
}

const isMain =
  typeof process.argv[1] === "string" &&
  process.argv[1].replace(/\\/g, "/").endsWith("verify-rbac-invite-lifecycle.ts");

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
      `\ninvite-lifecycle: ${s.results.length - failed.length}/${s.results.length} passed`
    );
    process.exitCode = failed.length ? 1 : 0;
  })();
}
