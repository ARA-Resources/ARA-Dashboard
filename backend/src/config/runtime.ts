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

export function peekAppUrl(): string {
  return trimEnv("ARA_APP_URL") || trimEnv("NEXT_PUBLIC_APP_URL");
}

export function getAppUrl(): string {
  const configured = peekAppUrl();
  if (configured) return configured;
  if (!isProductionEnv()) return "http://localhost:3000";
  throw missingConfigError("ARA_APP_URL");
}

export function getOAuthRedirectUri(): string {
  return (
    trimEnv("GOOGLE_GMAIL_REDIRECT_URI") ||
    trimEnv("GOOGLE_REDIRECT_URI") ||
    `${getAppUrl()}/api/dataset/gmail/oauth/callback`
  );
}
