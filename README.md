# ARA Dashboard

Enterprise analytics dashboard for ARA Resources.

## Stack

- Next.js (App Router) + TypeScript
- Tailwind CSS v4 + shadcn/ui
- Zustand · React Query · Framer Motion · ExcelJS · Recharts · TanStack Table

## Getting started

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) — redirects to `/overview`.

## Excel sources

Place master workbooks in `data/excel/` using the stable filenames:

| Business unit | File | Primary sheet |
|---------------|------|---------------|
| Lateral | `lateral-mastersheet.xlsm` | `P-Roles` |
| Executive | `executive-mastersheet.xlsm` | `P - Dashboard` |
| Consulting | `consulting-demand.xlsx` | `Sheet1` |

Replace a file in place to update data. Do not rename registry keys unless remapping intentionally.

## Architecture

```
src/
  app/                 # routes
  components/          # ui, layouts, sidebar, navbar, dashboard, tables, charts, filters
  constants/           # colors, routes, sidebar, business-unit registry
  services/excel/      # Excel I/O only
  stores/              # zustand (sidebar, filters, search)
  hooks/ utils/ types/ animations/ providers/
data/excel/            # master workbooks
public/assets/         # ARA logo
```

Dashboard data features are intentionally not implemented yet — architecture only.
