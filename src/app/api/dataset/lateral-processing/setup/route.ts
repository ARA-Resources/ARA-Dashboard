import { NextResponse } from "next/server";
import {
  readDatasetSetup,
} from "@/services/dataset/secure-store";
import { getDatasetSchedulerTimezone } from "@/services/dataset/scheduler";
import { readLateralSchedulerConfig } from "@/services/lateral-processing/lateral-scheduler";
import {
  readLateralDataProcessingSetup,
} from "@/services/lateral-processing/setup-store";
import { saveLateralDatasetSetup } from "@/services/lateral-processing/save-lateral-dataset-setup";
import {
  withLateralDataProcessingDefaults,
  type LateralDataProcessingSetup,
} from "@/types/lateral-processing-setup";

export const runtime = "nodejs";

async function buildWizardPayload(setup: LateralDataProcessingSetup | null) {
  const datasetSetup = await readDatasetSetup();
  const lateralSearch = datasetSetup?.datasets?.Lateral;
  const lateralSched = await readLateralSchedulerConfig();
  const lateralSchedule = {
    frequency: "daily" as const,
    syncTime: lateralSched.syncTime,
    enabled: lateralSched.enabled && !lateralSched.paused,
  };

  const base = withLateralDataProcessingDefaults(setup);
  const merged = {
    ...base,
    keywords:
      lateralSearch?.keywords?.length ? lateralSearch.keywords : base.keywords,
    destinationFolder: lateralSearch?.driveFolder?.folderId
      ? {
          mode: lateralSearch.driveFolder.mode,
          folderName: lateralSearch.driveFolder.folderName,
          folderId: lateralSearch.driveFolder.folderId,
          folderUrl: lateralSearch.driveFolder.folderUrl,
        }
      : base.destinationFolder,
    schedule: {
      frequency: "daily",
      syncTime: lateralSchedule.syncTime,
      enabled: lateralSchedule.enabled,
    },
    timezone: lateralSched.timezone || getDatasetSchedulerTimezone() || base.timezone,
    updatedAt: setup?.updatedAt ?? new Date(0).toISOString(),
  };

  return merged;
}

export async function GET() {
  const setup = await readLateralDataProcessingSetup();
  const merged = await buildWizardPayload(setup);
  return NextResponse.json({
    configured: Boolean(setup),
    updatedAt: setup?.updatedAt ?? null,
    setup: merged,
  });
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  try {
    const result = await saveLateralDatasetSetup(body);
    return NextResponse.json({
      configured: true,
      setup: result.setup,
      updatedAt: result.setup.updatedAt,
      validation: result.validation,
      message:
        "Lateral Dataset Setup saved. Configuration only — no Excel data was modified.",
    });
  } catch (error) {
    const err = error as Error & {
      status?: number;
      validation?: unknown;
    };
    const status = err.status ?? (/OAuth|not connected|permission|forbidden/i.test(err.message)
      ? 401
      : 500);
    return NextResponse.json(
      {
        error: err.message || "Failed to save Lateral Dataset Setup.",
        validation: err.validation,
      },
      { status }
    );
  }
}
