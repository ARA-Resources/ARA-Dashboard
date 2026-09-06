# ARA Dashboard — Project Context

> Internal recruitment-pipeline dashboard for ARA Resources, tracking Accenture
> hiring (Lateral, Executive, Consulting). Production runs on a VPS in a single
> Docker container. This document reflects the **`prod`** branch and supersedes
> the older, partly-stale `README.md` and `Documentation.md`.
>
> Last verified: 2026-09.

---

## 1. What actually runs in production

**One Docker container** (`docker-compose.yml` → service `ara-dashboard`,
container name `ara-dashboard-prod`) that bundles:

1. **PostgreSQL** — installed into the image (`Dockerfile`), data on the
   `ara_pgdata` volume at `/var/lib/postgresql/data`. Inside the container:
   `127.0.0.1:5432`, database `ara_db`, user `ara_user` / `ara_password`
   (granted `SUPERUSER` by `docker-entrypoint.sh`).
2. **Next.js 16** (`next start`) on port **3000** — serves the UI **and** all
   `/api/*` route handlers. This is the entire backend in production.

`docker-entrypoint.sh` initialises Postgres if empty, creates the DB/user, runs
`node scripts/db-migrate.mjs`, then `npm start`.

### Not running in production

- **`backend/`** — a separate Express app (its own `package.json`, uses `pg`,
  `express@5`). A half-finished Next.js→Express migration (Stages 7–30). The
  `Dockerfile` never copies or runs it. It only takes traffic if
  `ARA_NODE_BACKEND_URL` is set (see `next.config.ts` rewrites) — **it is not set
  in prod**.
- **`worker/`** — a standalone `node-cron` process. Only used if
  `ARA_SCHEDULER_OWNER=worker`; prod uses the default (`next`), so the Lateral
  cron is armed inside the Next.js process via `src/instrumentation.node.ts`.

Treat `backend/` and `worker/` as dormant. Do not assume changes there affect
production.

---

## 2. Tech stack (root `package.json`)

| Layer | Library |
|-------|---------|
| Framework | Next.js `16.3.0` (App Router), React `19.2.8`, TypeScript |
| UI | Tailwind CSS v4, shadcn/ui (`@base-ui/react`), `lucide-react` |
| Client state / data | Zustand, `@tanstack/react-query`, `@tanstack/react-table` |
| DB driver | `postgres` (postgres.js) — raw tagged-template SQL, **no ORM** |
| Excel | `exceljs` (JS) + Python `openpyxl` (`py3-openpyxl` in the image) |
| Google | `googleapis` (Gmail + Drive; Sheets in legacy P-Roles paths) |
| Scheduler | `node-cron` |
| PDF | `jspdf` (JD download) |

Present but effectively unused in `src/` (migration audit): `recharts`,
`react-hook-form`. `framer-motion` is used (Home/nav). `shadcn` is a CLI listed
as a runtime dep.

---

## 3. Data model & source of truth

Two data planes, easy to confuse:

### Postgres plane (dashboard reads)

- `lateral_master` (PK `job_requisition_id`) — **the source of truth for the
  Lateral Master Sheet and Home KPIs.** `job_status` ∈ `New|Reopen|Active|Closed`
  (CHECK), `posted` ∈ `Yes|-` (CHECK).
- `lateral_staging` — current-run ATCI DS rows, truncated/replaced per import.
- `home_metrics` — cached per-BU KPI snapshot.
- `app_config` — AES-256-GCM encrypted blobs (Gmail/Drive OAuth tokens, dataset
  setup, lateral processing setup, drive metadata). Encryption key =
  SHA-256 of `ARA_DATASET_SETUP_SECRET`.
- `gmail_checkpoint`, `lateral_scheduler_state`, `lateral_sync_history`,
  `lateral_source_drive_state`, `oauth_state`, `app_notifications`,
  `sender_stats`, `dataset_*`, etc.

Env: `ARA_PERSISTENCE=postgres`, `ARA_LATERAL_MASTER_SOURCE=postgres` (both set in
prod). `ARA_PERSISTENCE=file` is the legacy `.data/` mode — still supported in
code, not used in prod.

### Drive / Excel plane (Run All pipeline)

