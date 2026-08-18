/**
 * Resolves the active persistence mode from the ARA_PERSISTENCE env var.
 *
 * "file"     → use .data/ filesystem (default, current Windows behavior)
 * "postgres" → use PostgreSQL via POSTGRES_URL
 *
 * Default: "file" — existing behavior is never broken unless explicitly opted in.
 */
export type PersistenceMode = "file" | "postgres";

export function getPersistenceMode(): PersistenceMode {
  const raw = process.env.ARA_PERSISTENCE?.trim().toLowerCase();
  if (raw === "postgres") return "postgres";
  return "file"; // safe default
}

export function isPostgresMode(): boolean {
  return getPersistenceMode() === "postgres";
}
