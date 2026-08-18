import { getAppUrl } from "@/lib/config/runtime";
import { NextResponse } from "next/server";
import {
  consumeOAuthState,
  exchangeCodeForTokens,
  persistGmailTokens,
  readGmailAuth,
} from "@/services/gmail/oauth";
import {
  readDatasetSetup,
  writeDatasetSetup,
} from "@/services/dataset/secure-store";

export const runtime = "nodejs";

function appOrigin(request: Request) {
  try {
    return getAppUrl();
  } catch {
    return new URL(request.url).origin;
  }
}

function redirectToDataset(request: Request, params: Record<string, string>) {
  const target = new URL("/dataset/connections/gmail", appOrigin(request));
  for (const [key, value] of Object.entries(params)) {
    target.searchParams.set(key, value);
  }
  return NextResponse.redirect(target);
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const oauthError = searchParams.get("error");

  if (oauthError) {
    return redirectToDataset(request, { gmail: "error", reason: oauthError });
  }

  if (!code || !state) {
    return redirectToDataset(request, {
      gmail: "error",
      reason: "missing_code_or_state",
    });
  }

  const statePayload = await consumeOAuthState(state);
  if (!statePayload) {
    return redirectToDataset(request, { gmail: "error", reason: "invalid_state" });
  }

  try {
    const tokens = await exchangeCodeForTokens(code);
    const previous = await readGmailAuth();
    const auth = await persistGmailTokens({
      tokens,
      expectedEmail: statePayload.expectedEmail,
      previous,
    });
    // Mark Drive authenticated in setup — same OAuth grants Gmail + Drive.
    const setup = await readDatasetSetup();
    if (setup) {
      await writeDatasetSetup({
        ...setup,
        driveAuthStatus: "authenticated",
        driveAccountEmail: setup.driveAccountEmail || auth.email,
        updatedAt: new Date().toISOString(),
      });
    }
    return redirectToDataset(request, { gmail: "connected", drive: "connected" });
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : "token_exchange_failed";
    return redirectToDataset(request, { gmail: "error", reason });
  }
}
