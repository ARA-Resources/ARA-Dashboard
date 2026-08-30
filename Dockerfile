# 1. Build the Application
FROM node:20-alpine as build

WORKDIR /app

<<<<<<< HEAD
# Install dependencies
COPY package*.json ./
RUN npm ci

# Copy source and build
=======
COPY package*.json ./
RUN npm ci

>>>>>>> a35563e26cb9ba3f960bb269a8104d704896ca34
COPY . .
RUN npm run build

# 2. Main Runtime Image
<<<<<<< HEAD
FROM node:20-alpine

# Install Postgres and tools
=======
# Step A: Docker/Podman + embedded Postgres + migrations.
# Step B: Python/OpenPyXL + P-Roles inject/extract scripts for Linux pipeline.
FROM node:20-alpine

>>>>>>> a35563e26cb9ba3f960bb269a8104d704896ca34
RUN apk update && apk add --no-cache \
    postgresql \
    postgresql-contrib \
    bash \
<<<<<<< HEAD
    su-exec \
    && rm -rf /var/cache/apk/*

# Setup Postgres Directories
=======
    python3 \
    py3-openpyxl \
    su-exec \
    && ln -sf /usr/bin/python3 /usr/bin/python \
    && rm -rf /var/cache/apk/*

>>>>>>> a35563e26cb9ba3f960bb269a8104d704896ca34
RUN mkdir -p /run/postgresql && chown -R postgres:postgres /run/postgresql
RUN mkdir -p /var/lib/postgresql/data && chown -R postgres:postgres /var/lib/postgresql/data

WORKDIR /app

<<<<<<< HEAD
# Copy built application and dependencies
# We copy node_modules to ensure all dependencies (including tsx for migrations) are available
=======
>>>>>>> a35563e26cb9ba3f960bb269a8104d704896ca34
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
<<<<<<< HEAD
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/db ./db
COPY --from=build /app/next.config.ts ./
COPY --from=build /app/tsconfig.json ./

# Entrypoint Script
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

# Environment variables for Next.js and Database
=======
COPY --from=build /app/next.config.ts ./
COPY --from=build /app/tsconfig.json ./

# Database migrations (Podman-safe: COPY files - no Dockerfile heredocs)
# Build context is phase9-unified: expects migrations 001-003.
RUN mkdir -p /opt/ara/migrations /app/scripts /app/db/migrations
COPY db/migrations/ /opt/ara/migrations/
COPY scripts/db-migrate.mjs /opt/ara/db-migrate.mjs
COPY scripts/_extract-master-p-roles-feed.py /opt/ara/_extract-master-p-roles-feed.py
COPY scripts/_inject-p-roles-google-display.py /opt/ara/_inject-p-roles-google-display.py
RUN cp -r /opt/ara/migrations/. /app/db/migrations/ \
  && cp /opt/ara/db-migrate.mjs /app/scripts/db-migrate.mjs \
  && cp /opt/ara/_extract-master-p-roles-feed.py /app/scripts/_extract-master-p-roles-feed.py \
  && cp /opt/ara/_inject-p-roles-google-display.py /app/scripts/_inject-p-roles-google-display.py \
  && test -f /app/scripts/db-migrate.mjs \
  && test -f /app/scripts/_extract-master-p-roles-feed.py \
  && test -f /app/scripts/_inject-p-roles-google-display.py \
  && test -f /app/db/migrations/001_initial_schema.sql \
  && test -f /app/db/migrations/002_oauth_state.sql \
  && test -f /app/db/migrations/003_lateral_master_staging.sql \
  && test "$(ls -1 /app/db/migrations/*.sql 2>/dev/null | wc -l)" -ge 3

COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

>>>>>>> a35563e26cb9ba3f960bb269a8104d704896ca34
ENV NODE_ENV=production
ENV ARA_PERSISTENCE=postgres
ENV POSTGRES_URL=postgresql://ara_user:ara_password@127.0.0.1:5432/ara_db

<<<<<<< HEAD
# Default Next.js port and Postgres port
=======
>>>>>>> a35563e26cb9ba3f960bb269a8104d704896ca34
EXPOSE 3000 5432

ENTRYPOINT ["/docker-entrypoint.sh"]
