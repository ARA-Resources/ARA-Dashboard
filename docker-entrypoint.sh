#!/bin/bash

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

# Set up Database and User
su-exec postgres psql -c "CREATE USER ara_user WITH PASSWORD 'ara_password';" || true
su-exec postgres psql -c "CREATE DATABASE ara_db OWNER ara_user;" || true
su-exec postgres psql -c "ALTER USER ara_user WITH SUPERUSER;" || true

# Run DB Migrations
# We make sure the environment variables match what Next.js will use
export POSTGRES_URL="postgresql://ara_user:ara_password@127.0.0.1:5432/ara_db"
export ARA_PERSISTENCE="postgres"
export NODE_ENV="production"

echo "Running Database Migrations..."
if [ ! -f /app/scripts/db-migrate.mjs ]; then
  echo "[db:migrate] ERROR: /app/scripts/db-migrate.mjs is missing. Rebuild the image after pulling latest code."
  exit 1
fi
node /app/scripts/db-migrate.mjs || exit 1

echo "Starting Next.js App..."
# Start Next.js in foreground
exec npm start
