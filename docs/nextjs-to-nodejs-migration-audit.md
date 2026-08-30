# ARA Dashboard — Next.js → Node.js + Vite/React Migration Audit

**Status:** READ-ONLY investigation. No application code, Docker, env, git, or database was changed by this audit (this file is the audit deliverable only).

**Audited at:** 2026-08-30  
**Branch:** `node-test` @ `a35563e` (same commit as `phase9-unified`)  
**Repo:** `d:\ARA Resources\Dashboard New\ara-dashboard`

---

## 1. Executive Summary

ARA Dashboard is a **Next.js 16 App Router** app that is **already mostly a React SPA plus a Node REST API**, not a typical SSR product site.

- **Frontend:** ~101 `"use client"` files. Almost no Server Components do real data fetching. Pages are thin shells (redirects, metadata, or `<ClientPage />`). **Zero Server Actions.**
- **Backend:** 47 Route Handlers under `/api/*`. Business logic lives in `src/services/` (not in pages).
- **Database:** PostgreSQL via `postgres` (postgres.js), dual mode `ARA_PERSISTENCE=file|postgres`. Schema is 3 SQL migrations; **no ORM**. This layer **can be reused almost unchanged**.
- **Hard part is not Next.js.** Hard part is **Lateral Excel pipelines** (25-step workbook processing, Gmail, Drive, Python/OpenPyXL, Windows COM) plus **duplicate P-Roles/Excel reader variants** and **~112 scripts**.

**Verdict:** Vite + Express is a **good fit**. Next.js is adding cost (Turbopack tracing, `instrumentation.ts`, middleware Edge constraints, Vercel leftovers) without buying much (no SSG/ISR, almost no RSC data, no Server Actions).

**Do not blindly convert.** Separate:

| Keep as-is (move files) | Rewrite thin wrappers | Delete later |
|-------------------------|----------------------|--------------|
| Services, SQL, auth HMAC, pipelines | `route.ts` → Express, `middleware.ts` → Express, pages → React Router | Unused deps, Vercel-safe duplicates, most `scripts/step*`, Google Sheets P-Roles experiment |

**Estimated source reduction after cleanup (not including `node_modules` / `.next`):** 30–50% of `scripts/` + several large P-Roles/Excel duplicate modules. App `src/` itself is only **~2.4 MB**; the “too large” feeling is **complexity and duplication**, not frontend size.

---

## 2. Current Architecture

```
Browser (React client components)
    │  fetch('/api/...')
    ▼
Next.js middleware  (HMAC cookie ara_session, viewer/operator)
    ▼
Route Handlers src/app/api/**/route.ts
    ▼
src/services/*  (pipelines, Excel, Gmail, Drive, P-Roles, home widgets)
    ▼
┌─────────────────┬──────────────────────────────┐
│ File mode       │ Postgres mode                │
│ .data/*.json    │ postgres.js → Neon or        │
│ .data/*.enc.json│ embedded Docker PostgreSQL   │
└─────────────────┴──────────────────────────────┘
    ▲
Gmail / Google Drive / local XLSM / Python OpenPyXL
```

**Two data planes (intentional, easy to confuse):**

1. **Excel/Drive plane (Run All):** Gmail → Drive → 25-step XLSM pipeline → upload Master. Dashboard Master Sheet / allocations still read Excel/Drive for some views.
2. **PostgreSQL plane (Phase 8):** `lateral_master` / `lateral_staging` / `home_metrics` → P-Roles API, Lateral filters, Home KPIs.

**Schedulers:** Next.js `instrumentation.node.ts` starts `node-cron` on Node boot (Lateral scheduler live; legacy dataset scheduler boots but crons disarmed).

---

## 3. Complete Project Inventory

### Totals (entire working tree, including generated)

| Metric | Value |
|--------|--------|
| Files | ~58,532 |
| Directories | ~5,783 |
| Disk size | **~5.6 GB** |

### Size by top-level directory

| Path | Size | Notes |
|------|------|--------|
| `.next/` | **4,673 MB** | Generated. Disposable. Do not migrate. |
| `node_modules/` | **836 MB** | Disposable. Do not migrate. |
| `.data/` | **108 MB** | Runtime state (gitignored). Secrets/checkpoints. |
| `data/` | **18 MB** | Local Excel (gitignored workbooks). |
| `.git/` | 2.9 MB | |
| `src/` | **2.4 MB** | Real application source |
| `scripts/` | **1 MB** | ~112 verification/migration scripts |
| `.tmp-phase11/` | 0.1 MB | Scratch (gitignored pattern `.tmp*`) |

**Real project (src + scripts + db + docs + config):** ~**556 files, 3.4 MB**.

### Source file counts (src, scripts, db, docs, public)

| Extension | Count |
|-----------|------:|
| `.ts` | 397 |
| `.tsx` | 126 |
| `.py` | 11 |
| `.md` | 5 |
| `.sql` | 3 |
| other (css, svg, ico, jpg, mjs, json) | ~11 |

### Source-code directories

