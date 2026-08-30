# ARA Dashboard — Stage 1 Design Freeze

**Migration:** Next.js 16 → React/Vite + Node.js/Express + PostgreSQL  
**Branch:** `node-test` only  
**Status:** DESIGN ONLY — no application code, Docker, env, or schema changes in this stage.

**Out of scope (do not touch):** production, `origin/prod`, `phase9-unified`, VPS.

**Prior document (inventory and findings — do not duplicate here):**  
[docs/nextjs-to-nodejs-migration-audit.md](./nextjs-to-nodejs-migration-audit.md)

---

## 1. Purpose

This document is the **migration contract**. Later stages must follow it.

It freezes:

- target architecture
- ownership (frontend / backend / database)
- no-duplication
- API path compatibility
- auth, scheduler, Excel/P-Roles preservation
- stage order and rollback
- env and Docker direction

It does **not** create `frontend/` or `backend/` trees, move `src/services`, or convert Next.js.

---

## 2. Verified assumptions (spot-check)

Confirmed on `node-test` @ `a35563e`:

| Assumption | Status |
|------------|--------|
| App Router only; APIs are Route Handlers | Confirmed |
| Business logic in `src/services/` | Confirmed |
| HMAC cookie `ara_session`, roles `viewer` / `operator` | Confirmed (`src/lib/auth/session.ts`) |
| `postgres` package + raw SQL, no ORM | Confirmed (`src/lib/persistence/db-client.ts`) |
| `frontend/` and `backend/` do not exist yet | Confirmed |
| Canonical backend code today lives under Next `src/` | Confirmed |

---

## 3. Target architecture

```
Browser (React / Vite / React Router)
        │  fetch("/api/...", { credentials: "include" })
        ▼
HTTPS / VPS reverse proxy
        ▼
Express (Node, TypeScript)
        │  thin routes + auth middleware
        ▼
ONE canonical services + lib layer
        ▼
PostgreSQL | Gmail | Drive | ExcelJS | Python/OpenPyXL | node-cron
```

**Final repo shape (target, not created in Stage 1):**

```
ara-dashboard/
├── frontend/          # Vite SPA only
├── backend/           # Express + ALL server business logic
├── scripts/           # migrate + verify (not a second backend)
├── db/migrations/     # source of truth for schema
├── Dockerfile
├── docker-compose.yml
└── README.md
```

**Until Stage 13:** existing Next.js tree under `src/` remains the **running reference implementation**. New folders appear only when a stage needs them.

**Forbidden stacks:** NestJS, GraphQL, Prisma/Drizzle/TypeORM/Sequelize, Redux, microservices, extra DI/repository layers.

**Allowed additions (when a stage needs them):** `express`, `cors`, `vite`, `@vitejs/plugin-react`, `react-router-dom`, `@types/express`. Not in Stage 1.

---

## 4. Ownership

### 4.1 Frontend (`frontend/src/` — eventually)

Owns: UI, React Router, components, pages, browser hooks, Zustand, TanStack Query, API client, frontend-only utils/types.

Must **not**: connect to PostgreSQL, hold `POSTGRES_URL` / Google secrets / session secret, run pipelines, import `src/services/*` server modules.

Talks to the server **only** via HTTP `/api/*`.

### 4.2 Backend (`backend/src/` — eventually)

Owns: Express, routes, middleware, HMAC auth, `postgres` client, SQL, Gmail, Drive, ExcelJS, Lateral/Executive pipelines, P-Roles processing, Python child processes, `node-cron`.

**Today (Stage 1):** that code is still in Next.js:

- `src/app/api/**/route.ts` — HTTP adapters (replace later)
- `src/middleware.ts` — session gate (port later)
- `src/instrumentation.node.ts` — cron boot (move to `backend/src/index.ts` later)
- `src/services/` — **canonical business logic (move, do not copy)**
- `src/lib/` — **canonical auth + persistence + config (move, do not copy)**

### 4.3 Database

- PostgreSQL remains production data store.
- Canonical client: existing `postgres` package (`getDbClient()`).
- Canonical schema: `db/migrations/` (`001`, `002`, `003`).
- No ORM. Do not rewrite working SQL for style.
- Final location: **one** implementation under `backend/src/lib/` (or equivalent backend-owned path).
- File mode (`ARA_PERSISTENCE=file`) stays as dual-mode in current code until a later stage explicitly retires it. Do not invent a third persistence stack.

### 4.4 Authentication

Preserve:

- Cookie name: `ara_session`
- HMAC-SHA256 session (Web Crypto)
- Roles: `viewer` | `operator`
- Policy equivalent to `src/lib/auth/access.ts`
- Google OAuth for Gmail/Drive (separate from dashboard session)

