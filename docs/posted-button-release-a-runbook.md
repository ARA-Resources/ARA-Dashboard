# Release A deploy runbook — Posted button (writes OFF)

All commands assume `/root/ARA-Dashboard-prod` on the prod host. Nothing in
this document has been run. Real compose service name: `ara-dashboard`
(container_name `ara-dashboard-prod`), confirmed from `docker-compose.yml`.

## 0. Git checks

```bash
cd /root/ARA-Dashboard-prod
git branch --show-current
git log --oneline -3
git status --short
git show --stat --oneline -1
```
Expect: branch `prod`, the posted-button commit as the newest, a clean tree,
and the stat showing only the expected posted-button files. Stop if not.

## 1. Pre-checks — all three must return ZERO rows

Run via the prod container itself (it already has `POSTGRES_URL` set; this
avoids retyping the connection string anywhere):

```bash
# 1a. Advisory locks. pg_advisory_lock(bigint) splits the 64-bit key into
# pg_locks.classid (high 32 bits) + objid (low 32 bits) — comparing objid
# alone can NEVER match any of these three keys, since all three exceed
# 2^32 (4294967296) and so always have a nonzero classid. Reconstruct the
# original key instead:
docker exec ara-dashboard-prod sh -c 'psql "$POSTGRES_URL" -c "SELECT ((classid::bigint << 32) | objid::bigint) AS lock_key, pid, granted FROM pg_locks WHERE locktype='"'"'advisory'"'"';"'
# Keys: 7482910234 = Lateral job, 7482910249 = Executive job,
# 7482910263 = candidate purge job. Any row = one of those is mid-flight —
# wait for it, don't deploy over it.

# 1b. No Oorwin upload/replay mid-flight.
docker exec ara-dashboard-prod sh -c 'psql "$POSTGRES_URL" -c "SELECT id, kind, started_at FROM candidate_sync_history WHERE finished_at IS NULL;"'

# 1c. No active query touching candidate_sync_changes (pid/state/duration only — never the query text, it can carry candidate data).
# Excludes pg_backend_pid() so the check doesn't match its own psql session.
docker exec ara-dashboard-prod sh -c 'psql "$POSTGRES_URL" -c "SELECT pid, state, now() - query_start AS running_for FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND query ILIKE '"'"'%candidate_sync_changes%'"'"' AND state <> '"'"'idle'"'"';"'
```

## 2. Record the current container and image

```bash
docker ps --filter name=ara-dashboard-prod --format '{{.ID}} {{.Image}} {{.Status}}'
docker inspect ara-dashboard-prod --format 'ContainerID={{.Id}}  ImageID={{.Image}}'
docker images localhost/ara-dashboard-prod_ara-dashboard
```
Real image name (confirmed): `localhost/ara-dashboard-prod_ara-dashboard:latest`.
Tripwire: the container ID changes at every deploy — always take it fresh
from the `docker ps` above, never reuse an old one from memory or notes.

## 3. Rollback tag

```bash
docker tag localhost/ara-dashboard-prod_ara-dashboard:latest \
  localhost/ara-dashboard-prod_ara-dashboard:pre-posted-button-20261009
# use today's real date, not the one above — matches this repo's existing
# convention (pre-row-scope-20261007, pre-history-tiles-20261007 already exist)
```

## 4. Backup (holds candidate data — handle like any other PII dump)

First confirm pg_dump exists in the container — confirmed present, version
18.6, directly in the live container by the user:
```bash
docker exec ara-dashboard-prod pg_dump --version
```
If that errors or prints nothing, STOP — do not proceed with the backup
step below until you know why.

```bash
df -h /root   # confirm there's room for the dump before writing it
mkdir -p /root/posted-button-backups && chmod 700 /root/posted-button-backups
( umask 077
  docker exec ara-dashboard-prod sh -c 'pg_dump -Fc "$POSTGRES_URL"' \
    > /root/posted-button-backups/pre-posted-button-20261009.dump )
# Confirm it's real before trusting it:
head -c 5 /root/posted-button-backups/pre-posted-button-20261009.dump; echo   # expect PGDMP
ls -la /root/posted-button-backups/pre-posted-button-20261009.dump   # non-empty
docker exec -i ara-dashboard-prod pg_restore -l < /root/posted-button-backups/pre-posted-button-20261009.dump | head
# ^ not checked — `docker exec -i` pipes the dump into the container's stdin, needed since pg_restore -l reads from a file/stdin, not a shell variable.
```
This dump contains candidate data. Delete it by its exact name
(`/root/posted-button-backups/pre-posted-button-20261009.dump`) once the
release is confirmed good — don't leave it sitting around.

## 5. Confirm `ARA_POSTED_FAKE_DRIVE_DEMO` and `ARA_POSTED_WRITES_ENABLED` are absent

```bash
grep -nE "ARA_POSTED_FAKE_DRIVE_DEMO|ARA_POSTED_WRITES_ENABLED" /root/ARA-Dashboard-prod/.env
grep -rnE "ARA_POSTED_FAKE_DRIVE_DEMO|ARA_POSTED_WRITES_ENABLED" /root/ARA-Dashboard-prod/docker-compose.yml
docker exec ara-dashboard-prod env | grep -E "ARA_POSTED_FAKE_DRIVE_DEMO|ARA_POSTED_WRITES_ENABLED"
```
Expect no output from all three. If anything prints, STOP.

## 6. Timing — do not deploy or click during these windows

- Not on a weekday between 10:00–14:00 IST unless step 1 is clean right
  before you start.
- Not around 03:00 IST — the candidate purge job runs then and holds its
  own advisory lock (7482910263).