| Path | Role |
|------|------|
| `src/app/` | Next.js App Router (pages + 47 API routes) |
| `src/components/` | UI (~106 files) |
| `src/services/` | **Core business logic** |
| `src/lib/` | Auth, persistence, config |
| `src/hooks/`, `src/stores/`, `src/providers/` | Client state |
| `src/constants/`, `src/types/`, `src/utils/` | Shared |
| `scripts/` | Migrations, verify, one-off repairs |
| `db/migrations/` | SQL 001–003 |
| `docs/` | Phase 11–13 notes |
| `public/` | Static assets / logo |

### Generated / disposable (do not delete in this audit; do not migrate)

- `.next/`
- `node_modules/`
- `.data/` (runtime; recreate on deploy)
- `coverage/` (none present)
- `*.tsbuildinfo`
- `.tmp*` / `.tmp-phase11`
- `__pycache__` / `.pyc` under scripts
- logs (`*.log`)

### Config / Docker / DB / Excel / Auth / API

- **Config:** `package.json`, `tsconfig.json`, `next.config.ts`, `eslint.config.mjs`, `postcss.config.mjs`, `components.json`, `.env.example`
- **Docker:** `Dockerfile`, `docker-compose.yml`, `docker-entrypoint.sh`, `.dockerignore`
- **DB:** `db/migrations/001_initial_schema.sql`, `002_oauth_state.sql`, `003_lateral_master_staging.sql`, `scripts/db-migrate.mjs`
- **Excel/Python:** `scripts/_inject-p-roles-google-display.py`, `_extract-master-p-roles-feed.py`, plus 9 other `_*.py` repair tools
- **Auth:** `src/lib/auth/*`, `src/middleware.ts`, `/api/auth/*`, Gmail OAuth routes
- **API:** 47 `route.ts` files (listed in §6)

### Tests

No Jest/Vitest/Playwright suite. “Tests” are **tsx verification scripts** (`scripts/verify-*.ts`, `validate-*.ts`).

### Documentation

- `README.md` (outdated: still says dashboard data “not implemented”)
- `docs/phase11-p-roles-*.md`, `phase12-data-state-audit.md`, `phase13-postgres-persistence.md`
- `data/excel/README.md`, `CLAUDE.md`, `AGENTS.md`

---

## 4. Next.js Usage

| Feature | Used? | Reality |
|---------|-------|---------|
| App Router | **Yes** | Only router. No `src/pages`. |
| Pages Router | No | |
| Server Components | Thin | Layouts + redirect pages + metadata. Data comes from client `fetch`. |
| Client Components | **Heavy** | 101 files with `"use client"` |
| Server Actions | **None** | |
| Route Handlers | **47 files** | The real backend |
| Middleware | **Yes** | Session gate (Edge-safe HMAC) |
| SSR/SSG/ISR | Not used for data | No `revalidate`, no `generateStaticParams` for product data |
| Dynamic routes | Yes | Company/candidate slugs; excel `[businessUnitId]`; sync-history `[id]` |
| Layouts | 2 | Root + `(dashboard)` |
| `loading.tsx` | 1 | Dataset only |
| `error.tsx` / `not-found.tsx` | **None** | |
| NextAuth | **No** | Custom HMAC cookie |
| `instrumentation.ts` | **Yes** | Starts cron on Node boot |
| `next.config.ts` | Minimal | `reactStrictMode: true` only |
| Turbopack | Default Next 16 build | Already caused `createReadStream` tracing failure |

### CURRENT NEXT.JS FEATURE → WHAT IT DOES → MIGRATION TARGET

| Current | What it actually does | Target |
|---------|----------------------|--------|
| `src/app/api/**/route.ts` | REST JSON (some file streams) | Express `routes/` + thin controllers |
| `src/middleware.ts` | Cookie session + role | Express middleware (`auth.ts`) |
| `instrumentation.node.ts` | Start `node-cron` | `backend/src/index.ts` after listen |
| `"use client"` pages | SPA screens | Vite React Router routes |
| Server Component pages | Redirect / metadata / wrap client | React Router route files |
| `next/navigation` `redirect` | Legacy URL aliases | React Router `<Navigate>` |
| `next/image` | Little/none critical | `<img>` or Vite assets |
| `next/link` | Client nav | `react-router` `Link` |
| `generateMetadata` | Document titles | `react-helmet-async` or plain `<title>` |
| `export const runtime = "nodejs"` | Force Node API | Default in Express |
| `export const maxDuration = 300` | Vercel timeout | Express + reverse proxy timeout |
| `NEXT_RUNTIME` / `NEXT_PHASE` | Skip cron during `next build` | Not needed |

**Strong reason against Vite?** **None.** App is client-heavy. Vite is appropriate.

**Strong reason against Express?** **None.** APIs are simple REST. Fastify would also work; Express is fine and matches the preferred stack.

---

## 5. Frontend Architecture

### Page inventory (25 routes)

Route group `(dashboard)` is **not** in the URL.

