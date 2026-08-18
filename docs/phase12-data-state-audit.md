# Phase 12 — Persistent State Audit & Cloud Storage Design

> Audit-only. No production data was modified. No cloud resources created.

---

## 1. `.data/` Inventory

Total files: 89 (including sub-directories)

| Path | Size | Last Modified |
|------|------|---------------|
| `.data/app-notifications.json` | 14 KB | 2026-08-17 |
| `.data/dataset-drive-meta.enc.json` | 1.9 KB | 2026-08-18 |
| `.data/dataset-scheduler-state.json` | 78 B | 2026-08-18 |
| `.data/dataset-schedules.json` | 901 B | 2026-08-13 |
| `.data/dataset-setup.enc.json` | 2.9 KB | 2026-08-13 |
| `.data/gmail-oauth.enc.json` | 2.6 KB | 2026-08-18 |
| `.data/home-widgets-metrics.json` | 915 B | 2026-08-17 |
| `.data/lateral-data-processing-setup.enc.json` | 2.2 KB | 2026-08-13 |
| `.data/lateral-gmail-checkpoint.json` | 831 B | 2026-08-17 |
| `.data/lateral-p-roles-google-sheet.json` | 620 B | 2026-08-14 |
| `.data/lateral-reconcile-staging.enc.json` | 11.4 MB | 2026-08-18 |
| `.data/lateral-scheduler.json` | 1.0 KB | 2026-08-17 |
| `.data/lateral-source-drive-state.json` | 372 B | 2026-08-18 |
| `.data/lateral-sync-history.json` | 4.9 KB | 2026-08-17 |
| `.data/sync-history.json` | 9.4 KB | 2026-08-13 |
| `.data/sync-watermark.json` | 188 B | 2026-08-13 |
| `.data/vba_*.txt` (13 files) | <4 KB each | 2026-08-11 |
| `.data/datasets/current/Lateral/*.xlsm` | 16.6 MB | 2026-08-17 |
| `.data/datasets/current/Executive/*.xlsx` | 275 KB | 2026-08-08 |
| `.data/datasets/current/Consulting/*.xlsx` | 12 KB | 2026-08-06 |
| `.data/datasets/temp/Lateral/*.xlsx` | 4.1 MB | 2026-08-18 |
| `.data/excel-cache/*.xlsx / *.xlsm` (5 files) | 6–17 MB each | 2026-08-10–18 |
| `.data/excel-cache/drive-xlsm/*.xlsm + *.mtime` | 16.9 MB + 24 B | 2026-08-18 |
| `.data/lateral-reconcile-staging/*.xlsm` (2) | 10–17 MB each | 2026-08-18 |
| `.data/logs/*.jsonl` (12 files) | 0.5–39 KB each | 2026-08-08–18 |
| `.data/vba-inspect/` (17 files) | <19 KB each | 2026-08-13 |
| `.data/_inspect-main-xlsm/inspect_pivot.py` | 8.9 KB | 2026-08-17 |

---

## 2. Classification Table