Do **not** introduce JWT, NextAuth, Passport, or Auth0 unless a future task explicitly approves it.

Target:

```
React → HTTP cookie → Express auth middleware → route → service
```

OAuth callback path should stay  
`/api/dataset/gmail/oauth/callback`  
so Google Cloud Console registration does not need a drive-by change.

### 4.5 Schedulers

- **One maintained Lateral scheduler** in the target: started from `backend/src/index.ts` after listen.
- Do **not** create a second Lateral cron implementation.
- Legacy multi-dataset scheduler (`src/services/dataset/scheduler.ts`) stays **untouched** in this freeze; retirement is a later, verified decision.
- Do not run Next instrumentation cron and Express cron in the same process/container.

---

## 5. No-duplication rule (mandatory)

**Never two canonical copies of the same business capability.**

Forbidden examples:

- `src/services/` **and** `backend/src/services/` both containing pipeline/P-Roles/SQL logic
- `src/lib/persistence/` **and** `backend/src/lib/persistence/` both owning `getDbClient`
- `old-pipeline` / `new-pipeline`, `old-p-roles` / `new-p-roles`

**Allowed:** thin adapters with **no algorithms**:

| Adapter | Delegates to | Removed when |
|---------|----------------|--------------|
| Next `route.ts` | existing `src/services` | Express route verified |
| Express `routes/*.ts` | same services (after **move**) | — |
| Vite `api/client.ts` | HTTP `/api/*` only | — |

If unsure whether to copy or move: **stop and report**. Default is **MOVE**, not copy.

**MOVE → ADAPT → TEST → DELETE**

Rewrite only if code is Next-specific, cannot run under Node, is obsolete, or a later stage explicitly requires an architectural change.

---

## 6. API compatibility

Preserve existing `/api/*` paths for the initial migration.

Examples that must keep working as-is:

- `/api/auth/login` `/api/auth/logout` `/api/auth/me`
- `/api/home/widgets`
- `/api/dataset/lateral/p-roles`
- `/api/excel/lateral-master-sheet`
- `/api/dataset/gmail/oauth/callback`
- `/api/health`

Frontend must not need to know whether Next or Express is serving `/api`.

Do **not** bulk-rename endpoints in Stages 2–11. Cleanup is a separate later task.

Express routes stay **thin**: method, params, query, auth, call service, `res.json` / status. No reconcile/P-Roles algorithms in route files.

---

## 7. Excel / P-Roles / pipeline (do not rewrite)

Preserve as-is (move later, do not reimplement):

- 25-step Lateral pipeline (`pipeline.ts`)
- Master reconcile, Posted ownership (upsert must not overwrite `posted`; Step 18 owns PG `posted`)
- P-Roles processing (Linux OpenPyXL inject; Windows COM optional)
- Gmail → Drive → workbook flow
- ExcelJS
- Python scripts already required by Docker (`_inject-p-roles-google-display.py`, `_extract-master-p-roles-feed.py`, COM refresh script where used)

**Strategy:**

```
Express API → existing business service → existing pipeline
```

Not: Express → new pipeline → new Excel/P-Roles.

---

## 8. Frontend routing mapping (documentation only)

| Next | Target (later stages) |
|------|------------------------|
| `src/app/login/page.tsx` | `frontend/src/pages/LoginPage.tsx` |
| `src/app/(dashboard)/home/page.tsx` | `frontend/src/pages/HomePage.tsx` |
| `redirect("/company")` | React Router `<Navigate>` / `navigate()` |
| `next/link` | `react-router-dom` `Link` |
| `"use client"` | omit (Vite app is client) |

Do not migrate pages in Stage 1.

**API client:** one small `frontend/src/api/client.ts` (`credentials: "include"`, consistent errors). Not a fetch wrapper per endpoint unless a real need appears.

---

## 9. Environment variables

Do not change `.env` / `.env.local` / `.env.example` in Stage 1.

| Category | Examples | Rule |
|----------|----------|------|
| **BACKEND-ONLY (runtime secrets)** | `POSTGRES_URL`, `ARA_SESSION_SECRET`, `ARA_DASHBOARD_PASSWORD`, `GOOGLE_CLIENT_SECRET`, `CRON_SECRET`, `ARA_DATASET_SETUP_SECRET` | Never `VITE_*`. Never in frontend bundle. |
| **BACKEND-ONLY (runtime config)** | `ARA_PERSISTENCE`, `ARA_APP_URL`, `GOOGLE_CLIENT_ID`, `GOOGLE_GMAIL_REDIRECT_URI`, `ARA_LATERAL_MASTER_DRIVE_FILE_ID`, `ARA_P_ROLES_PIPELINE`, `ARA_DATASET_SCHEDULER` | Express `process.env` |
| **FRONTEND-SAFE (public, optional)** | None required for `/api` same-origin. If later needed: only non-secrets, e.g. public app origin | Prefix `VITE_` only if unavoidable |
| **BUILD-TIME** | Vite `base` if ever used | No secrets |
| **LEGACY Next public** | `NEXT_PUBLIC_APP_URL` | Treat as alias of `ARA_APP_URL` until Next is removed; do not add new `NEXT_PUBLIC_*` |

