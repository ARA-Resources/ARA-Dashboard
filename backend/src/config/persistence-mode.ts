/**
 * Matches Next.js `src/lib/persistence/persistence-mode.ts`.
 */
export type PersistenceMode = "file" | "postgres";

export function getPersistenceMode(): PersistenceMode {
  const raw = process.env.ARA_PERSISTENCE?.trim().toLowerCase();
  if (raw === "postgres") return "postgres";
  return "file";
}

export function isPostgresMode(): boolean {
  return getPersistenceMode() === "postgres";
}