| Path | Purpose | Read By | Written By | Class | Vercel Safe? | Recommended Replacement |
|------|---------|---------|------------|-------|-------------|-------------------------|
| `lateral-gmail-checkpoint.json` | Gmail deduplication cursor: last processed messageId/attachmentId/receivedAtMs | `lateral-gmail-checkpoint-store.ts` | `lateral-final-checkpoint.ts` (SUCCESS only) | **A — REQUIRED PERSISTENT STATE** | ❌ No | PostgreSQL row |
| `lateral-scheduler.json` | Lateral cron schedule, enabled/paused, lastRun, lastStatus | `lateral-scheduler.ts` | `lateral-scheduler.ts` | **A — REQUIRED PERSISTENT STATE** | ❌ No | PostgreSQL row |
| `lateral-source-drive-state.json` | Currently active source Drive file ID + pending cleanup IDs | `lateral-source-drive-state-store.ts` | `lateral-source-drive-state-store.ts` | **A — REQUIRED PERSISTENT STATE** | ❌ No | PostgreSQL row |
| `lateral-sync-history.json` | Per-run sync result log (up to 300 entries) | `lateral-sync-history-store.ts` | `lateral-sync-history-store.ts` | **A — REQUIRED PERSISTENT STATE** | ❌ No | PostgreSQL table |
| `gmail-oauth.enc.json` | Encrypted Google OAuth tokens (access + refresh) for Gmail + Drive | `gmail/oauth.ts` via `encrypted-json-store.ts` | `gmail/oauth.ts` | **E — SECRET / ENCRYPTED CREDENTIAL STATE** | ❌ No | Encrypted PostgreSQL row / Vercel KV / secrets manager |
| `dataset-setup.enc.json` | Encrypted multi-dataset configuration (Drive folder IDs, Gmail settings) | `dataset/secure-store.ts` | `dataset/secure-store.ts` | **E — SECRET / ENCRYPTED CREDENTIAL STATE** | ❌ No | Encrypted PostgreSQL row |
| `lateral-data-processing-setup.enc.json` | Encrypted Lateral processing config (master workbook ID, pipeline settings) | `lateral-processing/setup-store.ts` | `lateral-processing/setup-store.ts` | **E — SECRET / ENCRYPTED CREDENTIAL STATE** | ❌ No | Encrypted PostgreSQL row |
| `dataset-drive-meta.enc.json` | Encrypted Drive file metadata per dataset | `drive/metadata-store.ts` | `drive/metadata-store.ts` | **E — SECRET / ENCRYPTED CREDENTIAL STATE** | ❌ No | Encrypted PostgreSQL row |
| `lateral-reconcile-staging.enc.json` | Encrypted staging XLSM binary during pipeline (11 MB) | `lateral-master-drive-update.ts`, `master-reconcile.ts` | Pipeline | **B — TEMPORARY PROCESSING DATA** | ❌ No | Ephemeral temp in cloud function, final state to Drive |
| `dataset-scheduler-state.json` | Legacy multi-dataset scheduler paused/timezone state | `dataset/scheduler.ts` | `dataset/scheduler.ts` | **A — REQUIRED PERSISTENT STATE** | ❌ No | PostgreSQL row |
| `dataset-schedules.json` | Per-dataset cron schedule definitions (up to N schedules) | `dataset/schedules-store.ts` | `dataset/schedules-store.ts` | **A — REQUIRED PERSISTENT STATE** | ❌ No | PostgreSQL table |
| `app-notifications.json` | In-app notifications (50 max, UI-only) | `dataset/notifications-store.ts` | Throughout pipeline | **A — REQUIRED PERSISTENT STATE** | ❌ No | PostgreSQL table |
| `home-widgets-metrics.json` | Cached totals/active/posted/fresh per BU (regeneratable from Master) | `home/home-widgets-metrics-store.ts` | Pipeline, `refresh-lateral-home-widgets-metrics.ts` | **C — CACHE / REGENERATABLE** | ❌ No | PostgreSQL row (or re-compute on demand) |
| `lateral-p-roles-google-sheet.json` | Google Spreadsheet ID hosting P-Roles pivot | `lateral-p-roles-sheets-pivot.ts`, `read-lateral-p-roles-from-google.ts` | `lateral-p-roles-sheets-pivot.ts` | **A — REQUIRED PERSISTENT STATE** | ❌ No | PostgreSQL row |
| `sync-history.json` | Legacy multi-dataset sync run history (500 max) | `dataset/sync-history-store.ts` | `dataset/sync-history-store.ts` | **A — REQUIRED PERSISTENT STATE** | ❌ No | PostgreSQL table |
| `sync-watermark.json` | Timestamp of last successful automated sync | `dataset/sync-watermark-store.ts` | `dataset/sync-watermark-store.ts` | **A — REQUIRED PERSISTENT STATE** | ❌ No | PostgreSQL row |
| `sender-stats.json` *(not yet observed on disk, written by `sender-stats-store.ts`)* | Gmail sender email statistics | `dataset/sender-stats-store.ts` | `dataset/sender-stats-store.ts` | **A — REQUIRED PERSISTENT STATE** | ❌ No | PostgreSQL table |
| `datasets/current/Lateral/*.xlsm` | Current Lateral Master XLSM snapshot (16 MB) | `dataset/resolve-current.ts`, `excel/reader.ts` | `dataset/sync-download.ts` | **C — CACHE / REGENERATABLE** | ❌ No | Google Drive (source of truth); re-download on cold start |
| `datasets/current/Executive/*.xlsx` | Current Executive dataset snapshot | Same readers | Same writers | **C — CACHE / REGENERATABLE** | ❌ No | Google Drive |
| `datasets/current/Consulting/*.xlsx` | Current Consulting dataset snapshot | Same readers | Same writers | **C — CACHE / REGENERATABLE** | ❌ No | Google Drive |
| `datasets/temp/Lateral/*.xlsx` | Temporary Gmail attachment during active processing | `lateral-gmail-incremental-sync.ts` | `lateral-gmail-incremental-sync.ts` | **B — TEMPORARY PROCESSING DATA** | Partially | Ephemeral `/tmp` in cloud function |
| `excel-cache/*.xlsx / *.xlsm` | ExcelJS read-optimized copies of source files | `excel/readable-workbook.ts` | `excel/readable-workbook.ts` | **C — CACHE / REGENERATABLE** | ❌ No | Ephemeral per-request re-download; or Vercel Blob with TTL |
| `excel-cache/drive-xlsm/*.xlsm` | Cached Drive XLSM binary (local copy to avoid repeat downloads) | `read-lateral-master-from-drive-xlsm.ts` | `read-lateral-master-from-drive-xlsm.ts` | **C — CACHE / REGENERATABLE** | ❌ No | Re-download from Drive per invocation; or Vercel Blob |
| `lateral-reconcile-staging/*.xlsm` | In-progress staged workbook during Run All | `pipeline.ts`, `master-reconcile.ts` | `pipeline.ts` | **B — TEMPORARY PROCESSING DATA** | ❌ No | Ephemeral in cloud function; must complete within one invocation |
| `logs/*.jsonl` | Operational/debug JSONL logs per day | `lateral-job.ts`, scheduler, pipeline | Various services | **D — LOG** | ❌ No | Vercel/cloud logging (stdout → Vercel log drain, Datadog, or similar) |
| `vba_*.bas.txt / vba_*.cls.txt` (13) | Extracted VBA source code from workbook inspection | Manual inspection only | VBA inspection scripts | **F — TEST / INSPECTION ARTIFACT** | N/A | Not needed on Vercel |
| `vba-inspect/` (17 files) | Detailed VBA extraction per workbook | Manual only | VBA inspection | **F — TEST / INSPECTION ARTIFACT** | N/A | Not needed on Vercel |
| `_inspect-main-xlsm/inspect_pivot.py` | One-time Python inspection script | Manual only | Manual | **F — TEST / INSPECTION ARTIFACT** | N/A | Not needed on Vercel |

