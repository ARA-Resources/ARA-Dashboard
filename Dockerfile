# 1. Build the Application
FROM node:20-alpine as build

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# 2. Main Runtime Image
# Step A: Docker/Podman + embedded Postgres + migrations only.
# Python / openpyxl / P-Roles inject scripts are deferred to Step B.
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

# Database migrations (Podman-safe: COPY files - no Dockerfile heredocs)
# Build context is phase9-unified: expects migrations 001-003.
RUN mkdir -p /opt/ara/migrations /app/scripts /app/db/migrations
COPY db/migrations/ /opt/ara/migrations/
COPY scripts/db-migrate.mjs /opt/ara/db-migrate.mjs
RUN cp -r /opt/ara/migrations/. /app/db/migrations/ \
  && cp /opt/ara/db-migrate.mjs /app/scripts/db-migrate.mjs \
  && test -f /app/scripts/db-migrate.mjs \
  && test -f /app/db/migrations/001_initial_schema.sql \
  && test -f /app/db/migrations/002_oauth_state.sql \
  && test -f /app/db/migrations/003_lateral_master_staging.sql \
  && test "$(ls -1 /app/db/migrations/*.sql 2>/dev/null | wc -l)" -ge 3

COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

ENV NODE_ENV=production
ENV ARA_PERSISTENCE=postgres
ENV POSTGRES_URL=postgresql://ara_user:ara_password@127.0.0.1:5432/ara_db

EXPOSE 3000 5432

ENTRYPOINT ["/docker-entrypoint.sh"]
