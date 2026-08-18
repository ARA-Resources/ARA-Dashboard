# Phase 13 — PostgreSQL Persistence Migration

> Audit + Implementation. No production data was modified. No cloud resources were created.

---

## 1. Database Technology

**Package:** `postgres` (npm) — lightweight tagged-template SQL client, serverless-safe, no ORM.  
**Node.js requirement:** ≥ 18 (Node 20.14.0 in use).  
**Vercel compatibility:** The `postgres` package uses a single connection per serverless invocation when `max: 1` is set, avoiding connection pool exhaustion.

---

## 2. Connection Configuration

| Variable | Required | Description |
|----------|----------|-------------|
| `ARA_PERSISTENCE` | No | `"file"` (default) or `"postgres"`. Never change default without explicit intention. |
| `POSTGRES_URL` | Only when `ARA_PERSISTENCE=postgres` | Standard PostgreSQL connection string. Set as Vercel environment variable in production. |

Both variables are documented in `.env.example`. Never commit real values to Git.

---

## 3. Migration Mechanism

**Location:** `db/migrations/`  
**Run command:** `npm run db:migrate`  
**Script:** `scripts/db-migrate.ts` (executed via `tsx`)

Rules:
- All DDL uses `CREATE TABLE IF NOT EXISTS`, `INSERT ... ON CONFLICT DO NOTHING` → **idempotent/safe to re-run**.
- Migration versions tracked in `schema_migrations` table.
- Never runs automatically during `npm start` or `npm run dev`.
- Always requires `POSTGRES_URL` to be set explicitly before running.
- Fails with clear error message if connection unavailable.

---

## 4. Tables Created (Migration 001)

| Table | Purpose | Rows |
|-------|---------|------|
| `gmail_checkpoint` | Gmail deduplication cursor | 1 per account |
| `app_config` | Encrypted key-value store for secrets/config | N keys |
| `lateral_scheduler_state` | Lateral cron schedule + last run | 1 |
| `dataset_scheduler_state` | Global scheduler pause/timezone | 1 |
| `dataset_schedules` | Per-dataset schedule definitions | N |
| `lateral_sync_history` | Append-only pipeline audit log | Unlimited |
| `dataset_sync_history` | Append-only multi-dataset sync log | Unlimited |
| `sync_watermark` | Last successful automated sync timestamp | 1 |
| `lateral_source_drive_state` | Current source Drive file + cleanup queue | 1 |
| `home_metrics` | Cached per-BU metrics snapshot | 1 per BU |
| `app_notifications` | In-app notification feed (max 50) | ≤ 50 |
| `sender_stats` | Per-dataset per-sender Gmail stats | N |
| `lateral_p_roles_sheet_config` | Google Spreadsheet ID for P-Roles | 1 |
| `schema_migrations` | Migration version tracking | N |

---

## 5. Persistence Interfaces

Location: `src/lib/persistence/`

| File | Purpose |
|------|---------|
| `persistence-mode.ts` | Resolves `ARA_PERSISTENCE` env var → `"file"` or `"postgres"` |
| `interfaces.ts` | Typed domain interfaces (8 interfaces) |
| `file-stores.ts` | File-backed adapters (delegates to existing `.data/` stores) |
| `postgres-stores.ts` | PostgreSQL-backed adapters |
| `store-factory.ts` | Returns correct adapter based on mode; singletons per process |
| `db-client.ts` | Lazy PostgreSQL connection from `POSTGRES_URL` |

---

## 6. Domain Interfaces

| Interface | Covers |
|-----------|--------|
| `GmailCheckpointStore` | `read()`, `advance()` with optimistic locking |
| `EncryptedConfigStore` | `readRawEnvelope()`, `writeRawEnvelope()`, `deleteKey()` |
| `SchedulerStateStore` | `readLateral()`, `writeLateral()` |
| `LateralSyncHistoryStoreInterface` | `list()`, `append()` |
| `SyncWatermarkStoreInterface` | `read()`, `write()` |
| `LateralSourceDriveStateStoreInterface` | `read()`, `write()` |
| `HomeMetricsStoreInterface` | `readSnapshot()`, `writeSnapshot()`, `mergeUnit()` |
| `AppNotificationsStoreInterface` | `list()`, `countUnread()`, `push()`, `markRead()`, `markAllRead()`, `delete()` |

