/**
 * Short ops note — Lateral Master Sheet from local XLSX → Postgres.
 *
 * See also: scripts/import-lateral-master-from-xlsx.ts
 *
 * Commands (on VPS, from repo root):
 *
 *   docker compose up -d --build
 *   docker exec -it ara-dashboard-prod sh -c 'node scripts/db-migrate.mjs'
 *   docker exec -it ara-dashboard-prod sh -c 'npx tsx scripts/import-lateral-master-from-xlsx.ts --replace'
 *
 * Optional dry-run:
 *   docker exec -it ara-dashboard-prod sh -c 'npx tsx scripts/import-lateral-master-from-xlsx.ts --replace --dry-run'
 *
 * Env:
 *   POSTGRES_URL — target DB (container uses this for migrate/import/API)
 *   ARA_LATERAL_MASTER_SOURCE=postgres|drive  (default postgres)
 *
 * Normalization (CHECK only):
 *   job_status → New|Reopen|Active|Closed (case-canonicalized; blank→NULL)
 *   posted → Yes|- (yes→Yes; blank→NULL)
 *   Job Description stored exactly; Opened on Oorwin is free text
 */
