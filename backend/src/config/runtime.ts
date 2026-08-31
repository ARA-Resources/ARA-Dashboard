/**
 * Minimal runtime config for encrypted dataset setup reads.
 * Matches Next.js `src/lib/config/runtime.ts` secret semantics.
 */

export function isProductionEnv(): boolean {
  return process.env.NODE_ENV === "production";
}

export function missingConfigError(name: string): Error {
  return new Error(`Required production configuration ${name} is missing.`);
}

function trimEnv(name: string): string {
  return process.env[name]?.trim() ?? "";
}

export function getDatasetSetupSecret(): string {
  return trimEnv("ARA_DATASET_SETUP_SECRET") || trimEnv("ARA_SETUP_SECRET");
}
