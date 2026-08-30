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
    python3 \
    py3-openpyxl \
    su-exec \
    && ln -sf /usr/bin/python3 /usr/bin/python \
    && rm -rf /var/cache/apk/*

RUN mkdir -p /run/postgresql && chown -R postgres:postgres /run/postgresql
RUN mkdir -p /var/lib/postgresql/data && chown -R postgres:postgres /var/lib/postgresql/data

WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/db ./db
COPY --from=build /app/next.config.ts ./
COPY --from=build /app/tsconfig.json ./

COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

ENV NODE_ENV=production
ENV ARA_PERSISTENCE=postgres
ENV POSTGRES_URL=postgresql://ara_user:ara_password@127.0.0.1:5432/ara_db

EXPOSE 3000 5432

ENTRYPOINT ["/docker-entrypoint.sh"]