The Master **XLSM on Google Drive** (`ARA_LATERAL_MASTER_DRIVE_FILE_ID`) is still
mutated by Run All: New Sheet fill, Posted Sheet A/B/C, and the **P-Roles
PivotTable refresh (step 19, openpyxl)**. Excel columns K (Job Status) and M
(Posted) are written as **secondary compatibility** — Postgres is authoritative.

The on-disk `data/excel/ATCI Lateral Master Data Updated.xlsx` is an **import
source only** (`npm run db:import-lateral-master-xlsx`); it is not auto-updated.

### Migrations

`db/migrations/001` … `005` (**five**, not three):
- 001 initial schema · 002 `oauth_state` · 003 `lateral_master` + `lateral_staging`
- 004 adds `lateral_master.opened_on_oorwin`
- 005 adds `lateral_scheduler_state.last_run_summary` (Master Sheet last-run banner)

Runner: `node scripts/db-migrate.mjs` (tracks `schema_migrations`; idempotent).

---

## 4. Authentication

- **Dashboard session:** HMAC-SHA256 cookie `ara_session`, 12h TTL, roles
  `viewer` | `operator` (`src/lib/auth/session.ts`). Not JWT, not NextAuth.
- **Gate:** `src/middleware.ts` + `src/lib/auth/access.ts`. API GET = any session;
  API write = operator; a few Gmail GET paths = operator.
- **Login:** named accounts in `.data/dashboard-users.json` (scrypt), **or** the
  shared `ARA_DASHBOARD_PASSWORD`.
- **Role:** `ARA_OPERATOR_ALLOWLIST` — **set in prod to one account**
  (`sahil.rodge@araresources.com`). Everyone else is a `viewer`. (If the
  allowlist were empty, every login would be operator.)
- **Sign-up:** `POST /api/auth/signup` is a public route, but `createUser()`
  restricts new accounts to an **`@araresources.com` email address**
  (configurable via `ARA_SIGNUP_EMAIL_DOMAINS`, default `araresources.com`).
- **Google OAuth** (Gmail + Drive) is separate from the dashboard session;
  callback path `/api/dataset/gmail/oauth/callback` (public, state-token
  validated).

---

## 5. Lateral Run All (the core workflow)

Entry: Dataset → Lateral → **Run All** → `POST /api/dataset/lateral/scheduler`
`{action:"run_now"}` → `invokeLateralJob("manual")` → `executeLateralDatasetJob`
(`src/services/lateral-processing/lateral-job.ts`). The daily cron uses the same
path with trigger `scheduler`.

1. **Gmail incremental sync** — search `mis@araresources.com` for keyword matches
   (Adhoc DS / ATCI Lateral / Lateral), download the `.xlsx` attachment, upload
   it to the configured Drive source folder. Gated by `gmail_checkpoint`
   (advances **only** on full success).
2. **25-step pipeline** (`src/services/lateral-processing/pipeline.ts`) if a new
   source file was found: discover Master XLSM → refresh New Sheet → JR
   comparison → reconcile status → **write `lateral_master.job_status` in
   Postgres** (Column K secondary) → **Posted A/B/C → `lateral_master.posted` in
   Postgres** (Column M secondary) → **P-Roles pivot refresh (XLSM/openpyxl)** →
   save + upload Master XLSM in place (never creates a second Master) → update
   Dataset Manager copy → refresh `home_metrics`.
3. On **any** hard failure: stop, do not advance the checkpoint, preserve the last
   good Master, push a notification, allow retry. Never reports success on
   failure.

Concurrency guard: in-process `running` flag + Postgres `pg_advisory_lock`
(`acquireLateralJobLock`).

Setup (`app_config` key `lateral_processing_setup`) must be saved via the wizard
(Dataset → Lateral → Configure Dataset) or the pipeline fails at step 1.

---

## 6. Navigation / business units

Sidebar (`src/constants/navigation.ts`): **Home · Demands · Candidates · Dataset ·
Admin · Settings · Logout**. "Demands" was formerly "Company"; "Candidates" was
"Candidate".

Companies (`src/constants/companies.ts`): **Accenture** (enabled — Dashboard,
Lateral [Master Sheet + Allocations], Executive [Master Sheet], Consulting) and
**Infosys** (enabled, no modules yet).

