import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { readDatasetSetup } from "@/services/dataset/secure-store";
import {
  buildGmailAuthUrl,
  isGmailOAuthConfigured,
  saveOAuthState,
} from "@/services/gmail/oauth";

import { getGmailAccount } from "@/lib/config/runtime";

export const runtime = "nodejs";

/** Starts the single shared Google OAuth (Gmail + Drive) for all dataset types. */

export async function GET(request: Request) {
  if (!isGmailOAuthConfigured()) {
    return NextResponse.json(
      {
        error:
          "Gmail OAuth is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env.local, then restart the app.",
      },
      { status: 503 }
    );
  }

  const { searchParams } = new URL(request.url);
  const queryEmail = searchParams.get("email")?.trim().toLowerCase();
  const setup = await readDatasetSetup();
  const expectedEmail = (
    queryEmail ||
    setup?.gmailAddress ||
    getGmailAccount()
  ).toLowerCase();

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(expectedEmail)) {
    return NextResponse.json(
      { error: "Save Dataset setup with a valid Gmail address before connecting." },
      { status: 400 }
    );
  }

  const state = randomBytes(24).toString("hex");
  await saveOAuthState(state, expectedEmail);

  const url = buildGmailAuthUrl({
    loginHint: expectedEmail,
    state,
  });

  return NextResponse.redirect(url);
}