---

## 3. Gmail Checkpoint — Critical Detail

**File:** `.data/lateral-gmail-checkpoint.json`

**Structure:**
```json
{
  "version": 1,
  "messageId": "<Gmail message ID>",
  "attachmentId": "<Gmail attachment ID>",
  "receivedAt": "<ISO timestamp>",
  "receivedAtMs": 1786961228000,
  "attachmentFilename": "<filename.xlsx>",
  "driveFileId": "<Google Drive file ID>",
  "processedAt": "<ISO timestamp>",
  "processingResult": "SUCCESS",
  "updatedAt": "<ISO timestamp>"
}
```

**How checkpoint advances:**
- Written ONLY when `processingResult === "SUCCESS"`.
- Never written on any pipeline failure — failed runs leave checkpoint unchanged.
- Written by `advanceFinalLateralGmailCheckpoint()` in `lateral-final-checkpoint.ts`, called after Drive upload succeeds.
- Cursor logic: new email must have `receivedAtMs > checkpoint.receivedAtMs`, or same ms + later `messageId` + later `attachmentId`.

**Duplicate prevention:**
- `isAfterLateralGmailCheckpoint()` compares candidate vs stored cursor — rejects re-processing of same or older messages.
- Since the file is local, concurrent processes on Vercel (multiple instances) could read the same stale checkpoint and both attempt the same email. **This is a concurrency race condition on Vercel.**

**Vercel impact:** CRITICAL — must be migrated to a database with atomic compare-and-swap update before Vercel deployment.

---

## 4. Gmail OAuth State

**File:** `.data/gmail-oauth.enc.json`

**Encryption:** AES-256-GCM. Key derived via SHA-256 from `ARA_DATASET_SETUP_SECRET`. IV + auth tag + ciphertext stored in JSON envelope.

**Stored fields (encrypted, never logged):**
- `access_token` (short-lived)
- `refresh_token` (long-lived, critical)
- `expiry_date`
- `token_type`
- `scope`
- Email/account identity

**Read/write flow:**
- Read: every Gmail/Drive API call via `getAuthorizedGmailClient()` → `readEncryptedJson("gmail-oauth.enc.json")`.
- Token refresh: `googleapis` library auto-refreshes; updated tokens written back via `writeEncryptedJson`.
- No multi-account support currently — single shared OAuth identity.

**Cloud requirement:** must store in server-side encrypted persistent store. Never expose to client. Must preserve AES-256-GCM envelope or use equivalent secrets manager.

---

## 5. Scheduler State

**File:** `.data/lateral-scheduler.json`

