# RBAC — Phase 2 (Access control on Postgres + 4 roles)

> Phase 1 = data layer (users/invites tables, migration + bootstrap scripts).
> Phase 2 (this doc) = login + every access check now run on Postgres and
> understand `viewer < editor < admin < super_admin`. Phases 3–4 (invite system,
> signup hardening, UI gating) are NOT in this phase.

## Role model

| Role | Gets |
|------|------|
| `viewer` | Home, Demands, Candidates (read-only dashboard data) |
| `editor` | viewer **+ full Dataset** (Gmail OAuth, sync, config, Run All) |
| `admin` | editor **+ Admin & Settings** sections + all features — **no user management** |
| `super_admin` | admin **+ user management** (invite / change role / deactivate) — Phase 3 |

`operator` is gone. Source of truth for a user's role is `users.role` in Postgres,
re-read on every request (10s cache) — not the login-time token.

## Enforcement architecture (Next.js 16)

- **`src/proxy.ts`** (was `src/middleware.ts`; renamed per the Next 16 deprecation).
  Runs on the Node.js runtime. Verifies the session cookie, re-reads
  `role` + `active` from Postgres (10s cache via `getLiveAuthState`), and enforces
  the matrix below on **every** route (pages + `/api/*`). Rejects deactivated
  accounts and clears their cookie.
- **`src/lib/auth/dal.ts`** — `authorizeRequest(request)` / `verifySession()` /
  `requireRole()`. The Data-Access-Layer check Next 16 recommends running close to
  the data. Wired into the highest-risk mutation routes now
  (`lateral-processing/pipeline`, `lateral-processing/execute`, `lateral/scheduler`,
  `dataset/ops`) and `auth/me`. **Remaining `/api/*` routes rely on proxy** and
  should adopt the same 2-line guard as a mechanical follow-up.
- **`src/lib/auth/access.ts`** — `requiredAccess(path, method)` → minimum role.
- **`src/lib/auth/roles.ts`** — role list, rank, `roleMeets()`.
- **`src/lib/auth/users-db.ts`** — Postgres user auth queries + the 10s cache.

Express layer (`backend/`, dormant / not deployed) mirrors all of the above.

## API / route access matrix

`viewer` = any authenticated, active user. Higher roles inherit everything below.

| Method + path | Min role |
|---|---|
| `GET/POST /api/auth/login` | public |
| `POST /api/auth/signup` | public (creates `viewer` only) |
| `GET /api/health` | public |
| `GET /api/dataset/gmail/oauth/callback` | public (state-token validated in handler) |
| `POST /api/cron/lateral` | valid `CRON_SECRET` bearer **or** `editor` session (handler still requires the secret) |
| `POST /api/auth/logout` | viewer |
| `GET /api/auth/me` | viewer |
| `GET/POST /api/dataset/notifications` | viewer (shared navbar bell) |
| `GET /api/home/widgets` | viewer |
| `GET /api/excel/**` (all: business-unit data, filters, skills, master sheets, exports, p-dashboard) | viewer |
| `GET /api/dataset/lateral/p-roles` | viewer (Demands → Lateral openings feed) |
| `GET/POST /api/dataset/configuration` | editor |
| `GET/DELETE /api/dataset/connections` | editor |
| `GET /api/dataset/current` | editor |
| `GET /api/dataset/drive/{browse,folders,metadata,quota}` | editor |
| `GET/POST /api/dataset/executive` | editor |
| `GET/POST/DELETE /api/dataset/gmail/{messages,status,sync}` | editor |
| `GET /api/dataset/gmail/oauth/start` | editor |
| `* /api/dataset/lateral-processing/**` (setup, pipeline, execute, preview, workbooks, worksheets, reconcile/confirm, reconcile/cancel) | editor |
| `GET/POST /api/dataset/lateral/scheduler` | editor |
| `GET /api/dataset/lateral/sync-history` | editor |
| `GET/POST /api/dataset/ops` | editor |
| `GET/POST /api/dataset/scheduler` | editor |
| `GET /api/dataset/sender-stats` | editor |
| `GET/POST/DELETE /api/dataset/setup` | editor |
| `GET /api/dataset/sync-history` + `/[id]/log` | editor |
| any other `GET /api/*` | viewer |
| any other non-GET `/api/*` | editor |
| **`* /api/admin/users/**`** *(Phase 3 — not built yet)* | **super_admin** |
| **`* /api/admin/invites/**`** *(Phase 3 — not built yet)* | **super_admin** |

### Page routes

| Path | Min role |
|---|---|
| `/login`, `/logout` | public |
| `/`, `/home` | viewer |
| `/company/**` (Demands), `/candidate/**` | viewer |
| `/overview`, `/lateral`, `/executive`, `/consulting` (legacy redirects) | viewer |
| `/dataset/**` | editor |
| `/admin/**`, `/settings/**` | admin |

## Behaviour changes

- **Login is Postgres-only.** The shared `ARA_DASHBOARD_PASSWORD` login path is
  removed. Only rows in `users` (active) can authenticate. Run
  `scripts/migrate-users.ts` before deploy if not already done.
- **All existing sessions are invalidated on deploy** (token format changed:
  now carries `uid` + a 4-role value). Everyone logs in again.
- **Deactivation / role change takes effect within ~10s**, no logout needed.
- `ARA_OPERATOR_ALLOWLIST` is no longer read for roles (only `migrate-users.ts`
  still references it). `ARA_DASHBOARD_PASSWORD` only gates the "auth configured"
  flag now.
- Requires `ARA_PERSISTENCE=postgres` + `POSTGRES_URL` (prod already has both).
