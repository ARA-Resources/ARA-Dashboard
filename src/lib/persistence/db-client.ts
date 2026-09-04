/**
 * Shared PostgreSQL client for the ARA Dashboard persistence layer.
 *
 * Uses the `postgres` package (lightweight, serverless-safe).
 * Connection is established lazily from POSTGRES_URL environment variable.
 * Safe to import in Next.js API routes — one connection per process on Node,
 * one per request on serverless (postgres package handles this transparently).
 *
 * Never call this module when ARA_PERSISTENCE=file.
 */
import postgres from "postgres";

let _sql: ReturnType<typeof postgres> | null = null;

export function getDbClient(): ReturnType<typeof postgres> {
  if (_sql) return _sql;

  const url = process.env.POSTGRES_URL?.trim();
  if (!url) {
    throw new Error(
      "[persistence] POSTGRES_URL is not set. " +
        "Set ARA_PERSISTENCE=file to use local file storage, " +
        "or provide POSTGRES_URL for PostgreSQL mode."
    );
  }

  _sql = postgres(url, {
    // Persistent Docker/VPS: small pool. Neon pooler: disable prepared statements
    // to avoid "cached plan must not change result type" after migrations.
    max: Math.min(
      10,
      Math.max(1, Number(process.env.ARA_PG_POOL_MAX || "5") || 5)
    ),
    idle_timeout: 20,
    connect_timeout: 15,
    prepare: false,
    ssl: url.includes("localhost") || url.includes("127.0.0.1") ? false : "require",
  });

  return _sql;
}

/** Graceful shutdown (for tests and scripts). */
export async function closeDbClient(): Promise<void> {
  if (_sql) {
    await _sql.end();
    _sql = null;
  }
}