**Current architecture:**
```
Next.js server (always-on process)
  └── node-cron (in-process timer)
        └── lateral-scheduler.ts (reads/writes lateral-scheduler.json)
              └── executeLateralDatasetJob()
```

**In-memory state:**
- `running: boolean` — in-process mutex preventing overlap.
- `bootstrapped: boolean` — ensures cron starts once per process.

**Vercel impact:**
- `node-cron` requires a persistent long-running process — incompatible with serverless functions which terminate after each request.
- `running` flag is in-memory and not shared across instances — concurrent Vercel invocations can both start a Run All.
- Must migrate to **Vercel Cron + database job lock** before Vercel deployment.

---

## 6. Home Metrics

**File:** `.data/home-widgets-metrics.json`

**Classification:** Cache. Regeneratable from Master Sheet (Drive XLSM). Written by pipeline on success; read by `/api/home/widgets`.

**Vercel:** Could re-compute on each request (costly), cache in PostgreSQL row (cheap), or use Vercel Cache headers. Recommend PostgreSQL row with `updatedAt`; invalidate on successful pipeline run.

---

## 7. Dataset Current / History

| Path | Contents | Classification | Cloud Target |
|------|----------|----------------|-------------|
| `datasets/current/Lateral/*.xlsm` | Latest Master XLSM copy | C — Cache | Re-download from Google Drive; ephemeral during processing |
| `datasets/current/Executive/*.xlsx` | Latest Executive dataset | C — Cache | Re-download from Drive |
| `datasets/current/Consulting/*.xlsx` | Latest Consulting dataset | C — Cache | Re-download from Drive |
| `datasets/temp/Lateral/*.xlsx` | Gmail attachment during active processing | B — Temporary | Ephemeral `/tmp` in cloud function |

---

## 8. Excel Files

| Location | Role | Owner | Cloud Target |
|----------|------|-------|-------------|
| Google Drive (XLSM Master) | Production Master workbook | Google Drive | Stays in Drive — do not migrate |
| `.data/datasets/current/*.xlsm` | Local cached copy | App | Ephemeral — re-download each session |
| `.data/excel-cache/*.xlsx` | ExcelJS-parseable copy | App | Ephemeral — re-create each request |
| `.data/excel-cache/drive-xlsm/*.xlsm` | Cached Drive download | App | Ephemeral — or short-TTL Vercel Blob |
| `.data/lateral-reconcile-staging/*.xlsm` | Staging workbook during Run All | App | Ephemeral — must complete within single invocation |
| `.data/datasets/temp/*.xlsx` | Gmail attachment temp file | App | Ephemeral `/tmp` |

**Critical:** Vercel serverless functions have a **512 MB ephemeral `/tmp`** per invocation. A 17 MB XLSM fits, but the pipeline must complete within a single function invocation (currently ~500 s for Run All — exceeds default Vercel timeout of 60 s). Vercel Pro/Enterprise allows up to 300 s. **Run All pipeline requires background job architecture.**

---

## 9. Logs

| Log file pattern | Type | Recommendation |
|-----------------|------|----------------|
| `lateral-gmail-*.jsonl` | Operational — Gmail sync details | Stdout → Vercel log drain |
| `lateral-pipeline-*.jsonl` | Audit — per pipeline step | PostgreSQL `pipeline_run_steps` table or Vercel log drain |
| `lateral-job-*.jsonl` | Operational — job start/fail | Stdout → Vercel log drain |
| `lateral-scheduler-*.jsonl` | Operational — cron ticks | Stdout → Vercel log drain |
| `dataset-sync-*.jsonl` | Operational — multi-dataset sync | Stdout → Vercel log drain |

---

## 10. Vercel-Incompatible Persistent File State

Files written in one request and expected to persist for a later request — **VERCEL-INCOMPATIBLE**:

