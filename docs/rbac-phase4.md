# RBAC — Phase 4 (Frontend + user management)

> Phase 2 = access checks on Postgres. Phase 3 = signup lock + invites.
> Phase 4 (this doc) = nav gating, the Manage Users UI, self-service account
> settings, and the endpoints behind them.

## New endpoints

| Method + path | Min role | Body | Response |
|---|---|---|---|
| `GET /api/admin/users` | **super_admin** | — | `{ ok, users: [{ id, email, role, active, displayName, avatarColor, lastLoginAt, createdAt, isSelf }] }` |
| `PATCH /api/admin/users/:id/role` | **super_admin** | `{ role: "editor"｜"admin"｜"super_admin" }` | `{ ok, user }` · 400 `ROLE_INVALID` (incl. `viewer`) / `SELF_ROLE_CHANGE` · 404 `USER_NOT_FOUND` |
| `PATCH /api/admin/users/:id/active` | **super_admin** | `{ active: boolean }` | `{ ok, user }` · 400 `SELF_DEACTIVATE` / `BAD_REQUEST` · 404 `USER_NOT_FOUND` |
| `POST /api/auth/change-password` | **viewer** (own account) | `{ currentPassword, newPassword, confirmPassword? }` | `{ ok, message }` + fresh `Set-Cookie` · 400 `CURRENT_PASSWORD_WRONG` / `SAME_PASSWORD` / `VALIDATION` |
| `POST /api/auth/profile` | **viewer** (own account) | `{ displayName?: string｜null, avatarColor?: string｜null }` | `{ ok, profile: { displayName, avatarColor } }` · 400 `AVATAR_COLOR_INVALID` / `DISPLAY_NAME_TOO_LONG` |

`GET /api/auth/me` now also returns `displayName` + `avatarColor`.

Every endpoint is gated by `authorizeRequest()` — the same DAL path as Phase 3.
`/api/admin/*` was already mapped to `super_admin` in `access.ts`
(`SUPER_ADMIN_API_PREFIXES`); `change-password` / `profile` were added as
`viewer` POST rules. `proxy.ts` enforces the same minimum first.

## Session invalidation on password change

`users.password_changed_at` (migration 008) is stamped on every successful
change. `src/lib/auth/session-freshness.ts` — checked in `proxy.ts` and the DAL —
rejects any token whose implied issued-at second is before that timestamp. The
changer keeps their session (the endpoint hands back a token minted *after* the
stamp); every other device is signed out on its next request (within the ~10s
auth-state cache). `NULL` = never changed → all tokens valid.

## Nav gating (UI convenience only)

`src/hooks/use-visible-nav-sections.ts` + `use-current-user.ts`:

| Section | Shown to |
|---|---|
| Home, Demands, Candidates | everyone |
| **Dataset** | editor, admin, super_admin |
| **Admin** | admin, super_admin |
| **Settings** | everyone (hosts universal account settings; the Companies card inside is admin-only) |

Real enforcement is `proxy.ts` + the DAL. Forcing `/dataset` or `/admin` in the
URL still 307s a viewer to `/home`; every `/api/admin/*` call still 403s.

## Manage Users UI

`/admin` renders `<ManageUsers />` **only for super_admin** (an admin sees a
generic card). It wraps the existing endpoints: users table (role `Select` +
Deactivate/Reactivate button, self-row locked), create-invite form (role picker
`editor｜admin｜super_admin`, shows the `acceptUrl` with a Copy button), and the
invites list (`GET /api/admin/invites`). No new "backend logic" — it calls
Phase 3/4 endpoints.

## Settings UI

`/settings` (now viewer-accessible): **Profile** (display name + initials-avatar
colour picker), **Change password**, plus the **Companies** card (admin+ only)
and Theme.

## Files

New: `src/lib/auth/{avatar,session-freshness,assignable-roles,users-admin-db}.ts`,
`src/app/api/admin/users/**`, `src/app/api/auth/{change-password,profile}/route.ts`,
`src/hooks/{use-current-user,use-visible-nav-sections}.ts`,
`src/components/admin/{manage-users,admin-workspace}.tsx`,
`src/components/navbar/user-avatar.tsx`,
`src/components/settings/{change-password-card,profile-card,settings-workspace}.tsx`,
`db/migrations/008_users_profile_and_password_epoch.sql`, plus Express mirrors
(`backend/src/auth/{session-freshness,users-admin-db}.ts`,
`backend/src/routes/admin-users.ts`).

Modified (explicitly required): `src/lib/auth/{access,dal,users-db}.ts`,
`src/proxy.ts`, `src/app/api/auth/me/route.ts`,
`src/app/(dashboard)/{admin,settings}/page.tsx`,
`src/components/sidebar/app-sidebar.tsx`,
`src/components/navbar/profile-menu.tsx`, `src/app/login/login-form.tsx`
(operator string), + backend mirrors.