- After deploy, avoid clicking Posted during the `:55`–`:05` minute window
  of any hour inside 10:00–14:00 IST — Posted holds the same per-dataset
  lock Run All does, and that window is when a scheduled Run All is most
  likely to be running (not independently re-verified against today's
  actual cron schedule — confirm the real schedule before relying on this).

## 7. Build and deploy

```bash
cd /root/ARA-Dashboard-prod
docker compose up -d --build
```
The site is down for about a minute during this rebuild+recreate — not
measured precisely here, a rough expectation to set, not a guarantee.

Migrations run automatically on every start — `docker-entrypoint.sh` runs
`node scripts/db-migrate.mjs`, which tracks applied versions in
`schema_migrations` and skips anything already applied. Migration 025 uses
`ADD COLUMN IF NOT EXISTS` and self-registers via
`INSERT ... ON CONFLICT (version) DO NOTHING` (db/migrations/025_posted_summary.sql)
— confirmed by reading both files, not by running them. No manual migration
step is needed.

## 8. Verify after deploy

```bash
docker ps --filter name=ara-dashboard-prod --format '{{.ID}} {{.Image}} {{.Status}}'
docker logs --since 10m ara-dashboard-prod 2>&1 | grep -i "025\|migrat"
docker logs --since 10m ara-dashboard-prod 2>&1 | grep -iE "error|posted-fake-drive-demo"
# Expect no error lines and NOT the "ARA_POSTED_FAKE_DRIVE_DEMO is ACTIVE" banner.

curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3000/login   # expect 200

# Confirm the new column actually landed (read-only, no candidate data):
docker exec ara-dashboard-prod sh -c 'psql "$POSTGRES_URL" -c "SELECT table_name, column_name FROM information_schema.columns WHERE column_name = '"'"'last_posted_summary'"'"' AND table_name IN ('"'"'lateral_scheduler_state'"'"','"'"'executive_scheduler_state'"'"');"'
# Expect both table names listed.
```
Then manually: log in as editor+, open /dataset/lateral and
/dataset/executive, click Posted on each, confirm "Preview only, writes are
off" with plausible counts.

Record the previewed counts (Yes, not posted, needs-a-look, blank/title rows
removed) from each result message, and compare the Yes count against what
the Master Sheet page currently shows for that dataset. In preview mode the
35% sharp-drop guard never runs (the preview branch returns before the guard
check) — so eyeball this comparison yourself; if the previewed Yes count
looks far below the Master Sheet's current count, treat that as a reason to
slow down before ever running Runbook 2, not an automated stop. If more than
a handful of rows come back "needs a look," send that list (JR IDs only,
never candidate data) to whoever should review it before proceeding.

After this check passes: `git push origin prod` (run by the user, not here).
At the next scheduled Run All, check that the Lateral and Executive banners
look the same as before this deploy — not independently re-verified, since
no Run All has happened yet.

## 9. Rollback (only if step 8 looks wrong)

```bash
docker tag localhost/ara-dashboard-prod_ara-dashboard:pre-posted-button-20261009 \
  localhost/ara-dashboard-prod_ara-dashboard:latest
docker compose up -d
```
No `--build`, no `docker compose down` — this just points `:latest` back at
the previous image and recreates the container from it. Migration 025 is
additive-only and does not need to be reversed.

---

# Runbook 2 — turning Posted writes ON (only after Release A has been live and reviewed)

1. Repeat the full pre-check from step 1 above.
2. Fresh backup, same method as step 4 above, new filename
   (`pre-posted-writes-<date>.dump`).
3. Make a Drive copy of each live master workbook (Drive UI → Make a copy) —
   manual, human action; cannot be scripted from a throwaway container.
4. Record the current container ID fresh (tripwire — it will change again
   after this step's recreate):
   ```bash
   docker ps --filter name=ara-dashboard-prod --format '{{.ID}}'
   ```
5. Enable the flag:
   ```bash
   cd /root/ARA-Dashboard-prod
   printf '\nARA_POSTED_WRITES_ENABLED=1\n' >> .env
   docker compose up -d --force-recreate ara-dashboard
   ```
   Then confirm it actually took effect before clicking anything:
   ```bash
   docker exec ara-dashboard-prod env | grep ARA_POSTED_WRITES_ENABLED   # expect ARA_POSTED_WRITES_ENABLED=1
   docker exec ara-dashboard-prod env | grep ARA_POSTED_FAKE_DRIVE_DEMO  # expect no output
   ```
6. **First click — Lateral only, not Executive.** Lateral's Posted write
   already has a direct precedent to compare against (Run All's own Step
   18 writes the same Yes/No convention to the same tab — proven
   byte-identical in both run orders during testing). Executive's Posted
   write has no such precedent; save it for after Lateral's first real
   click is confirmed correct.

   The result message must NOT say "Preview only" — if it does, the flag
   didn't take effect; stop and recheck step 5's env check before clicking
   again. If the result instead says the 35% sharp-drop guard refused, stop
   — do not click "Run anyway" without separately confirming the drop is
   expected (compare against the Master Sheet page, same as Release A step 8).

   Record the real counts from the result message the same way as Release A
   step 8 (Yes, not posted, needs-a-look), and send any sizeable needs-a-look
   list (JR IDs only) for review before touching Executive.
7. After that click:
   - Download the saved workbook from Drive and open it in Excel — confirm
     it still prompts to enable macros (not checked here — requires Excel
     and the real file, neither available in this environment).
   - Check Drive's version history shows a new version at the right time
     (not checked here — requires the live Drive UI).
   - Watch the next scheduled Run All's banner for both datasets, and the
     Posted Sheet tab, for anything unexpected (not checked here — requires
     a live scheduled run after this change).
   - Only then click Posted on Executive.