| File | Written by | Read by | Risk |
|------|-----------|---------|------|
| `lateral-gmail-checkpoint.json` | `advanceFinalLateralGmailCheckpoint` | `lateral-gmail-incremental-sync` | **CRITICAL** — concurrency race; deduplication failure |
| `gmail-oauth.enc.json` | `oauth.ts` token refresh | Every API call | **HIGH** — refresh tokens lost between instances |
| `lateral-scheduler.json` | `lateral-scheduler.ts` | `lateral-scheduler.ts` | **HIGH** — cron won't work; state lost between invocations |
| `dataset-schedules.json` | `schedules-store.ts` | `schedules-store.ts` | **HIGH** |
| `dataset-setup.enc.json` | `secure-store.ts` | Throughout | **HIGH** |
| `lateral-data-processing-setup.enc.json` | `setup-store.ts` | Throughout | **HIGH** |
| `lateral-sync-history.json` | `lateral-sync-history-store.ts` | Dashboard UI | **MEDIUM** |
| `home-widgets-metrics.json` | Pipeline success | `/api/home/widgets` | **MEDIUM** |
| `app-notifications.json` | Various pipeline stages | Dashboard UI | **MEDIUM** |
| `sync-watermark.json` | Sync completion | Scheduler logic | **MEDIUM** |
| `lateral-source-drive-state.json` | `lateral-source-drive-state-store.ts` | Drive cleanup logic | **MEDIUM** |
| `lateral-p-roles-google-sheet.json` | `lateral-p-roles-sheets-pivot.ts` | Dashboard | **MEDIUM** |
| `datasets/current/*.xlsm` | `sync-download.ts` | `reader.ts`, `reader-from-drive.ts` | **HIGH** — cold start will have no file |
| `excel-cache/drive-xlsm/*.xlsm` | `read-lateral-master-from-drive-xlsm.ts` | Same | **HIGH** — cache miss on every cold start |

---

## 11. Filesystem Usage in `src/` — Full Report

| File | Dependency | Persistent? | Vercel Safe? | Migration Needed? |
|------|-----------|-------------|-------------|------------------|
| `services/dataset/encrypted-json-store.ts` | `fs/promises`, `path`, `process.cwd()` | Yes | ❌ | Yes — replace with DB-backed encrypted store |
| `services/dataset/scheduler.ts` | `fs/promises`, `path` | Yes | ❌ | Yes — DB + Vercel Cron |
| `services/lateral-processing/lateral-scheduler.ts` | `fs/promises`, `path`, `node-cron` | Yes | ❌ | Yes — DB + Vercel Cron |
| `services/lateral-processing/lateral-gmail-checkpoint-store.ts` | `fs/promises`, `path` | Yes | ❌ | **Critical** — PostgreSQL |
| `services/home/home-widgets-metrics-store.ts` | `fs/promises`, `path` | Cache | ❌ | Yes — PostgreSQL row |
| `services/lateral-processing/lateral-sync-history-store.ts` | `fs/promises`, `path` | Yes | ❌ | Yes — PostgreSQL table |
| `services/lateral-processing/lateral-source-drive-state-store.ts` | `fs/promises`, `path` | Yes | ❌ | Yes — PostgreSQL row |
| `services/lateral-processing/setup-store.ts` | via `encrypted-json-store` | Yes | ❌ | Yes |
| `services/dataset/secure-store.ts` | via `encrypted-json-store` | Yes | ❌ | Yes |
| `services/drive/metadata-store.ts` | via `encrypted-json-store` | Yes | ❌ | Yes |
| `services/dataset/schedules-store.ts` | `fs/promises`, `path` | Yes | ❌ | Yes — PostgreSQL |
| `services/dataset/sync-history-store.ts` | `fs/promises`, `path` | Yes | ❌ | Yes — PostgreSQL |
| `services/dataset/sync-watermark-store.ts` | `fs/promises`, `path` | Yes | ❌ | Yes — PostgreSQL row |
| `services/dataset/notifications-store.ts` | `fs/promises`, `path` | Yes | ❌ | Yes — PostgreSQL |
| `services/dataset/sender-stats-store.ts` | `fs/promises`, `path` | Yes | ❌ | Yes — PostgreSQL |
| `services/lateral-processing/lateral-p-roles-sheets-pivot.ts` | `fs/promises`, `path`, `.data/` | Yes | ❌ | Yes — PostgreSQL row |
| `services/lateral-processing/lateral-google-p-roles-native.ts` | `fs/promises`, `path`, `.data/` | Yes | ❌ | Yes — PostgreSQL row |
| `services/excel/read-lateral-master-from-drive-xlsm.ts` | `fs/promises`, `path`, `.data/excel-cache` | Cache | ❌ | Ephemeral re-download or Vercel Blob |
| `services/excel/lateral-reference-workbook.ts` | `fs/promises`, `path` | Cache | ❌ | Ephemeral re-download |
| `services/excel/readable-workbook.ts` | `fs/promises`, `path` | Cache | ❌ | Ephemeral |
| `services/dataset/seed-current.ts` | `fs/promises`, `path` | Cache | ❌ | Ephemeral |
| `services/dataset/sync-download.ts` | `fs/promises`, `path` | Cache | ❌ | Re-download from Drive |
| `services/dataset/versions.ts` | `fs/promises`, `path` | Cache | ❌ | Re-download or Vercel Blob |
| `services/dataset/resolve-current.ts` | `fs/promises`, `path` | Cache | ❌ | Re-download |
| `services/lateral-processing/lateral-master-drive-update.ts` | `fs/promises`, `path` | Temp | ⚠️ Single invocation | Ephemeral `/tmp` |
| `services/lateral-processing/pipeline.ts` | `fs/promises`, `path` | Temp | ❌ (long-running) | Background job architecture |
| `services/lateral-processing/master-reconcile.ts` | `fs/promises`, `path` | Temp | ❌ (long-running) | Background job |
| `services/lateral-processing/new-sheet-writer.ts` | `fs/promises`, `path` | Temp | ❌ | Background job |
| `services/lateral-processing/lateral-posted-sheet-processor.ts` | `fs/promises`, `execFile`, `path` | Temp | ❌ (Windows) | Background job on Windows host |
| `services/lateral-processing/lateral-p-roles-pivot-refresh.ts` | `fs/promises`, `execFile`, `path` | Temp | ❌ (Windows) | Windows host only |
| `services/lateral-processing/run-vba-macro.ts` | `fs/promises`, `execFile`, `path` | Temp | ❌ (Windows) | Windows host only |
| `services/lateral-processing/lateral-job-requisition-comparison.ts` | `fs/promises`, `execFile`, `path` | Temp | ❌ (Windows) | Background job |
| `services/lateral-processing/lateral-gmail-incremental-sync.ts` | `fs/promises`, `path` | Temp | ❌ | Background job |
| `services/lateral-processing/lateral-drive-upload.ts` | `fs/promises`, `path` | Temp | ❌ | Background job |
| `services/lateral-processing/data-reader.ts` | `fs/promises` | Temp | ❌ | Background job |
| `services/lateral-processing/lateral-new-sheet-structure.ts` | `fs/promises` | Temp | ❌ | Background job |
| `services/lateral-processing/lateral-final-master-save-inspect.ts` | `fs/promises` | Temp | ❌ | Background job |
| `services/lateral-processing/lateral-source-workbook.ts` | `fs/promises` | Temp | ❌ | Background job |
| `services/drive/upload.ts` | `createReadStream`, `fs` | Temp | ⚠️ | Must use Buffer/stream from memory |
| `services/gmail/oauth.ts` | via `encrypted-json-store` | Yes | ❌ | DB-backed encrypted store |
| `lib/config/runtime.ts` | `process.env`, no fs | No | ✅ | None |
| `app/api/dataset/lateral-processing/execute/route.ts` | `fs/promises` (logging) | Log | ❌ | Stdout |