---

## 10. Docker / VPS direction

- Production is **VPS**, not Vercel. Do not design around Hobby `maxDuration` or Vercel Cron as the primary model.
- Target: Browser → reverse proxy/HTTPS → Node/Express → PostgreSQL (embedded-in-container or host — **not decided in this freeze**; do not switch silently).
- Vite emits static assets; how they are served (Express `static` vs nginx) is decided at the Docker stage.
- **Do not rewrite Dockerfile / compose in Stage 1.** Phase 9 Docker work stays on `phase9-unified`.

Known follow-up (not this stage): `/api/cron/lateral` vs middleware operator-session vs `CRON_SECRET` — fix when that route is ported.

---

## 11. Frozen migration stages

Do not skip. Do not merge the whole migration into one change.

| Stage | Name | Notes |
|------:|------|--------|
| 0 | Audit | **DONE** — `docs/nextjs-to-nodejs-migration-audit.md` |
| **1** | **Design freeze** | **THIS DOCUMENT** |
| 2 | Minimal Express foundation | health process only; **no** copy of services |
| 3 | PostgreSQL smoke test | import/move `getDbClient` **once**; no second client |
| 4 | Auth + Express middleware | port `session`/`access`; cookie name unchanged |
| 5 | First read API vertical slice | prefer `/api/health` already done; first data slice e.g. `/api/home/widgets` **or** `/api/dataset/lateral/p-roles` — pick one in Stage 5, not both unless trivial |
| 6 | Minimal Vite/React shell | login or home against Express `/api` |
| 7 | Remaining read APIs | still thin adapters |
| 8 | Dashboard pages | move UI, not services |
| 9 | Gmail / Drive / OAuth | keep callback path |
| 10 | Pipeline / Excel / scheduler | **move** pipeline; start cron from `index.ts` |
| 11 | Executive | same pattern |
| 12 | Remove legacy | dead scripts, unused deps, duplicate P-Roles modules **after** grep proves unused |
| 13 | Remove Next.js | only after replacements verified |
| 14 | Local full regression | |
| 15 | Isolated VPS test | no production compose swap |
| 16 | Production cutover | explicit approval |

---

## 12. Rollback

Until Stage 16 is approved:

- Next.js `src/` remains available
- `node-test` stays isolated
- `phase9-unified` and `origin/prod` untouched
- Do not delete old implementations before the new path is verified

---

## 13. What stays untouched during Stage 1 (this freeze)

Entire application except this document:

- `src/app/`, `src/components/`, `src/hooks/`, `src/providers/`, `src/stores/`
- `src/services/`, `src/lib/`
- `src/middleware.ts`, `src/instrumentation.ts`, `src/instrumentation.node.ts`
- `db/migrations/`, `scripts/`
- `Dockerfile`, `docker-compose.yml`, `docker-entrypoint.sh`
- `.env*`, `package.json`
- No `frontend/`, no `backend/`

---

## 14. Stage 2 preview (do not execute until approved)

When approved, Stage 2 should:

1. Add **only** a minimal Express app (e.g. `backend/src/index.ts` + `/api/health`).
2. **Not** copy `src/services` or `src/lib`.
3. **Not** start a second scheduler.
4. Leave Next.js fully runnable.

PostgreSQL wiring is **Stage 3**, unless Stage 2 health is process-only (preferred).

---

## 15. No-duplication check (Stage 1 completion)

| Check | Result |
|-------|--------|
| Duplicate services tree | **Not created** |
| Duplicate DB layer | **Not created** |
| Duplicate auth | **Not created** |
| Duplicate pipeline / P-Roles / Excel | **Not created** |
| Accidental `frontend/` or `backend/` | **Absent** |

---

## 16. References

- [nextjs-to-nodejs-migration-audit.md](./nextjs-to-nodejs-migration-audit.md) — inventory, APIs, pipelines, risks
- [phase13-postgres-persistence.md](./phase13-postgres-persistence.md) — persistence mode
- `src/lib/auth/session.ts`, `src/lib/auth/access.ts`
- `src/lib/persistence/db-client.ts`, `db/migrations/`
- `src/services/lateral-processing/pipeline.ts`
)
