/**
 * Stage 19/22: Gmail/Drive OAuth helpers for connection status and disconnect.
 * Does NOT persist token refreshes — deferred to future Gmail/Drive OAuth stage.
 */
import { google } from "googleapis";
import {
  deleteEncryptedJson,
  readEncryptedJson,
} from "./encrypted-json-store.js";
import {
  getOAuthRedirectUri,
} from "../config/runtime.js";
import type { StoredGmailAuth } from "../types/gmail.js";

const TOKEN_FILE = "gmail-oauth.enc.json";

function trimEnv(name: string): string {
  return process.env[name]?.trim() ?? "";
}

export function getGoogleOAuthEnv() {
  const clientId = trimEnv("GOOGLE_CLIENT_ID");
  const clientSecret = trimEnv("GOOGLE_CLIENT_SECRET");
  const redirectUri = getOAuthRedirectUri();
  return { clientId, clientSecret, redirectUri };
}

export function isGmailOAuthConfigured(): boolean {
  const { clientId, clientSecret } = getGoogleOAuthEnv();
  return Boolean(clientId && clientSecret);
}

export function createOAuth2Client() {
  const { clientId, clientSecret, redirectUri } = getGoogleOAuthEnv();
  if (!clientId || !clientSecret) {
    throw new Error(
      "Missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET. Configure OAuth credentials before connecting Gmail."
    );
  }
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

export async function readGmailAuth(): Promise<StoredGmailAuth | null> {
  return readEncryptedJson<StoredGmailAuth>(TOKEN_FILE);
}

/** Remove stored Gmail/Drive OAuth tokens (local disconnect only). */
export async function clearGmailAuth(): Promise<void> {
  await deleteEncryptedJson(TOKEN_FILE);
}

/**
 * Authorized Google clients for status reads only.
 * No `tokens` event listener — does not write refreshed tokens to storage.
 */
export async function getAuthorizedGmailClientForStatusRead() {
  const stored = await readGmailAuth();
  if (!stored?.tokens.refresh_token && !stored?.tokens.access_token) {
    throw new Error("Gmail is not connected. Complete OAuth first.");
  }

  const client = createOAuth2Client();
  client.setCredentials({
    access_token: stored.tokens.access_token ?? undefined,
    refresh_token: stored.tokens.refresh_token ?? undefined,
    scope: stored.tokens.scope ?? undefined,
    token_type: stored.tokens.token_type ?? undefined,
    expiry_date: stored.tokens.expiry_date ?? undefined,
    id_token: stored.tokens.id_token ?? undefined,
  });

  return {
    auth: stored,
    gmail: google.gmail({ version: "v1", auth: client }),
    drive: google.drive({ version: "v3", auth: client }),
    oauth2Client: client,
  };
}