Maturity: **Lateral** = production-complete. **Executive** = partial
(ingestion services exist, dashboard still Drive/XLSM). **Consulting** = stub.
`/admin`, `/settings` = stubs. `/overview`, `/lateral`, `/executive`,
`/consulting`, `/dataset/configuration` = legacy redirects.

---

## 7. Key files

| Purpose | Path |
|---------|------|
| Middleware / auth gate | `src/middleware.ts`, `src/lib/auth/access.ts`, `src/lib/auth/session.ts` |
| User store + signup rules | `src/lib/auth/users-store.ts` |
| Cron bootstrap (Next.js) | `src/instrumentation.node.ts` |
| Lateral scheduler | `src/services/lateral-processing/lateral-scheduler.ts` |
| Lateral job orchestrator | `src/services/lateral-processing/lateral-job.ts` |
| 25-step pipeline | `src/services/lateral-processing/pipeline.ts` |
| Postgres Master read layer | `src/services/persistence/read-lateral-master.ts` |
| Master Sheet API | `src/app/api/excel/lateral-master-sheet/route.ts` |
| Run All / scheduler API | `src/app/api/dataset/lateral/scheduler/route.ts` |
| DB client | `src/lib/persistence/db-client.ts` |
| Persistence mode / stores | `src/lib/persistence/*` |
| Migration runner | `scripts/db-migrate.mjs` |
| Prod config check | `src/lib/config/runtime.ts` |

---

## 8. Environment (`.env`, gitignored; template in `.env.example`)

Required in prod (`PRODUCTION_REQUIRED_ENV` in `src/lib/config/runtime.ts`):
`ARA_SESSION_SECRET`, `ARA_DASHBOARD_PASSWORD`, `ARA_DATASET_SETUP_SECRET`,
`ARA_APP_URL`, `ARA_LATERAL_MASTER_DRIVE_FILE_ID`, `GOOGLE_CLIENT_ID`,
`GOOGLE_CLIENT_SECRET`.

Also in prod: `ARA_PERSISTENCE=postgres`, `ARA_LATERAL_MASTER_SOURCE=postgres`,
`POSTGRES_URL=postgresql://ara_user:ara_password@127.0.0.1:5432/ara_db`,
`ARA_OPERATOR_ALLOWLIST`, `GMAIL_ACCOUNT` / `ARA_GMAIL_ADDRESS`,
`GOOGLE_GMAIL_REDIRECT_URI`, `CRON_SECRET`, `ARA_DATASET_SCHEDULER`.

Optional: `ARA_SIGNUP_EMAIL_DOMAINS`, `ARA_SCHEDULER_OWNER`, `ARA_P_ROLES_PIPELINE`,
`ARA_P_ROLES_ENGINE`, `ARA_PG_POOL_MAX`, `ARA_NODE_BACKEND_URL` (activates the
`backend/` proxy — leave unset).

**Do not commit `.env`.** It is `chmod 600` on the host. `.env.example` holds
names/placeholders only.

---

## 9. Common commands (VPS, repo root)

```bash
docker compose up -d --build         # rebuild + restart after code changes
docker compose logs -f
docker exec -it ara-dashboard-prod sh -c 'node scripts/db-migrate.mjs'
docker exec -it ara-dashboard-prod sh -c \
  'npx tsx scripts/import-lateral-master-from-xlsx.ts --replace'   # reload Master from xlsx
```

DB spot checks:
```sql
SELECT job_status, COUNT(*) FROM lateral_master GROUP BY 1;
SELECT posted, COUNT(*) FROM lateral_master GROUP BY 1;
SELECT last_run_status, last_run_summary FROM lateral_scheduler_state;
```

---

## 10. Known cleanup backlog (not blocking)

- Committed secret file `Untitled` at repo root (rotate secrets + remove — owner
  is handling separately).
- `README.md` / `Documentation.md` stale (this file is the accurate reference).
- `backend/` + `worker/` dormant — resume the migration deliberately or delete.
- Unused deps: `recharts`, `react-hook-form`.
- P-Roles logic exists in several forms (XLSM pivot, Google Sheets pivot, native
  Postgres engine behind `ARA_P_ROLES_ENGINE`); prod path is still the XLSM pivot.
- ~113 one-off scripts in `scripts/` — mostly historical phase/verify tooling.