---

## 12. Concurrency Risks on Vercel

| Risk | Location | Current Protection | Vercel Risk |
|------|---------|--------------------|------------|
| Duplicate Gmail processing | `lateral-gmail-checkpoint-store.ts` | Single-process; file read before check | **CRITICAL** — two instances read same stale checkpoint |
| Duplicate Run All | `lateral-scheduler.ts` `running` flag | In-memory boolean | **CRITICAL** — each instance has own memory |
| Token refresh race | `gmail/oauth.ts` | googleapis handles single-process | **HIGH** — concurrent refresh can invalidate tokens |
| Scheduler double-fire | `node-cron` in `lateral-scheduler.ts` | Single process; in-process task registry | **CRITICAL** — Vercel spawns multiple instances |
| Home metrics partial write | `home-widgets-metrics-store.ts` atomic rename | Atomic on Windows | **LOW** — `/tmp` is per-instance; no conflict but stale reads |
| Staged XLSM overwrite | `.data/lateral-reconcile-staging/` | Filename includes run UUID | **MEDIUM** — if two runs share ephemeral filesystem |

---

## 13. Recommended Cloud Architecture

### A — Required Persistent State → PostgreSQL (Neon/Vercel Postgres)

| Current | Future | Reason |
|---------|--------|--------|
| `lateral-gmail-checkpoint.json` | `gmail_checkpoint` table (1 row) | Atomic CAS update; prevents duplicate processing across instances |
| `lateral-scheduler.json` | `lateral_scheduler_state` table (1 row) | Must survive instance restart; drives Vercel Cron behavior |
| `dataset-schedules.json` | `dataset_schedules` table | Structured schedule definitions |
| `dataset-scheduler-state.json` | `dataset_scheduler_state` table | Global paused/timezone |
| `lateral-sync-history.json` | `lateral_sync_history` table | Append-only audit log |
| `sync-history.json` | `dataset_sync_history` table | Append-only audit log |
| `sync-watermark.json` | `sync_watermark` table (1 row) | Atomic update after sync |
| `lateral-source-drive-state.json` | `lateral_source_drive_state` table (1 row) | Drive cleanup tracking |
| `lateral-p-roles-google-sheet.json` | `app_config` table (keyed entry) | Spreadsheet ID reference |
| `app-notifications.json` | `app_notifications` table | Queryable; multi-instance shared view |
| `home-widgets-metrics.json` | `home_metrics` table (one row per BU) | Fast reads; invalidated on pipeline success |
| `sender-stats.json` | `sender_stats` table | Per-sender tracking |