---

## 7. File Store Adapters

`FileGmailCheckpointStore`, `FileEncryptedConfigStore`, `FileSchedulerStateStore`, `FileLateralSyncHistoryStore`, `FileSyncWatermarkStore`, `FileLateralSourceDriveStateStore`, `FileHomeMetricsStore`, `FileAppNotificationsStore`

Each is a **thin wrapper** delegating to the existing `.data/` implementations. Zero business logic is changed. All existing code paths continue to work identically.

---

## 8. PostgreSQL Store Adapters

`PostgresGmailCheckpointStore`, `PostgresEncryptedConfigStore`, `PostgresSchedulerStateStore`, `PostgresLateralSyncHistoryStore`, `PostgresSyncWatermarkStore`, `PostgresLateralSourceDriveStateStore`, `PostgresHomeMetricsStore`, `PostgresAppNotificationsStore`

All adapters normalize database row types (BIGINT → number, TIMESTAMPTZ → ISO string) to match the existing TypeScript types exactly.

---

## 9. Feature Flag

```
ARA_PERSISTENCE=file      # default — uses .data/ (unchanged behavior)
ARA_PERSISTENCE=postgres  # uses PostgreSQL via POSTGRES_URL
```

Default is `"file"`. The application **never** automatically switches to PostgreSQL. Production Windows environment continues to use `file` mode indefinitely until an explicit operator-controlled change.

---

## 10. Gmail Checkpoint Concurrency

**Problem:** On Vercel, multiple serverless instances could read the same checkpoint simultaneously and both attempt to process the same Gmail attachment, causing duplicate pipeline runs.

**Solution (PostgreSQL mode):**

```sql
UPDATE gmail_checkpoint
SET message_id = $new, received_at_ms = $newMs, result = 'SUCCESS', updated_at = NOW()
WHERE account_email = $account
  AND (received_at_ms IS NULL OR received_at_ms < $newMs
       OR (received_at_ms = $newMs AND message_id <= $newMessageId))
```

- If another worker already advanced the checkpoint to a **newer** `received_at_ms`, the `WHERE` clause does not match → `rowcount = 0` → update is silently a no-op.
- The current worker then re-reads the checkpoint and gets the newer value without overwriting it.
- This prevents duplicate processing without requiring distributed locks.

**Invariant preserved:** Gmail checkpoint is never written on failure. Only SUCCESS results advance it. This is unchanged from the file implementation.

---

## 11. OAuth Encryption

Encryption mechanism is **unchanged**:
- AES-256-GCM envelope: `{ alg, iv, tag, ciphertext, savedAt }`
- Key: SHA-256 of `ARA_DATASET_SETUP_SECRET`
- In PostgreSQL mode, the **raw envelope JSON string** is stored in `app_config.encrypted_value`
- Encryption and decryption are performed application-side (existing `encrypted-json-store.ts` utilities)
- The database never sees plaintext tokens

Keys stored in `app_config`:
- `gmail-oauth.enc.json` → key `gmail_oauth`
- `dataset-setup.enc.json` → key `dataset_setup`
- `lateral-data-processing-setup.enc.json` → key `lateral_processing_setup`
- `dataset-drive-meta.enc.json` → key `dataset_drive_meta`

---

## 12. Scheduler State

`lateral-scheduler.json` maps to `lateral_scheduler_state` table (single row). All fields preserved:

| JSON field | DB column |
|-----------|----------|
| `frequency` | `frequency` |
| `syncTime` | `sync_time` |
| `customDays` | `custom_days` (JSONB) |
| `customTimes` | `custom_times` (JSONB) |
| `timezone` | `timezone` |
| `enabled` | `enabled` |
| `paused` | `paused` |
| `lastRunAt` | `last_run_at` |
| `lastRunStatus` | `last_run_status` |
| `lastRunMessage` | `last_run_message` |
| `lastDurationMs` | `last_duration_ms` |
| `lastTrigger` | `last_trigger` |

`node-cron` scheduler code is **unchanged**. The `PostgresSchedulerStateStore` only replaces the file read/write — the in-process cron management remains as-is. Vercel Cron migration is Phase 14.

---

## 13. Dataset Configuration

