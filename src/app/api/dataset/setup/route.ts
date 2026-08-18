import { NextResponse } from "next/server";
import {
  clearDatasetSetup,
  readDatasetSetup,
  writeDatasetSetup,
} from "@/services/dataset/secure-store";
import { validateDatasetSetupInput } from "@/services/dataset/validate-setup";
import { reloadDatasetScheduler } from "@/services/dataset/scheduler";
import { withSetupDefaults } from "@/types/dataset-setup";

export const runtime = "nodejs";

export async function GET() {
  const setup = await readDatasetSetup();
  const normalized = setup
    ? { ...withSetupDefaults(setup), updatedAt: setup.updatedAt }
    : null;
  return NextResponse.json({
    configured: Boolean(setup),
    updatedAt: setup?.updatedAt ?? null,
    setup: normalized,
  });
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const previous = await readDatasetSetup();
  const validated = validateDatasetSetupInput(body);
  if (!validated.ok) {
    return NextResponse.json({ error: validated.error }, { status: 400 });
  }

  const next = validated.config;
  const gmailChanged = Boolean(
    previous &&
      previous.gmailAddress.toLowerCase() !== next.gmailAddress.toLowerCase()
  );
  const driveChanged = Boolean(
    previous &&
      previous.driveAccountEmail.toLowerCase() !==
        next.driveAccountEmail.toLowerCase()
  );

  // Do not require re-auth when the Drive account is unchanged
  if (
    previous &&
    !driveChanged &&
    previous.driveAuthStatus === "authenticated"
  ) {
    next.driveAuthStatus = "authenticated";
  }

  if (next.driveAuthStatus !== "authenticated") {
    return NextResponse.json(
      {
        error: driveChanged
          ? "Google Drive account changed. Re-authenticate Drive before saving."
          : "Authenticate the Google Drive account before saving.",
        requiresReauth: { gmail: gmailChanged, drive: true },
      },
      { status: 400 }
    );
  }

  await writeDatasetSetup(next);

  let scheduler = null;
  try {
    scheduler = await reloadDatasetScheduler();
  } catch (error) {
    console.error("[dataset-setup] Failed to reload scheduler", error);
  }

  return NextResponse.json({
    configured: true,
    updatedAt: next.updatedAt,
    setup: next,
    scheduler,
    requiresReauth: {
      gmail: gmailChanged,
      drive: driveChanged,
    },
    message:
      gmailChanged || driveChanged
        ? "Configuration saved. Reconnect OAuth for the changed account(s)."
        : "Configuration saved. Automation reloaded immediately.",
  });
}

/** Reset configuration — clears encrypted setup; automation disarms until reconfigured */
export async function DELETE() {
  await clearDatasetSetup();
  let scheduler = null;
  try {
    scheduler = await reloadDatasetScheduler();
  } catch (error) {
    console.error("[dataset-setup] Failed to reload scheduler after reset", error);
  }

  return NextResponse.json({
    configured: false,
    setup: null,
    scheduler,
    message: "Dataset configuration reset.",
  });
}