### B — Secrets/Encrypted State → PostgreSQL with column-level encryption

| Current | Future | Reason |
|---------|--------|--------|
| `gmail-oauth.enc.json` | `oauth_tokens` table (encrypted columns) | Must survive restarts; single shared Google identity |
| `dataset-setup.enc.json` | `app_config` table (encrypted value column) | Team configuration |
| `lateral-data-processing-setup.enc.json` | `app_config` table (encrypted value column) | Lateral processing config |
| `dataset-drive-meta.enc.json` | `dataset_drive_meta` table (encrypted) | Drive metadata |

Encryption: retain AES-256-GCM envelope identical to current `encrypted-json-store.ts`. Key source: `ARA_DATASET_SETUP_SECRET` env var (already required in production).

### C — Cache → Ephemeral + Optional Short-TTL Vercel Blob

| Current | Future | Reason |
|---------|--------|--------|
| `datasets/current/*.xlsm` | Re-download from Drive per pipeline run | ~17 MB fits in `/tmp`; Drive is source of truth |
| `excel-cache/*.xlsx` | Ephemeral per-request re-parse | No persistent cache needed at this scale |
| `excel-cache/drive-xlsm/*.xlsm` | Ephemeral re-download or Vercel Blob (TTL 1 hour) | Avoid repeat 17 MB downloads per warm function |

### D — Logs → Cloud Logging (zero code changes required)

Next.js on Vercel writes stdout to Vercel's log system. Replace `fs.appendFile` log writes with `console.log` / `console.error` JSON output. All existing JSONL log structure is already JSON-formatted. No code restructuring needed beyond replacing `fs.appendFile` with `console.log`.

### E — Temporary Processing → Ephemeral `/tmp`

| Current | Future |
|---------|--------|
| `datasets/temp/*.xlsx` | `/tmp/<uuid>.xlsx` — already scoped per run |
| `lateral-reconcile-staging/*.xlsm` | `/tmp/<uuid>.xlsm` — already scoped by run UUID |
| Python/openpyxl scripts | Remain on Windows host; blocked from Vercel by design |

### F — Inspection Artifacts → Not deployed

VBA inspect files, `_inspect-main-xlsm/inspect_pivot.py` — stay in `.gitignore`, never deployed.

---

## 14. Proposed Database Schema (Minimal)

