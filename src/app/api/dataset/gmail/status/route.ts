import { NextResponse } from "next/server";
import { getGmailConnectionStatus } from "@/services/dataset/google-connection";
import { clearGmailAuth } from "@/services/gmail/oauth";

export const runtime = "nodejs";

/**
 * Shared Google connection status (Gmail + Drive from one OAuth).
 * Kept at /gmail/status for backward compatibility.
 * Prefer /api/dataset/connections for the explicit shared shape.
 */
export async function GET() {
  const status = await getGmailConnectionStatus();
  return NextResponse.json(status);
}

/** Disconnect the single shared Google account (Gmail + Drive). */
export async function DELETE() {
  await clearGmailAuth();
  const status = await getGmailConnectionStatus();
  return NextResponse.json({
    ...status,
    connected: false,
  });
}