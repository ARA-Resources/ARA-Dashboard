# 1. Build the Application
FROM node:20-alpine as build

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# 2. Main Runtime Image
FROM node:20-alpine

RUN apk update && apk add --no-cache \
    postgresql \
    postgresql-contrib \
    bash \
    su-exec \
    && rm -rf /var/cache/apk/*

RUN mkdir -p /run/postgresql && chown -R postgres:postgres /run/postgresql
RUN mkdir -p /var/lib/postgresql/data && chown -R postgres:postgres /var/lib/postgresql/data

WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/next.config.ts ./
COPY --from=build /app/tsconfig.json ./

# SQL migrations (required)
RUN mkdir -p /opt/ara/migrations /app/scripts /app/db/migrations
COPY db/migrations/ /opt/ara/migrations/
RUN cp -r /opt/ara/migrations/. /app/db/migrations/

# Migration runner — embedded in image (does not depend on scripts/ in git on server)
RUN cat > /opt/ara/db-migrate.mjs << 'MIGRATE_EOF'
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

RUN cp /opt/ara/db-migrate.mjs /app/scripts/db-migrate.mjs \
  && test -f /app/scripts/db-migrate.mjs \
  && test "$(ls -1 /app/db/migrations/*.sql 2>/dev/null | wc -l)" -ge 1

COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

ENV NODE_ENV=production
ENV ARA_PERSISTENCE=postgres
ENV POSTGRES_URL=postgresql://ara_user:ara_password@127.0.0.1:5432/ara_db

EXPOSE 3000 5432

ENTRYPOINT ["/docker-entrypoint.sh"]
