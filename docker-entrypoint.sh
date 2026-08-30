#!/bin/bash
set -eo pipefail

# Ensure postgres owns the data directory
chown -R postgres:postgres /var/lib/postgresql/data

# Initialize DB if empty
if [ -z "$(ls -A /var/lib/postgresql/data)" ]; then
    echo "Initializing PostgreSQL database..."
    su-exec postgres initdb -D /var/lib/postgresql/data
    echo "listen_addresses='*'" >> /var/lib/postgresql/data/postgresql.conf
fi

# Start Postgres in background inside container
su-exec postgres pg_ctl -D /var/lib/postgresql/data -l /var/lib/postgresql/logfile start

# Wait for Postgres to be ready
until su-exec postgres pg_isready; do
  echo "Waiting for PostgreSQL to start..."
  sleep 1
done

# Set up Database and User
su-exec postgres psql -c "CREATE USER ara_user WITH PASSWORD 'ara_password';" 2>/dev/null || true
su-exec postgres psql -c "CREATE DATABASE ara_db OWNER ara_user;" 2>/dev/null || true
su-exec postgres psql -c "ALTER USER ara_user WITH SUPERUSER;" 2>/dev/null || true

export POSTGRES_URL="${POSTGRES_URL:-postgresql://ara_user:ara_password@127.0.0.1:5432/ara_db}"
export ARA_PERSISTENCE="${ARA_PERSISTENCE:-postgres}"
export NODE_ENV="production"

echo "Running Database Migrations..."
if [ -f "scripts/db-migrate.mjs" ]; then
  node scripts/db-migrate.mjs || npx tsx scripts/db-migrate.ts
elif [ -f "scripts/db-migrate.ts" ]; then
  npx tsx scripts/db-migrate.ts
else
  echo "[db:migrate] Fallback to psql execution..."
  for sqlfile in db/migrations/*.sql; do
    [ -f "$sqlfile" ] || continue
    echo "  [psql] $(basename "$sqlfile")"
    PGPASSWORD=ara_password psql -h 127.0.0.1 -U ara_user -d ara_db -v ON_ERROR_STOP=1 -f "$sqlfile"
  done
fi

echo "Starting Next.js App..."
exec npm start