```sql
-- Gmail deduplication (CRITICAL)
CREATE TABLE gmail_checkpoint (
  id               SERIAL PRIMARY KEY,
  account_email    TEXT NOT NULL DEFAULT 'default',
  message_id       TEXT,
  attachment_id    TEXT,
  received_at      TIMESTAMPTZ,
  received_at_ms   BIGINT,
  attachment_file  TEXT,
  drive_file_id    TEXT,
  processed_at     TIMESTAMPTZ,
  result           TEXT CHECK (result IN ('SUCCESS', NULL)),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_email)
);

-- Lateral scheduler configuration
CREATE TABLE lateral_scheduler_state (
  id               SERIAL PRIMARY KEY,
  frequency        TEXT NOT NULL DEFAULT 'daily',
  sync_time        TEXT NOT NULL DEFAULT '07:00',
  day_of_week      INT,
  custom_days      JSONB,
  custom_times     JSONB,
  timezone         TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  enabled          BOOLEAN NOT NULL DEFAULT true,
  paused           BOOLEAN NOT NULL DEFAULT false,
  last_run_at      TIMESTAMPTZ,
  last_run_status  TEXT,
  last_run_message TEXT,
  last_duration_ms INT,
  last_trigger     TEXT,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Lateral sync history (audit log)
CREATE TABLE lateral_sync_history (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sync_time            TIMESTAMPTZ NOT NULL,
  source_email         TEXT,
  original_filename    TEXT,
  drive_file_id        TEXT,
  rows_imported        INT NOT NULL DEFAULT 0,
  new_count            INT NOT NULL DEFAULT 0,
  active_count         INT NOT NULL DEFAULT 0,
  reopen_count         INT NOT NULL DEFAULT 0,
  closed_count         INT NOT NULL DEFAULT 0,
  result               TEXT NOT NULL CHECK (result IN ('Success', 'Failed')),
  error                TEXT,
  trigger              TEXT,
  duration_ms          INT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON lateral_sync_history (sync_time DESC);

-- Source drive state
CREATE TABLE lateral_source_drive_state (
  id                        SERIAL PRIMARY KEY,
  current_drive_file_id     TEXT,
  current_file_name         TEXT,
  current_message_id        TEXT,
  current_received_at       TIMESTAMPTZ,
  current_uploaded_at       TIMESTAMPTZ,
  pending_cleanup_file_ids  JSONB NOT NULL DEFAULT '[]',
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Encrypted secrets / config
CREATE TABLE app_config (
  key              TEXT PRIMARY KEY,
  encrypted_value  TEXT NOT NULL,   -- AES-256-GCM envelope JSON
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Keys: 'gmail_oauth', 'dataset_setup', 'lateral_processing_setup', 'dataset_drive_meta'

-- Home metrics cache
CREATE TABLE home_metrics (
  business_unit_id  TEXT PRIMARY KEY,
  totals            INT NOT NULL DEFAULT 0,
  active            INT NOT NULL DEFAULT 0,
  posted            INT NOT NULL DEFAULT 0,
  fresh             INT NOT NULL DEFAULT 0,
  file_name         TEXT,
  mtime_ms          BIGINT,
  source            TEXT,
  computed_at       TIMESTAMPTZ,
  error             TEXT,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- App notifications
CREATE TABLE app_notifications (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        TEXT NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  href        TEXT,
  meta        JSONB,
  read        BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON app_notifications (created_at DESC);

-- Dataset schedules
CREATE TABLE dataset_schedules (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  frequency       TEXT NOT NULL,
  sync_time       TEXT,
  day_of_week     INT,
  custom_days     JSONB,
  custom_times    JSONB,
  dataset_names   JSONB,
  enabled         BOOLEAN NOT NULL DEFAULT true,
  paused          BOOLEAN NOT NULL DEFAULT false,
  last_run_at     TIMESTAMPTZ,
  last_run_status TEXT,
  last_run_msg    TEXT,
  last_duration   INT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Sync watermark
CREATE TABLE sync_watermark (
  id                        SERIAL PRIMARY KEY,
  last_successful_sync_at   TIMESTAMPTZ,
  last_successful_sync_ms   BIGINT,
  last_trigger              TEXT,
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Sender stats
CREATE TABLE sender_stats (
  id                   SERIAL PRIMARY KEY,
  dataset_name         TEXT NOT NULL,
  email                TEXT NOT NULL,
  last_email_received  TIMESTAMPTZ,
  total_emails         INT NOT NULL DEFAULT 0,
  successful_syncs     INT NOT NULL DEFAULT 0,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (dataset_name, email)
);
```

---

## 15. Persistence Abstraction Recommendation

Design a thin interface so file-based and cloud implementations are interchangeable during migration:

```typescript
// src/lib/persistence/persistence-store.ts

export interface PersistenceStore {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
}

// Current implementation (no changes to production):
export class FilePersistenceStore implements PersistenceStore { ... }

// Future implementation (Phase 13+):
export class PostgresPersistenceStore implements PersistenceStore { ... }
```

Existing store files (`lateral-gmail-checkpoint-store.ts`, `home-widgets-metrics-store.ts`, etc.) retain their current typed APIs. The `PersistenceStore` interface is an optional internal abstraction — existing file-based code continues working unchanged.

**Do NOT implement `PostgresPersistenceStore` in Phase 12.**

---

## 16. Security Risks in Cloud Migration

| Risk | Mitigation |
|------|-----------|
| OAuth refresh token leaked | Always AES-256-GCM encrypted column; never in API response or logs |
| `ARA_DATASET_SETUP_SECRET` missing on Vercel | Required env var; server fails with `503` if absent |
| Multiple instances refreshing token simultaneously | PostgreSQL advisory lock or atomic compare-and-swap on token column |
| `ARA_SESSION_SECRET` rotated without re-issuing sessions | Session TTL limits impact (12 hours); rotate with process restart |
| Database credentials in environment | Use Vercel Postgres connection string; never commit |

---

## 17. Files Created

- `docs/phase12-data-state-audit.md` (this file)

## 18. Files Modified

- None. Phase 12 is audit only.

## 19. Files Intentionally Untouched

All production pipeline, Gmail, Drive, Excel COM, scheduler, Master XLSM, Posted, New Sheet, Column K/M code.
