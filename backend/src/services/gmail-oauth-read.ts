/**
 * Stage 19/22/26: Gmail/Drive OAuth helpers for connection status, disconnect,
 * and Drive-backed Excel reads (executive master sheet).
 */
import { google } from "googleapis";
import type { Credentials } from "google-auth-library";
import {
  deleteEncryptedJson,
  readEncryptedJson,
  writeEncryptedJson,
} from "./encrypted-json-store.js";
import {
  getOAuthRedirectUri,
} from "../config/runtime.js";
import type { GmailOAuthTokens, StoredGmailAuth } from "../types/gmail.js";

const TOKEN_FILE = "gmail-oauth.enc.json";

function trimEnv(name: string): string {
  return process.env[name]?.trim() ?? "";
}

function toStoredTokens(tokens: Credentials): GmailOAuthTokens {
  return {
    access_token: tokens.access_token ?? null,
    refresh_token: tokens.refresh_token ?? null,
    scope: tokens.scope ?? null,
    token_type: tokens.token_type ?? null,
    expiry_date: tokens.expiry_date ?? null,
    id_token: tokens.id_token ?? null,
  };
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

async function writeGmailAuth(auth: StoredGmailAuth): Promise<void> {
  await writeEncryptedJson(TOKEN_FILE, auth);
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

/**
 * Authorized Google clients with token refresh persistence.
 * Matches Next `getAuthorizedGmailClient` for Drive-backed Excel reads.
 */
export async function getAuthorizedGmailClient() {
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

  client.on("tokens", (tokens) => {
    void (async () => {
      const latest = await readGmailAuth();
      if (!latest) return;
      const nextTokens: GmailOAuthTokens = {
        ...latest.tokens,
        ...toStoredTokens(tokens),
        refresh_token:
          tokens.refresh_token || latest.tokens.refresh_token || null,
      };
      await writeGmailAuth({
        ...latest,
        tokens: nextTokens,
        updatedAt: new Date().toISOString(),
      });
    })();
  });

  return {
    auth: stored,
    gmail: google.gmail({ version: "v1", auth: client }),
    drive: google.drive({ version: "v3", auth: client }),
    sheets: google.sheets({ version: "v4", auth: client }),
    oauth2Client: client,
  };
}