| Route | Purpose | Real UI | APIs | Auth | Notes |
|-------|---------|---------|------|------|--------|
| `/` | Restore last workspace | Client redirect | none | session | localStorage Zustand |
| `/login` | Login | `login-form.tsx` | `/api/auth/login` | public | |
| `/logout` | Logout | page | `/api/auth/logout` | public | |
| `/home` | Home KPIs / workspace | `HomePageContent` | `/api/home/widgets` | session | **Core** |
| `/overview` | Legacy | redirect → `/company` | — | session | Delete after aliases |
| `/executive` | Legacy | redirect → company executive | — | session | Alias |
| `/consulting` | Legacy | redirect → company consulting | — | session | Alias |
| `/lateral` | Legacy | redirect → master-sheet | — | session | Alias |
| `/admin` | Placeholder | static card | none | session | **Stub** |
| `/settings` | Settings | (thin page) | — | session | Likely stub/light |
| `/candidate` | Candidate workspace | index | — | session | Navigation shell |
| `/candidate/[module]` | Candidate module | dynamic | — | session | Limited real data |
| `/company` | Company picker | cards | none | session | Accenture registry |
| `/company/[slug]` | Company home | dashboard shell | excel/home | session | Accenture live |
| `/company/.../[module]` | BU module | openings tables | `/api/excel/...` | session | |
| `/company/.../[section]` | **Master Sheet, Allocations, Exec Master** | large client pages | excel + p-roles | session | **Core dashboards** |
| `/dataset` | Index | redirect → `/dataset/lateral` | — | session | |
| `/dataset/lateral` | Lateral Dataset Manager | wizards, pipeline UI | many `/api/dataset/*` | operator writes | **Core ops** |
| `/dataset/executive` | Executive ingestion UI | executive-dataset page | `/api/dataset/executive` | operator | In progress vs Lateral |
| `/dataset/consulting` | Placeholder | placeholder component | — | session | **Stub** |
| `/dataset/configuration` | **@deprecated** | old config | `/api/dataset/configuration` | operator | Merge into connections/lateral |
| `/dataset/connections` | Gmail/Drive status | connections page | connections, gmail, drive | operator | **Core** |
| `/dataset/connections/gmail` | Gmail panel | inbox panel | gmail/* | operator | |
| `/dataset/connections/drive` | Drive browse | browse UI | drive/* | operator | |
| `/dataset/sync-history` | Sync logs | history UI | sync-history | session | |

### State / data fetching

| Layer | Library | Verdict |
|-------|---------|---------|
| Server cache | TanStack Query | **Keep** (frontend) |
| UI chrome | Zustand (sidebar, search, filters, workspace) | **Keep** (small stores) |
| Forms | `react-hook-form` in package.json | **Unused — remove** |
| Charts | `recharts` in package.json | **Unused in src — remove or use later** |
| Motion | Framer Motion (~23 files, mostly Home/nav) | Optional keep; can slim |
| Tables | TanStack Table | Keep for openings/master |

### Duplication / size issues

- Two setup wizards: `setup-wizard.tsx` (~51 KB) and `lateral-dataset-setup-wizard.tsx` (~52 KB)
- `dataset-manager.tsx` **66 KB** — god component
- `lateral-processing-preview.tsx` **51 KB**
- Duplicate filter stores: `filter-store.ts` vs `dashboard-filter-store.ts`
- Company routing is a **registry + giant switch** in section page (Accenture-only in practice)

### Unused / obsolete UI

- Admin page stub
- Consulting dataset placeholder
- Legacy redirects (`/overview`, `/lateral`, `/executive`, `/consulting`, `/dataset/configuration`)
- Candidate workspace: navigation-heavy, little pipeline integration

---

## 6. Backend / API Architecture

### Endpoint table

| METHOD | PATH | FILE | PURPOSE | DB | External | Auth | Migration |
|--------|------|------|---------|----|----------|------|-----------|
| GET/POST | `/api/auth/login` | `api/auth/login` | Dashboard login | users file / env | — | public | Express auth |
| POST | `/api/auth/signup` | signup | Register user | `.data` users | — | public | Express auth |
| POST | `/api/auth/logout` | logout | Clear cookie | — | — | session | Express auth |
| GET | `/api/auth/me` | me | Current user | — | — | session | Express auth |
| GET | `/api/health` | health | Liveness | — | — | public | Express |
| GET | `/api/home/widgets` | home/widgets | Home KPIs | `home_metrics` / file | Drive bootstrap if file mode | session | home module |
| POST | `/api/cron/lateral` | cron/lateral | External cron trigger | lock + pipeline | Gmail/Drive | **operator at MW** + `CRON_SECRET` in handler | Express + secret; fix MW mismatch |
| GET | `/api/excel/[businessUnitId]` | excel/... | Openings dataset | PG or Excel | Drive | session | excel/read |
| GET | `/api/excel/.../filters` | filters | Filter schema | PG/Excel | — | session | |
| GET | `/api/excel/.../opening-skills` | opening-skills | Skills | Excel | — | session | |
| GET | `/api/excel/.../skill-clusters` | skill-clusters | Clusters | Excel | — | session | |
| GET | `/api/excel/lateral-master-sheet` | lateral-master-sheet | Master grid | Drive XLSM | Drive | session | **Excel-backed** |
| GET | `/api/excel/lateral-master-sheet/export` | export | XLSX export | Drive | Drive | session | |
| GET | `/api/excel/executive-master-sheet` | exec master | Exec master | Drive | Drive | session | |
| GET | `/api/excel/executive-master-sheet/export` | export | Export | Drive | Drive | session | |
| GET | `/api/excel/executive-p-dashboard` | p-dashboard | Exec P-Dashboard | Drive | Drive | session | |
| GET | `/api/dataset/lateral/p-roles` | p-roles | P-Roles openings | **`lateral_master`** | optional Drive parity | session | **Core PG** |
| GET/POST | `/api/dataset/lateral/scheduler` | scheduler | Lateral cron config | `lateral_scheduler_state` | — | GET session / POST operator | |
| GET | `/api/dataset/lateral/sync-history` | sync-history | Lateral runs | `lateral_sync_history` | — | session | |
| GET/POST | `/api/dataset/lateral-processing/setup` | setup | Pipeline folder/workbook config | encrypted config | Drive | operator write | |
| POST | `/api/dataset/lateral-processing/pipeline` | pipeline | Full 25-step pipeline | Excel + PG posted | Drive/Gmail | operator | **Core** |
| POST | `/api/dataset/lateral-processing/execute` | execute | Staged New Sheet (no prod commit) | local XLSM | Drive | operator | |
| GET | `/api/dataset/lateral-processing/preview` | preview | Preview | Excel | Drive | session | |
| GET | `/api/dataset/lateral-processing/workbooks` | workbooks | List Drive workbooks | — | Drive | session | |
| GET | `/api/dataset/lateral-processing/worksheets` | worksheets | List sheets | — | Drive | session | |
| POST | `/api/dataset/lateral-processing/reconcile/confirm` | confirm | Confirm reconcile | Excel | Drive | operator | |
| POST | `/api/dataset/lateral-processing/reconcile/cancel` | cancel | Cancel staging | file | — | operator | |
| GET/POST | `/api/dataset/executive` | executive | Exec ingest / reconcile | Drive | Gmail/Drive | operator POST | |
| GET/POST | `/api/dataset/configuration` | configuration | Deprecated dataset config | encrypted | — | operator | Merge |
| GET/DELETE | `/api/dataset/connections` | connections | Connection status / disconnect | encrypted | — | DELETE operator | |
| GET | `/api/dataset/current` | current | Current dataset file | file/meta | Drive | session | |
| GET/POST/DELETE | `/api/dataset/setup` | setup | Dataset Manager setup | encrypted | Drive | operator | Overlaps lateral setup |
| GET/POST | `/api/dataset/ops` | ops | Ops actions | mixed | Drive | operator | Fat endpoint — split |
| GET/POST | `/api/dataset/scheduler` | dataset scheduler | **Legacy** multi-dataset cron | `dataset_schedules` | — | operator | Likely retire |
| GET | `/api/dataset/sender-stats` | sender-stats | Gmail sender stats | `sender_stats` | — | session | |
| GET/POST | `/api/dataset/notifications` | notifications | In-app notices | `app_notifications` | — | POST authenticated | |
| GET | `/api/dataset/sync-history` | dataset sync-history | Legacy dataset runs | `dataset_sync_history` | — | session | Overlaps lateral history |
| GET | `/api/dataset/sync-history/[id]/log` | log | Log file | disk | — | session | |
| GET | `/api/dataset/gmail/status` | gmail/status | OAuth status | app_config | — | session | |
| DELETE | `/api/dataset/gmail/status` | | Disconnect Gmail | app_config | — | operator | |
| GET/POST | `/api/dataset/gmail/messages` | messages | List/search mail | — | Gmail | **operator** | |
| GET/POST | `/api/dataset/gmail/sync` | sync | Manual Gmail sync | checkpoint | Gmail/Drive | **operator** | |
| GET | `/api/dataset/gmail/oauth/start` | oauth/start | Start Google OAuth | oauth_state | Google | **operator** | |
| GET | `/api/dataset/gmail/oauth/callback` | callback | OAuth redirect | tokens | Google | **public** (state token) | |
| GET | `/api/dataset/drive/browse` | browse | Browse Drive | — | Drive | session | |
| GET | `/api/dataset/drive/folders` | folders | Folders | — | Drive | session | |
| GET | `/api/dataset/drive/metadata` | metadata | Drive meta | app_config | Drive | session | |
| GET | `/api/dataset/drive/quota` | quota | Quota | — | Drive | session | |

### Logical modules

- **authentication** — `/api/auth/*`
- **dashboard/home** — `/api/home/widgets`
- **lateral dashboard reads** — `/api/dataset/lateral/p-roles`, `/api/excel/lateral-*`, filters
- **lateral pipeline ops** — `lateral-processing/*`, `cron/lateral`, `lateral/scheduler`
- **gmail / drive** — `gmail/*`, `drive/*`, `connections`
- **executive** — `dataset/executive`, `excel/executive-*`
- **legacy dataset manager** — `setup`, `ops`, `scheduler`, `configuration`, `current`
- **admin** — none (UI stub only)

### API problems

- **`/api/dataset/ops`** and **`/api/dataset/setup`** overlap Lateral processing setup.
- **Two schedulers** (dataset vs lateral); dataset cron is disarmed but API remains.
- **Cron auth mismatch:** middleware requires operator session; handler also wants `CRON_SECRET`. VPS cron cannot easily send a dashboard cookie.
- Route files are thin (good) — **keep services, rewrite only HTTP adapters**.

---

## 7. PostgreSQL Architecture

### Migrations

| File | Objects |
|------|---------|
| `001_initial_schema.sql` | `gmail_checkpoint`, `app_config`, `lateral_scheduler_state`, `dataset_scheduler_state`, `dataset_schedules`, `lateral_sync_history`, `dataset_sync_history`, `sync_watermark`, `lateral_source_drive_state`, `home_metrics`, `app_notifications`, `sender_stats`, `lateral_p_roles_sheet_config`, `schema_migrations` |
| `002_oauth_state.sql` | `oauth_state` |
| `003_lateral_master_staging.sql` | `lateral_master`, `lateral_staging` + indexes |

**No views. No ORM.** Query style: tagged template SQL via `postgres` package.

### Connection

- `src/lib/persistence/db-client.ts` — `getDbClient()`, `POSTGRES_URL`, **`max: 1` pool** (fine for one app process; revisit if multiple Node processes).
- SSL required except localhost.

### Dual persistence

- `ARA_PERSISTENCE=file` → JSON/encrypted JSON under `.data/`
- `ARA_PERSISTENCE=postgres` → store factory maps same interfaces to SQL
- **`lateral_master` / `lateral_staging` are postgres-only** (not in file-store factory)

### Reuse after leaving Next.js

**Yes — almost unchanged.** Move:

- `src/lib/persistence/*`
- `src/services/persistence/*`
- `db/migrations/*`
- `scripts/db-migrate.mjs`

No Next.js types in the SQL layer. Only `instrumentation` / Route Handlers wrap it.

### Constraints of note

- `lateral_master.job_status` ∈ New|Reopen|Active|Closed
- `lateral_master.posted` ∈ Yes|`-`
- Upsert **must not overwrite `posted`** (Step 18 owns Posted)
- `gmail_checkpoint` unique per `account_email` (dedupe)

---

## 8. Data Ingestion Architecture

### Pipeline A — Lateral Run All (production path)

```
Gmail attachment
  → Drive upload (source Excel)
  → Discover Master XLSM
  → pipeline.ts (25 steps): New Sheet fill, JR reconcile, Posted A/B/C,
     P-Roles refresh (COM or OpenPyXL), save, Drive files.update
  → optional PG posted sync (Step C)
  → checkpoint advance
```

**Classification:** **A. Core — must preserve.** Next.js-specific: only the HTTP route + instrumentation boot.

### Pipeline B — Phase 3A Gmail → PostgreSQL staging

```
Gmail/Drive → lateral-gmail-staging-job → lateral_staging → upsert lateral_master
```

Used by scripts (`run-phase3a-live-gmail.ts`, `import-atci-ds-to-staging.ts`), **not** wired into Run All.

**Classification:** **A. Core for dashboard PG reads**, **C. Duplicate ingestion path** vs Excel pipeline. Long-term: one ingestion, two outputs (XLSM + PG) or PG-primary.

### Pipeline C — Executive

```
Gmail Exec DS → validate → Drive → New Sheet / Master reconcile (Phase 4A–4C)
```

**Classification:** **A. Keep services.** Less mature than Lateral. Dashboard Exec Master still Excel/Drive.

### Pipeline D — Home widgets

```
home_metrics (PG) ← merge after pipeline / bootstrap
file mode: may bootstrap from Drive XLSM
postgres mode: read-only, no Drive on Home GET
```

**Classification:** **A. Core.** Empty-KPI protection must stay.

### Python

| Must keep for Linux Docker | One-off / investigate |
|----------------------------|------------------------|
| `_inject-p-roles-google-display.py` | `_step92*`, `_step93*`, `_rebuild-p-roles-pivot.py`, `_modify-main-p-roles-pivot.py` |
| `_extract-master-p-roles-feed.py` | `extract-jd-samples.py` |
| `_refresh-p-roles-pivot.py` (Windows COM) | inspect/diagnose scripts |

### Scheduled jobs

- `lateral-scheduler.ts` + `node-cron` — **keep**
- `dataset/scheduler.ts` — **legacy, disarmed**
- `/api/cron/lateral` — Vercel leftover + Hostinger; keep as HTTP trigger **after fixing auth**

---

## 9. Authentication / Security

### Two separate systems

1. **Dashboard session** — HMAC-SHA256 cookie `ara_session` (12h), roles `viewer` | `operator`. Env: `ARA_SESSION_SECRET`, `ARA_DASHBOARD_PASSWORD`, optional user store `.data/dashboard-users.json`. **Not JWT. Not NextAuth.**
2. **Google OAuth** — one client for Gmail + Drive + Sheets. Tokens in encrypted `app_config` / `.enc.json`. State in `oauth_state` table.

### Simplest equivalent (React → Express → PostgreSQL)

- Keep HMAC (or switch to signed cookie via `iron-session` / `cookie` + HMAC — same idea).
- Express: `cookie-parser` or manual `Cookie` header; same `session.ts` / `access.ts` logic (already Node/Web Crypto).
- Vite app: `credentials: 'include'` on `fetch`; proxy `/api` in dev.
- Google OAuth callback URL becomes `https://host/api/dataset/gmail/oauth/callback` on Express (same path to reduce breakage).
- Do **not** add Passport/Auth0 unless required.

### Secrets (env — do not commit)

`POSTGRES_URL`, `ARA_SESSION_SECRET`, `ARA_DASHBOARD_PASSWORD`, `GOOGLE_CLIENT_ID/SECRET`, `ARA_APP_URL`, optional `CRON_SECRET`, `ARA_OPERATOR_ALLOWLIST`.

### Issues

- Users/passwords still **file-based** even in postgres mode.
- Cron vs middleware (see §6).
- Signup is public POST if auth configured — confirm that is intended.

---

## 10. Dependency Audit

### KEEP (frontend)

| Package | Why |
|---------|-----|
| `react`, `react-dom` | UI |
| `@tanstack/react-query` | API cache |
| `@tanstack/react-table` | Tables |
| `zustand` | Chrome state |
| `lucide-react` | Icons |
| `clsx`, `tailwind-merge`, `class-variance-authority` | Styling |
| `tailwindcss` (+ postcss) | CSS |
| `@base-ui/react` | shadcn primitives |
| `framer-motion` | Optional keep |

### KEEP (backend)

| Package | Why |
|---------|-----|
| `postgres` | DB |
| `googleapis` | Gmail/Drive |
| `exceljs` | Workbooks |
| `node-cron` | Scheduler |

### KEEP (shared util)

| Package | Why |
|---------|-----|
| `jspdf` | JD PDF download |

### REMOVE AFTER MIGRATION (Next-specific)

| Package | Why |
|---------|-----|
| `next` | Framework |
| `eslint-config-next` | Replace with ESLint React/Vite |

### REMOVE (unused now)

| Package | Evidence |
|---------|----------|
| `react-hook-form` | **Zero imports** |
| `recharts` | **Zero imports in src** |
| `shadcn` | CLI as **runtime** dependency — belongs in dev/docs only |

### REPLACE

| From | To |
|------|-----|
| `next/link`, `next/navigation` | `react-router-dom` |
| Next Route Handlers | `express` |
| Next middleware | Express middleware |
| `tsx` | Keep for scripts (or `ts-node`) |

### INVESTIGATE

| Package | Note |
|---------|------|
| `@base-ui/react` vs copying only used `src/components/ui` | Fine to keep |
| `tw-animate-css` | Tailwind animation helper |

**Do not add an ORM** (Prisma/Drizzle) unless you want a rewrite of working SQL.

**Vite extras:** `vite`, `@vitejs/plugin-react`, `react-router-dom`. Backend: `express`, `cors`, `dotenv`. Types: `@types/express`, `@types/cors`.

---

## 11. File / Complexity Audit

### Very large files (complexity hotspots)

| File | Size | Issue |
|------|------|--------|
| `lateral-p-roles-sheets-pivot.ts` | 73 KB | Google Sheets pivot experiment — **legacy vs PG P-Roles** |
| `dataset-manager.tsx` | 66 KB | Split by tab/panel |
| `master-reconcile.ts` | 55 KB | Core — keep, maybe split types vs I/O |
| `lateral-dataset-setup-wizard.tsx` | 52 KB | Overlaps other wizard |
| `setup-wizard.tsx` | 51 KB | Duplicate UX |
| `lateral-processing-preview.tsx` | 51 KB | UI + pipeline types |
| `parse-job-description.ts` | 42 KB | Keep if JD modal still used |
| `pipeline.ts` | 41 KB | Core orchestrator — keep |

### Duplicate / similarly named

- `read-lateral-master-from-drive-xlsm.ts` vs `...-vercel-safe.ts` (Vercel leftover)
- `lateral-p-roles-service` vs `native` vs `engine` vs `excel` vs `google-compatible` vs `google-p-roles-native` vs `sheets-pivot`
- `dataset/scheduler.ts` vs `lateral-scheduler.ts`
- Two sync-history APIs (dataset vs lateral)

### Legacy / one-off (`scripts/`)

~112 files. Categories:

- **Keep:** `db-migrate.*`, current `verify-*-postgres.ts`, `verify-stepc-posted-safety.ts`, `verify-lateral-posted-postgres-step18.ts`, inject/extract Python used in Docker
- **Archive/delete after migration:** `step8*`, `step9*`, `_mailbox-migration-*`, `step10-create-native-google-p-roles.ts`, many `final-test-*`, `inspect-*`

### README

Out of date (“Dashboard data features are intentionally not implemented”).

---

## 12. Git / Branch Audit

| Branch | Role |
|--------|------|
| **`node-test`** (current) | Migration/test branch @ `a35563e` — **do not confuse with production** |
| `phase9-unified` | Integration: Phase 8 + Docker A/B/C + Turbopack + TS narrowing |
| `testing` | Phase 8 laptop checkpoint `8ccde37` |
| `origin/prod` | Production remote |
| `origin/vps-phase7-wip` | VPS experiments — **do not discard** |
| `origin/Testing` vs `testing` | Historical Windows case-sensitivity gotcha |
| `main` | Older line |

**Recent commits (node-test / phase9-unified):**

```
a35563e fix(home): resolve strict metrics narrowing errors
24cdfde fix(lateral): ignore dynamic Drive stream in Turbopack
c49250f Step C Posted → PostgreSQL
e3428cf Step B Linux P-Roles
7adcdbe Step A Docker
8ccde37 Phase 8 PG dashboard reads
```

**LOCAL:** this laptop repo, `.env.local`, `.data/`  
**VPS PRODUCTION:** Hostinger Docker/`dashboard.araresources.com` — **do not deploy from this audit**  
**MIGRATION/TEST:** `node-test`

`.gitignore` already excludes `.next`, `node_modules`, `.data`, Excel, `.env`. `.next` is local-only (good). No need to commit generated artifacts.

---

## 13. Problems Found

1. Next.js 16 Turbopack **file tracing** fights Drive `createReadStream` (already patched).
2. Dual Excel + PG sources confuse ownership of `posted` / P-Roles.
3. P-Roles implemented **many times** (Sheets pivot, native Google sheet, XLSM inject, PG aggregation).
4. Dual schedulers; cron HTTP auth vs session middleware conflict.
5. File-mode + postgres-mode doubles persistence code (`file-stores` + `postgres-stores`).
6. `scripts/` is a graveyard of phase/step programs.
7. Unused npm packages (`react-hook-form`, `recharts`, runtime `shadcn`).
8. Vercel-oriented files (`vercel-safe` reader, `maxDuration`, `/api/cron`) while target is **VPS Docker**.
9. README and some comments still describe Phase 2/3 / Vercel.
10. Pool `max: 1` and in-process cron: scaling to multiple containers needs a job lock (already `pg_advisory_lock` for some paths).

---

## 14. What Should Be Preserved

- Lateral 25-step pipeline semantics (backup, New Sheet, JR rules, Posted, P-Roles inject, Drive update)
- `posted` ownership (upsert must not clobber; Step 18 writes PG)
- Phase 8 `read-lateral-master` + P-Roles API + Home KPIs + empty-KPI merge
- HMAC session + operator vs viewer
- Google OAuth token store
- SQL migrations 001–003
- Linux Python inject/extract used in Docker
- Gmail checkpoint dedupe
- Executive ingestion services (even if UI is younger)

---

## 15. What Should Be Simplified

- One HTTP adapter layer (Express) instead of 47 Next files
- One scheduler (Lateral)
- One P-Roles **read** path (PostgreSQL)
- One P-Roles **write** path (XLSM inject on Linux; COM optional on Windows)
- Merge dataset setup vs lateral-processing setup
- Split `dataset-manager.tsx`
- Drop file-persistence **after** postgres-on-VPS is the only prod mode (keep file mode only if laptop-without-PG is required)
- Collapse legacy redirects into React Router once

---

## 16. What Should Eventually Be Deleted

*(After migration works — not now)*

- `next`, App Router trees, `next.config.ts`, `instrumentation.ts` Next wrapper
- `read-*-vercel-safe.ts` if VPS-only
- `lateral-p-roles-sheets-pivot.ts` if unused in prod path
- Native Google Spreadsheet P-Roles create/delete scripts
- Disarmed dataset scheduler UI/API if product is Lateral-only cron
- Unused deps listed in §10
- Most `scripts/step*` / `_mailbox-migration-*` (git history keeps them)
- `.next` (never copy to new repo)

---

## 17. Proposed Simple Architecture

Matches the preferred layout. No microservices, no ORM, no extra repository layer beyond existing `getDbClient()` + service functions.

```
ARA Dashboard
│
├── frontend/                 # Vite + React + TS
│   ├── src/pages or src/routes
│   ├── src/components        # move from current src/components
│   ├── src/hooks, stores, providers
│   └── src/api/client.ts     # fetch wrapper, credentials include
│
├── backend/                  # Express + TS
│   ├── src/index.ts          # listen, cron start
│   ├── src/middleware/auth.ts
│   ├── src/routes/           # one file per module
│   ├── src/services/         # MOVE current src/services (unchanged logic)
│   ├── src/lib/              # MOVE persistence + auth crypto
│   └── src/python/           # or keep scripts/ for py
│
├── scripts/                  # migrate + a small verify set
├── database/migrations/      # move db/migrations
└── docker/                   # one Dockerfile: nginx or express static + API
    └── compose: postgres volume + app
```

**Even simpler option:** keep a **monorepo single package** with `frontend/` and `backend/` folders, one `package.json` workspaces — avoid premature npm workspaces complexity if the team is small.

**Static hosting:** Express `express.static` for Vite `dist/` **or** nginx in front. One process is enough for VPS.

**Do not introduce:** NestJS, GraphQL, Prisma, Redux, microservices.

---

## 18. Next.js → Node.js Migration Mapping

| Next | Express |
|------|---------|
| `route.ts` GET/POST | `router.get/post` |
| `NextResponse.json` | `res.json` |
| `request.json()` | `express.json()` |
| `params` Promise | `req.params` |
| `searchParams` | `req.query` |
| `cookies()` / Set-Cookie | `res.cookie` / `res.clearCookie` |
| `middleware.ts` | `app.use(authMiddleware)` |
| `instrumentation.node.ts` | `startSchedulers()` in `index.ts` |
| `export const maxDuration` | reverse-proxy + `server.timeout` |
| Dynamic `import()` of heavy excel | keep as-is in services |

---

## 19. React Migration Mapping

| Next | Vite |
|------|------|
| `src/app/**/page.tsx` | `react-router` routes |
| `(dashboard)/layout.tsx` | layout route with sidebar |
| `next/link` | `Link` from react-router |
| `useRouter().replace` | `useNavigate()` |
| `redirect()` | `<Navigate to= />` |
| `generateMetadata` | document title in layout or per-page `useEffect` |
| `"use client"` | delete directive (all client) |
| Image / public | Vite `public/` (already similar) |
| Tailwind v4 | keep; Vite postcss plugin |

**Pages that are only redirects** become a few `<Navigate>` entries — shrinks the tree.

---

## 20. Migration Roadmap

### Stage 0 — Audit (this document)

Done. No code changes.

### Stage 1 — Design freeze (approval)

Agree: Vite + Express + existing services + existing SQL. Agree postgres-on-VPS as prod. Defer Neon vs embedded PG (already deferred).

### Stage 2 — Scaffold backend on `node-test`

- `backend/` Express hello + `/api/health`
- Reuse `getDbClient` — **move files, don’t rewrite SQL**
- Files affected: new backend only  
- Rollback: unused folder

### Stage 3 — Auth + middleware

- Port `session.ts`, `access.ts`, login/logout/me  
- Tests: login cookie round-trip  
- Rollback: Next app still runs

### Stage 4 — Read APIs first (low risk)

Move: `/api/home/widgets`, `/api/dataset/lateral/p-roles`, `/api/excel/*` GET  
Reuse: all services  
Delete later: Next route files

### Stage 5 — Gmail/Drive/OAuth

Same paths if possible so Google console redirect URI stays valid.

### Stage 6 — Pipeline + scheduler

Move `pipeline.ts` callers last among APIs (longest running, file streams).  
Cron: start from Express; fix CRON_SECRET vs session.

### Stage 7 — Vite frontend

Copy components/hooks/stores; add router; `vite` proxy to Express.  
Rewrite: only Next imports.

### Stage 8 — Scripts / Python

Keep inject/extract; don’t port 112 verify scripts on day one.

### Stage 9 — Remove Next.js

`package.json` drop `next`; Docker: `node backend` + static frontend.

### Stage 10 — Delete obsolete

Vercel-safe readers, unused deps, dead P-Roles modules (only after grep shows zero imports).

### Stage 11 — Local testing

`tsc`, login, Home KPIs, P-Roles, one pipeline dry-run (`commitToProduction: false`).

### Stage 12 — Isolated VPS image

Same as Phase 9.2: **build-test image, no production compose swap**.

### Stage 13 — Production cutover

Only after isolated container matches Phase 8 reads + pipeline.

**Rollback each stage:** `phase9-unified` / `origin/prod` remain; `node-test` is disposable until merge.

---

## 21. Risks

| Risk | Mitigation |
|------|------------|
| Breaking Google OAuth redirect | Keep callback path identical |
| Pipeline timeouts | Express already Node; set proxy timeout ≥ 10 min |
| Dual PG vs Excel drift | Don’t change upsert/posted rules while moving HTTP |
| Cron double-fire (Next + Express) | Never run both stacks in one container |
| Losing Windows COM path | Keep `lateral-p-roles-pivot-refresh` platform branch |
| Scope creep (rewrite Excel in JS) | **Forbidden** in first migration |
| 5.6 GB workspace copy | Don’t copy `.next` / `node_modules` |

---

## 22. Recommended Migration Order

1. **Read APIs + auth + Vite shell** (dashboard usable against Express)
2. **Gmail/Drive** (ops UI)
3. **Pipeline + cron** (ops critical path)
4. **Executive** (same pattern)
5. **Delete Next + unused**

Do **not** start with rewriting P-Roles or ExcelJS.

---

## 23. Estimated Reduction Opportunities

| Area | Today | After disciplined cleanup |
|------|-------|---------------------------|
| Working tree on disk | ~5.6 GB | ~1 GB with node_modules of two apps; **src still ~2–3 MB** |
| `scripts/` ~112 files | High noise | ~15–25 keepers |
| P-Roles TS modules | ~8 overlapping | 2–3 (engine + PG service + XLSM inject) |
| API surface | 47 files | ~12 Express routers |
| npm deps | unused form/charts/shadcn CLI | −3 packages + drop `next` |
| Page files | 25 | ~12 real screens + redirects table |

**Complexity reduction > byte reduction.** The maintainability win is **one backend process, one frontend SPA, one P-Roles read path, one scheduler.**

---

## WAITING FOR APPROVAL

**Recommended next step (still no production, no VPS, no Next deletion):**

On branch `node-test` only, after you approve: **Stage 1 written design freeze** (1–2 pages: folder layout, auth cookie names, `/api` path compatibility, Express vs keeping Next during a dual-run period).

Then **Stage 2:** scaffold `backend/` with Express + port `/api/health` + `getDbClient` smoke query — **additive**, Next.js app untouched so `phase9-unified` Docker work can continue.

**Do not** start moving `pipeline.ts` or deleting Next.js until Stage 2 health + auth login works locally.
)
