# ARA Dashboard

Internal recruitment-pipeline dashboard for ARA Resources, tracking Accenture
hiring (Lateral, Executive, Consulting).

> **Full project context:** see [`CLAUDE_PROJECT_CONTEXT.md`](./CLAUDE_PROJECT_CONTEXT.md).
> It is the accurate, current reference — this README is a short overview and
> `Documentation.md` is partly out of date.

## Stack

- Next.js 16 (App Router) + React 19 + TypeScript — serves UI **and** all `/api/*`
- Tailwind CSS v4 + shadcn/ui · Zustand · React Query · TanStack Table
- PostgreSQL via `postgres` (postgres.js), raw SQL, no ORM
- `exceljs` + Python `openpyxl` · `googleapis` (Gmail + Drive) · `node-cron`

## Production

Single Docker container (`docker-compose.yml`) running Next.js + an embedded
PostgreSQL. Deploy from the repo root on the VPS:

```bash
docker compose up -d --build
docker compose logs -f
```

Migrations run automatically on container start (`scripts/db-migrate.mjs`).

`backend/` and `worker/` are a **dormant** Next.js→Express migration and are not
built or run in production.

## Local development

```bash
npm install
npm run dev            # http://localhost:3000
```

Copy `.env.example` → `.env.local` and fill in values. Never commit real secrets.

## Data

- **Source of truth** for the Lateral dashboard: PostgreSQL `lateral_master`
  (`ARA_PERSISTENCE=postgres`, `ARA_LATERAL_MASTER_SOURCE=postgres`).
- Lateral **Run All** (Dataset → Lateral) pulls the latest ATCI DS from Gmail →
  Drive, runs a 25-step pipeline, writes `job_status` / `posted` to Postgres, and
  still refreshes the P-Roles pivot in the Drive Master XLSM.
- `data/excel/ATCI Lateral Master Data Updated.xlsx` is an import source only:
  `npm run db:import-lateral-master-xlsx -- --replace`.

## Business units

Lateral — production-complete. Executive — partial. Consulting — stub.
See `src/constants/companies.ts`.
