import { NextResponse } from "next/server";
import { getSharedGoogleConnectionStatus } from "@/services/dataset/google-connection";
import { clearGmailAuth } from "@/services/gmail/oauth";

export const runtime = "nodejs";

/**
 * Shared Dataset Google connection status.
 * One OAuth → Gmail + Drive for Lateral, Executive, and Consulting.
 * Does not return OAuth tokens.
 */
export async function GET() {
  const status = await getSharedGoogleConnectionStatus({ probeDrive: true });
  return NextResponse.json(status);
}

/** Disconnect the single shared Google account (Gmail + Drive). */
export async function DELETE() {
  await clearGmailAuth();
  const status = await getSharedGoogleConnectionStatus({ probeDrive: false });
  return NextResponse.json(status);
}