# RBAC — Phase 3 (Signup lock, invites, bootstrap)

> Phase 1 = data layer. Phase 2 = login + access checks on Postgres, 4 roles.
> Phase 3 (this doc) = the two ways an account comes into existence.
> Phase 4 (NOT in this phase) = the "Manage Users" UI for issuing invites.

## Two isolated doors

| Door | Who | Role granted | Entry point |
|---|---|---|---|
| Public signup | anyone with an `@araresources.com` email | **always `viewer`** (hard-coded) | `POST /api/auth/signup` |
| Invite | issued by a `super_admin` | `editor` \| `admin` \| `super_admin` (stored on the invite) | `POST /api/admin/invites` → `/accept-invite?token=…` |

`viewer` is never invitable — that is signup's job. Elevated roles are never
reachable from signup — any `role` / `roleId` field in the signup body is
**rejected** with `400 ROLE_NOT_ALLOWED`.

The very first `super_admin` is still created out-of-band with
`scripts/create-admin.ts` (unchanged). Invites need an existing `super_admin` to
issue them, so the script remains the chicken-and-egg bootstrap.

## Endpoints

### `POST /api/admin/invites`  — create an invite (super_admin only)

Gate: `authorizeRequest(request)` → `requiredAccess("/api/admin/invites")` →
`super_admin` (via `SUPER_ADMIN_API_PREFIXES` in `access.ts`). `proxy.ts`
enforces the same minimum first. No bespoke check.

Request body:

```jsonc
{
  "email": "person@example.com",   // required, must look like an email
  "role": "admin",                  // required: "editor" | "admin" | "super_admin"
  "expiresInDays": 7                 // optional, default 7, max 30
}
```

`201` response:

```jsonc
{
  "ok": true,
  "invite": {
    "email": "person@example.com",
    "role": "admin",
    "token": "8f3c…43-char-base64url",
    "expiresAt": "2026-09-13T12:00:00.000Z",
    "acceptUrl": "https://<host>/accept-invite?token=8f3c…"
  }
}
```

Failure codes: `EMAIL_INVALID` (400), `ROLE_INVALID` (400 — includes trying to
invite a `viewer`), `USER_EXISTS` (409), `INSUFFICIENT_ROLE` (403),
`UNAUTHENTICATED` (401).

Creating an invite for an email that already has a live unused invite
**supersedes** it (the old token stops working).

### `GET /api/admin/invites`  — list recent invites (super_admin only)

Returns `{ ok, invites: [{ email, role, status, expiresAt, usedAt, createdAt,
acceptUrl }] }` where `status` is `pending` | `used` | `expired`.

### `GET /api/auth/accept-invite?token=…`  — validate a token (PUBLIC)

`200 { ok: true, email, role }` when the token is valid.
`4xx { ok: false, error, code }` otherwise:
`INVITE_INVALID` (404), `INVITE_USED` (410), `INVITE_EXPIRED` (410).

### `POST /api/auth/accept-invite`  — redeem a token (PUBLIC)

```jsonc
{ "token": "8f3c…", "password": "…", "confirmPassword": "…" }
```

Atomic (invite row locked `FOR UPDATE`): creates the `users` row with the role
**from the invite record**, scrypt-hashes the password, stamps `invites.used_at`,
and signs the new account in (session cookie, same as signup). A token redeems
**exactly once**.

`201 { ok: true, username, role }` + `Set-Cookie: ara_session=…`.
Failures: `VALIDATION` (400), `INVITE_INVALID` / `INVITE_USED` /
`INVITE_EXPIRED` (410), `USER_EXISTS` (409).

## Page

`/accept-invite` (public, top-level route — no dashboard chrome). Reads `?token`,
calls `GET /api/auth/accept-invite` to render the email read-only + the invited
role, then `password` + `confirm password` → `POST`. On success → `/home`.

## Files

New:
- `src/lib/auth/invites-db.ts` — `createInvite`, `findPendingInvite`,
  `acceptInvite` (transactional), `listRecentInvites`.
- `src/app/api/admin/invites/route.ts` — POST create + GET list.
- `src/app/api/auth/accept-invite/route.ts` — GET validate + POST redeem.
- `src/app/accept-invite/page.tsx` + `accept-invite-form.tsx` — minimal UI.
- Express mirror (dormant): `backend/src/auth/invites-db.ts`,
  `backend/src/routes/admin-invites.ts`, accept routes in
  `backend/src/routes/auth.ts`.

Modified:
- `src/app/api/auth/signup/route.ts` — reject any `role`/`roleId` body field.
- `src/lib/auth/access.ts` — `/accept-invite` + `/api/auth/accept-invite` public.
- `backend/src/routes/auth.ts`, `backend/src/auth/access.ts`,
  `backend/src/index.ts` — mirrors of the above.

Untouched (Phase 1): `scripts/create-admin.ts`, `scripts/migrate-users.ts`,
`db/migrations/006_users_and_invites.sql`.