`dataset-setup.enc.json` and `lateral-data-processing-setup.enc.json` both route through `EncryptedConfigStore`. In PostgreSQL mode they are stored as encrypted envelope strings in `app_config` under their filename-based keys. No plaintext Drive folder IDs, Gmail addresses, or pipeline settings are stored unencrypted.

---

## 14. Other Migrated State

| State | PostgreSQL table | Notes |
|-------|----------------|-------|
| Lateral sync history | `lateral_sync_history` | Append-only, indexed on `sync_time DESC` |
| Sync watermark | `sync_watermark` | Single row |
| Lateral source Drive state | `lateral_source_drive_state` | Single row, `pendingCleanupFileIds` as JSONB |
| Home metrics | `home_metrics` | One row per business unit; cache, regeneratable |
| App notifications | `app_notifications` | Max 50 via trim-on-insert |

Not migrated yet (reserved for Phase 14+):
- `sync-history.json` (multi-dataset)
- `lateral-p-roles-google-sheet.json`
- `sender-stats.json`
- Log files → stdout migration

---

## 15. Security

- `POSTGRES_URL` never appears in source code, API responses, or logs.
- OAuth tokens are AES-256-GCM encrypted before database write.
- `ARA_DATASET_SETUP_SECRET` is the only key material; sourced from env var.
- `resetStoreFactory()` is available for tests; never called in production routes.
- All existing `viewer`/`operator` authentication is unchanged.

---

## 16. Vercel Compatibility

| Concern | Status |
|---------|--------|
| Serverless connection safety | ✅ `max: 1` connection per invocation |
| SSL in production | ✅ `ssl: "require"` for non-localhost URLs |
| No persistent files in postgres mode | ✅ All state in DB |
| No Windows paths in persistence layer | ✅ DB client uses URL only |
| Cold start safe | ✅ Lazy connection; no startup side effects |
| `node-cron` still present | ⚠️ Addressed in Phase 14 (Vercel Cron migration) |

---

## 17. Test Results

```
npm run test:persistence   (file mode, no DB required)

  Passed: 33   Failed: 0   Skipped: 7 (J1-J7, POSTGRES_URL not set)
```

Tests A–I cover: checkpoint write/read/advance, encrypted config, scheduler round-trip, sync history append/list, notifications CRUD, missing record handling, concurrent checkpoint simulation (optimistic locking proof), AES-256-GCM encryption round trip, and persistence mode flag behavior.

Tests J1–J7 (PostgreSQL live integration) require `POSTGRES_URL` pointing to a non-production test database. They validate: checkpoint CAS update, stale write rejection, encrypted config CRUD, scheduler row existence, sync history insert, home metrics upsert, notification CRUD. Run with:

```bash
POSTGRES_URL=postgresql://... npm run test:persistence
```

---

## 18. Rollback Strategy

Simple — set or remove env var:

```
ARA_PERSISTENCE=file    # or unset ARA_PERSISTENCE
```

`.data/` directory and all file-based stores remain intact. No migration or data copy is required. The file stores continue to be updated in file mode even after a postgres migration.

---

## 19. Remaining Filesystem Dependencies

All existing `.data/` stores remain active in `ARA_PERSISTENCE=file` mode (default). In `postgres` mode, the following filesystem operations are **eliminated** from the persistence layer:

- Gmail checkpoint file read/write
- OAuth token file read/write
- Scheduler state file read/write
- Sync history file read/write
- Notifications file read/write
- Home metrics file read/write
- Source drive state file read/write

**Still filesystem-dependent in postgres mode (not yet migrated):**
- Log files (`DATASET_LOG_DIR` → stdout migration Phase 14)
- Excel cache (`excel-cache/`) → ephemeral re-download (Phase 14)
- Dataset current workbooks (`datasets/current/`) → Drive re-download (Phase 14)
- Temp processing files (`datasets/temp/`, `lateral-reconcile-staging/`) → remain ephemeral

---

## 20. Remaining Windows Dependencies

Unchanged from Phase 12 audit. The persistence layer is now Windows-independent in postgres mode. Remaining Windows-only code:

- `lateral-p-roles-pivot-refresh.ts` (VBA macro)
- `run-vba-macro.ts` (Excel COM)
- `lateral-posted-sheet-processor.ts` (openpyxl/Python)
- `lateral-job-requisition-comparison.ts` (Excel COM)
- All `run-vba-macro` / `execFile` calls

These are not affected by Phase 13.
