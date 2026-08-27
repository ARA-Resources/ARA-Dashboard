#!/bin/bash
set -euo pipefail

# Ensure postgres owns the data directory
chown -R postgres:postgres /var/lib/postgresql/data

# Initialize DB if empty
if [ -z "$(ls -A /var/lib/postgresql/data)" ]; then
    echo "Initializing PostgreSQL database..."
    su-exec postgres initdb -D /var/lib/postgresql/data
    echo "listen_addresses='*'" >> /var/lib/postgresql/data/postgresql.conf
fi

# Start Postgres in background
su-exec postgres pg_ctl -D /var/lib/postgresql/data -l /var/lib/postgresql/logfile start

# Wait for Postgres to be ready
until su-exec postgres pg_isready; do
  echo "Waiting for PostgreSQL to start..."
  sleep 1
done

# Set up Database and User (idempotent on container restart)
su-exec postgres psql -c "CREATE USER ara_user WITH PASSWORD 'ara_password';" 2>/dev/null || true
su-exec postgres psql -c "CREATE DATABASE ara_db OWNER ara_user;" 2>/dev/null || true
su-exec postgres psql -c "ALTER USER ara_user WITH SUPERUSER;" 2>/dev/null || true

export POSTGRES_URL="postgresql://ara_user:ara_password@127.0.0.1:5432/ara_db"
export ARA_PERSISTENCE="postgres"
export NODE_ENV="production"

# ── Ensure migration assets exist inside /app ─────────────────────────────
mkdir -p /app/scripts /app/db/migrations

# Bundled copy from image (Dockerfile COPY to /opt/ara/)
# Step A: migrate runner + SQL only. P-Roles Python scripts deferred to Step B.
if [ -f /opt/ara/db-migrate.mjs ] && [ ! -f /app/scripts/db-migrate.mjs ]; then
  cp /opt/ara/db-migrate.mjs /app/scripts/db-migrate.mjs
fi
if [ -d /opt/ara/migrations ] && [ -z "$(ls -A /app/db/migrations 2>/dev/null || true)" ]; then
  cp -r /opt/ara/migrations/. /app/db/migrations/
fi

# Self-heal: write migration runner if still missing (no tsx / no top-level await)
if [ ! -f /app/scripts/db-migrate.mjs ]; then
  echo "[db:migrate] Writing bundled db-migrate.mjs (file was missing from image)..."
  cat > /app/scripts/db-migrate.mjs << 'MIGRATE_EOF'
import fs from "node:fs/promises";
import path from "node:path";
import postgres from "postgres";

async function main() {
  const POSTGRES_URL = process.env.POSTGRES_URL?.trim();
  if (!POSTGRES_URL) {
    console.error("[db:migrate] ERROR: POSTGRES_URL is not set.");
    process.exit(1);
  }
  console.log("[db:migrate] Connecting to database...");
  const sql = postgres(POSTGRES_URL, {
    max: 1,
    connect_timeout: 10,
    ssl:
      POSTGRES_URL.includes("localhost") || POSTGRES_URL.includes("127.0.0.1")
        ? false
        : "require",
  });
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version     TEXT PRIMARY KEY,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        description TEXT
      )
    `;
    const appliedRows = await sql`SELECT version FROM schema_migrations ORDER BY version`;
    const applied = new Set(appliedRows.map((r) => r.version));
    const migrationsDir = path.join(process.cwd(), "db", "migrations");
    let files = [];
    try {
      files = (await fs.readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
    } catch {
      console.log("[db:migrate] No db/migrations directory.");
      return;
    }
    if (files.length === 0) {
      console.log("[db:migrate] No migration files found.");
      return;
    }
    let ranCount = 0;
    for (const file of files) {
      const version = file.replace(/[^0-9]/g, "").slice(0, 3).padStart(3, "0");
      if (applied.has(version)) {
        console.log(`  [skip] ${file} (already applied)`);
        continue;
      }
      const sqlText = await fs.readFile(path.join(migrationsDir, file), "utf8");
      console.log(`  [run ] ${file}...`);
      await sql.unsafe(sqlText);
      console.log(`  [done] ${file}`);
      ranCount++;
    }
    console.log(`[db:migrate] Done. ${ranCount} migration(s) applied.`);
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error("[db:migrate] Unexpected error:", err);
  process.exit(1);
});
MIGRATE_EOF
fi

echo "Running Database Migrations..."

if [ -f /app/scripts/db-migrate.mjs ]; then
  node /app/scripts/db-migrate.mjs || {
    echo "[db:migrate] Node runner failed — trying psql fallback..."
    FALLBACK_OK=1
    for sqlfile in /app/db/migrations/*.sql; do
      [ -f "$sqlfile" ] || continue
      echo "  [psql] $(basename "$sqlfile")"
      PGPASSWORD=ara_password psql -h 127.0.0.1 -U ara_user -d ara_db -v ON_ERROR_STOP=1 -f "$sqlfile" || FALLBACK_OK=0
    done
    [ "$FALLBACK_OK" = "1" ] || exit 1
  }
elif [ -d /app/db/migrations ] && ls /app/db/migrations/*.sql >/dev/null 2>&1; then
  echo "[db:migrate] db-migrate.mjs missing — running SQL via psql..."
  for sqlfile in /app/db/migrations/*.sql; do
    echo "  [psql] $(basename "$sqlfile")"
    PGPASSWORD=ara_password psql -h 127.0.0.1 -U ara_user -d ara_db -v ON_ERROR_STOP=1 -f "$sqlfile"
  done
else
  echo "[db:migrate] ERROR: no migration runner and no db/migrations/*.sql"
  exit 1
fi

echo "Starting Next.js App..."
exec npm start
