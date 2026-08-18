import {
  readDatasetSetup,
  writeDatasetSetup,
} from "@/services/dataset/secure-store";
import { setDatasetSchedulerTimezone } from "@/services/dataset/scheduler";
import {
  updateLateralScheduler,
  reloadLateralScheduler,
} from "@/services/lateral-processing/lateral-scheduler";
import {
  writeLateralDataProcessingSetup,
} from "@/services/lateral-processing/setup-store";
import {
  validateLateralDataProcessingConfig,
  validateLateralDataProcessingInput,
} from "@/services/lateral-processing/setup-validation";
import { withSetupDefaults } from "@/types/dataset-setup";
import type { LateralDataProcessingSetup } from "@/types/lateral-processing-setup";

/**
 * Save full Lateral Dataset Setup:
 * - Gmail keywords + Drive destination (Dataset setup)
 * - Source/master/sheets (processing setup)
 * - Schedule targeting Lateral
 * - Timezone for scheduler
 *
 * Does not modify any Excel workbook contents.
 */
export async function saveLateralDatasetSetup(body: unknown): Promise<{
  setup: LateralDataProcessingSetup;
  validation: Awaited<ReturnType<typeof validateLateralDataProcessingConfig>>;
}> {
  const parsed = validateLateralDataProcessingInput(body);
  if (!parsed.ok) {
    throw Object.assign(new Error(parsed.error), { status: 400 });
  }

  const config = parsed.config;
  const schedule = config.schedule;

  if (schedule.frequency === "custom") {
    if (!schedule.customDays?.length) {
      throw Object.assign(
        new Error("Custom schedule needs at least one day selected."),
        { status: 400 }
      );
    }
    if (!schedule.customTimes?.length) {
      throw Object.assign(
        new Error("Custom schedule needs at least one time."),
        { status: 400 }
      );
    }
    // Keep syncTime aligned to first custom time for displays/fallback
    schedule.syncTime = schedule.customTimes[0] || schedule.syncTime;
  } else if (
    schedule.frequency !== "hourly" &&
    !/^\d{1,2}:\d{2}$/.test(schedule.syncTime.trim())
  ) {
    throw Object.assign(new Error("Enter a valid schedule time (HH:MM)."), {
      status: 400,
    });
  }

  const enabledKeywords = config.keywords.filter(
    (keyword) => keyword.enabled && keyword.value.trim()
  );
  if (enabledKeywords.length === 0) {
    throw Object.assign(
      new Error("Add at least one enabled Gmail search keyword for Lateral."),
      { status: 400 }
    );
  }

  if (!config.timezone.trim()) {
    throw Object.assign(new Error("Select a time zone."), { status: 400 });
  }

  const validation = await validateLateralDataProcessingConfig(config);
  validation.keywords = {
    ok: true,
    message: `${enabledKeywords.length} enabled keyword(s)`,
  };
  validation.schedule = {
    ok: true,
    message:
      schedule.frequency === "custom"
        ? `custom · ${schedule.customDays.length} day(s) · ${schedule.customTimes.join(", ")}`
        : `${schedule.frequency} at ${schedule.syncTime}`,
  };
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: config.timezone }).format(
      new Date()
    );
    validation.timezone = { ok: true, message: config.timezone };
  } catch {
    validation.timezone = {
      ok: false,
      message: `Invalid timezone: ${config.timezone}`,
    };
  }

  const allOk = Object.values(validation).every((entry) => entry && entry.ok);
  if (!allOk) {
    const error = Object.assign(
      new Error(
        "Validation failed. Verify folders, workbooks, worksheets, keywords, schedule, and timezone."
      ),
      { status: 400, validation }
    );
    throw error;
  }

  // 1) Processing setup (source/master/sheets/destination)
  await writeLateralDataProcessingSetup(config);

  // 2) Dataset setup — Lateral keywords + Drive destination folder
  const existing = await readDatasetSetup();
  if (existing) {
    const next = withSetupDefaults({
      ...existing,
      datasets: {
        ...existing.datasets,
        Lateral: {
          ...existing.datasets.Lateral,
          enabled: true,
          keywords: config.keywords,
          driveFolder: {
            mode: config.destinationFolder.mode,
            folderName: config.destinationFolder.folderName,
            folderId: config.destinationFolder.folderId,
            folderUrl: config.destinationFolder.folderUrl,
          },
        },
      },
      syncFrequency:
        config.schedule.frequency === "weekly"
          ? "custom"
          : config.schedule.frequency === "custom"
            ? "custom"
            : config.schedule.frequency,
      syncTime: config.schedule.syncTime,
      updatedAt: new Date().toISOString(),
    });
    await writeDatasetSetup({
      ...next,
      updatedAt: new Date().toISOString(),
    });
  }

  // 3) Timezone (shared clock preference + Lateral scheduler)
  await setDatasetSchedulerTimezone(config.timezone);

  // 4) Lateral-OWN schedule (not the global multi-dataset scheduler)
  await updateLateralScheduler({
    frequency: config.schedule.frequency,
    syncTime: config.schedule.syncTime,
    dayOfWeek: config.schedule.dayOfWeek,
    customDays: config.schedule.customDays,
    customTimes: config.schedule.customTimes,
    timezone: config.timezone,
    enabled: config.schedule.enabled,
    paused: config.schedule.enabled ? false : true,
  });
  await reloadLateralScheduler();

  return { setup: config, validation };
}
