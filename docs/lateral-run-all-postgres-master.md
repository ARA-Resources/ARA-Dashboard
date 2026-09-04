# Lateral Run All — Postgres Master path (status + posted)

## What changed
- **Job Status**: New Sheet JRs are reconciled against PostgreSQL `lateral_master` using existing rules (`New` / `Reopen` / `Active` / `Closed`). Results are written to Postgres. XLSM Column K is still updated for Drive workbook compatibility; **dashboard Master Sheet uses Postgres only**.
- **Posted**: Continues to match Posted Sheet JRs against Postgres and update `posted` (`Yes` | `-`). Empty Posted list remains a safe no-op. Excel Column M is a secondary compatibility write.
- **New Sheet / Gmail keywords**: unchanged.
- **P-Roles**: unchanged this phase (TODO in pipeline step 19 for later).

## Notifications
Manual and scheduled Run All both call `pushAppNotification` with trigger, source file, Adhoc DS date (email `receivedAt` as DD-MM-YYYY), status counts, and href to Master Sheet on success (Dataset Lateral on failure).

## Master Sheet banner
Last Run All summary is stored on `lateral_scheduler_state.last_run_summary` (migration 005) and shown on the Master Sheet page (Success / Failed / Partial + Adhoc DS date).

## How to test
1. Migrate: `docker exec -it ara-dashboard-prod sh -c 'node scripts/db-migrate.mjs'`
2. Rebuild/restart: `docker compose up -d --build`
3. Dataset → Lateral → **Run All** (manual).
4. Check navbar bell: success/failure notification with Adhoc DS date.
5. Demands → Accenture → Lateral → Master Sheet: banner shows last run + Adhoc DS date; Refresh reloads Postgres rows.
6. DB checks:
   ```sql
   SELECT job_status, COUNT(*) FROM lateral_master GROUP BY 1;
   SELECT posted, COUNT(*) FROM lateral_master GROUP BY 1;
   SELECT last_run_status, last_run_summary FROM lateral_scheduler_state;
   ```
7. Confirm keywords / New Sheet paste still work; P-Roles UI still loads as before.
