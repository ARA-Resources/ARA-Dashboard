/**
 * ONE shared Google OAuth for Dataset Manager.
 * Gmail + Drive use the same encrypted tokens (gmail-oauth.enc.json).
 * Lateral, Executive, and Consulting all consume this single connection.
 * Tokens are never sent to the browser / localStorage.
 */
import { google } from "googleapis";
import type { Credentials } from "google-auth-library";
import {
  deleteEncryptedJson,
  readEncryptedJson,
  writeEncryptedJson,
} from "@/services/dataset/encrypted-json-store";
import type { GmailOAuthTokens, StoredGmailAuth } from "@/types/gmail";
import { getOAuthRedirectUri } from "@/lib/config/runtime";

const TOKEN_FILE = "gmail-oauth.enc.json";
const STATE_FILE = "gmail-oauth-state.enc.json";

const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/drive",
  // Required for native Google Sheets Pivot Tables (e.g. Lateral P-Roles)
  "https://www.googleapis.com/auth/spreadsheets",
  "openid",
  "email",
  "profile",
];

export function getGoogleOAuthEnv() {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim() ?? "";
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim() ?? "";
  const redirectUri = getOAuthRedirectUri();
  return { clientId, clientSecret, redirectUri };
}

export function isGmailOAuthConfigured() {
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

export function buildGmailAuthUrl(options: {
  loginHint?: string;
  state: string;
}) {
  const client = createOAuth2Client();
  return client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: GMAIL_SCOPES,
    include_granted_scopes: true,
    state: options.state,
    login_hint: options.loginHint || undefined,
  });
}

export async function saveOAuthState(state: string, expectedEmail: string) {
  await writeEncryptedJson(STATE_FILE, {
    state,
    expectedEmail,
    createdAt: new Date().toISOString(),
  });
}

export async function consumeOAuthState(state: string): Promise<{
  expectedEmail: string;
} | null> {
  const stored = await readEncryptedJson<{
    state: string;
    expectedEmail: string;
  }>(STATE_FILE);
  if (!stored || stored.state !== state) return null;
  await deleteEncryptedJson(STATE_FILE);
  return { expectedEmail: stored.expectedEmail };
}

export async function exchangeCodeForTokens(code: string) {
  const client = createOAuth2Client();
  const { tokens } = await client.getToken(code);
  return tokens;
}

export async function readGmailAuth(): Promise<StoredGmailAuth | null> {
  return readEncryptedJson<StoredGmailAuth>(TOKEN_FILE);
}

export async function writeGmailAuth(auth: StoredGmailAuth): Promise<void> {
  await writeEncryptedJson(TOKEN_FILE, auth);
}

export async function clearGmailAuth(): Promise<void> {
  await deleteEncryptedJson(TOKEN_FILE);
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

export async function persistGmailTokens(options: {
  tokens: Credentials;
  expectedEmail: string;
  previous?: StoredGmailAuth | null;
}) {
  const client = createOAuth2Client();
  client.setCredentials(options.tokens);

  // Prefer refresh_token from this exchange; otherwise keep previous refresh token.
  const merged: Credentials = {
    ...options.tokens,
    refresh_token:
      options.tokens.refresh_token ||
      options.previous?.tokens.refresh_token ||
      undefined,
  };
  client.setCredentials(merged);

  let email = options.expectedEmail;
  try {
    const oauth2 = google.oauth2({ version: "v2", auth: client });
    const profile = await oauth2.userinfo.get();
    if (profile.data.email) email = profile.data.email.toLowerCase();
  } catch {
    // fall back to expected email from setup / login_hint
  }

  const now = new Date().toISOString();
  const auth: StoredGmailAuth = {
    email,
    expectedEmail: options.expectedEmail.toLowerCase(),
    tokens: toStoredTokens(merged),
    connectedAt: options.previous?.connectedAt ?? now,
    updatedAt: now,
  };
  await writeGmailAuth(auth);
  return auth;
}

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
