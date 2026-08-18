import fs from "node:fs/promises";
import path from "node:path";
import { readDatasetSetup } from "@/services/dataset/secure-store";
import { DATASET_SYNC_NAMES, type DatasetSyncName } from "@/types/dataset-sync";
import { EXECUTABLE_DATASET_TYPES } from "@/types/dataset-execution";
import {
  createEmptySchedule,
  normalizeCustomDays,
  normalizeCustomTimes,
  normalizeHhMm,
  parseLegacyCronToCustom,
  DEFAULT_CUSTOM_DAYS,
  DEFAULT_CUSTOM_TIMES,
  type DatasetAutomationSchedule,
  type DatasetSchedulesStore,
  type ScheduleFrequency,
  type ScheduleRunStatus,
} from "@/types/dataset-schedule";

const STORE_PATH = path.join(process.cwd(), ".data", "dataset-schedules.json");

async function readStoreRaw(): Promise<DatasetSchedulesStore | null> {
  try {
    const raw = await fs.readFile(STORE_PATH, "utf8");
    const parsed = JSON.parse(raw) as DatasetSchedulesStore;
    if (parsed?.version === 1 && Array.isArray(parsed.schedules)) return parsed;
  } catch {
    // missing
  }
  return null;
}

async function writeStore(store: DatasetSchedulesStore) {
  await fs.mkdir(path.dirname(STORE_PATH), { recursive: true });
  await fs.writeFile(
    STORE_PATH,
    JSON.stringify({ ...store, updatedAt: new Date().toISOString() }, null, 2),
    "utf8"
  );
}

function isFrequency(value: unknown): value is ScheduleFrequency | "custom_cron" {
  return (
    value === "daily" ||
    value === "weekdays" ||
    value === "weekly" ||
    value === "hourly" ||
    value === "custom" ||
    value === "custom_cron"
  );
}

function resolveFrequency(value: unknown): ScheduleFrequency {
  if (value === "custom_cron") return "custom";
  if (
    value === "daily" ||
    value === "weekdays" ||
    value === "weekly" ||
    value === "hourly" ||
    value === "custom"
  ) {
    return value;
  }
  return "daily";
}

function normalizeDatasetNames(value: unknown): DatasetSyncName[] {
  if (!Array.isArray(value)) return [...EXECUTABLE_DATASET_TYPES];
  const names = value.filter((item): item is DatasetSyncName =>
    DATASET_SYNC_NAMES.includes(item as DatasetSyncName)
  );
  return names.length > 0 ? Array.from(new Set(names)) : [...EXECUTABLE_DATASET_TYPES];
}

function normalizeSchedule(
  raw: Partial<DatasetAutomationSchedule> & {
    frequency?: ScheduleFrequency | "custom_cron";
    customCron?: string;
  }
): DatasetAutomationSchedule {
  const frequency = resolveFrequency(raw.frequency);
  const syncTime = normalizeHhMm(
    typeof raw.syncTime === "string" ? raw.syncTime : "07:00"
  );

  let customDays = normalizeCustomDays(raw.customDays);
  let customTimes = normalizeCustomTimes(raw.customTimes);

  // Migrate legacy custom_cron → custom days/times
  if (
    ((raw.frequency as string) === "custom_cron" || frequency === "custom") &&
    (!raw.customDays || !raw.customTimes) &&
    typeof raw.customCron === "string" &&
    raw.customCron.trim()
  ) {
    const parsed = parseLegacyCronToCustom(raw.customCron);
    if (!raw.customDays?.length) customDays = parsed.customDays;
    if (!raw.customTimes?.length) customTimes = parsed.customTimes;
  }

  if (frequency === "custom") {
    if (customDays.length === 0) customDays = [...DEFAULT_CUSTOM_DAYS];
    if (customTimes.length === 0) {
      customTimes = [syncTime || DEFAULT_CUSTOM_TIMES[0]];
    }
  }

  const base = createEmptySchedule({
    ...raw,
    frequency,
    syncTime,
    customDays,
    customTimes,
  });

  return {
    ...base,
    name: (raw.name ?? base.name).trim() || "Untitled schedule",
    frequency,
    syncTime,
    dayOfWeek:
      typeof raw.dayOfWeek === "number" && raw.dayOfWeek >= 0 && raw.dayOfWeek <= 6
        ? Math.floor(raw.dayOfWeek)
        : 1,
    customDays,
    customTimes,
    datasetNames: normalizeDatasetNames(raw.datasetNames),
    enabled: raw.enabled !== false,
    paused: Boolean(raw.paused),
    lastRunAt: raw.lastRunAt ?? null,
    lastRunStatus: (raw.lastRunStatus as ScheduleRunStatus) ?? null,
    lastRunMessage: raw.lastRunMessage ?? null,
    lastDurationMs:
      typeof raw.lastDurationMs === "number" ? raw.lastDurationMs : null,
  };
}

async function migrateFromSetupIfNeeded(): Promise<DatasetSchedulesStore> {
  const setup = await readDatasetSetup();
  if (!setup) {
    return {
      version: 1,
      updatedAt: new Date().toISOString(),
      schedules: [],
    };
  }

  const schedule = createEmptySchedule({
    name:
      setup.syncFrequency === "hourly"
        ? "Every hour"
        : setup.syncFrequency === "weekdays"
          ? "Weekdays sync"
          : (setup.syncFrequency as string) === "custom" ||
              (setup.syncFrequency as string) === "custom_cron"
            ? "Custom sync"
            : "Daily morning sync",
    frequency: resolveFrequency(setup.syncFrequency as string),
    syncTime: setup.syncTime || "07:00",
    customDays:
      (setup as { customDays?: number[] }).customDays ??
      [...DEFAULT_CUSTOM_DAYS],
    customTimes:
      (setup as { customTimes?: string[] }).customTimes ??
      (setup.syncTime ? [setup.syncTime] : [...DEFAULT_CUSTOM_TIMES]),
    customCron: setup.customCron,
    datasetNames: DATASET_SYNC_NAMES.filter(
      (name) =>
        setup.datasets?.[name]?.enabled !== false &&
        EXECUTABLE_DATASET_TYPES.includes(
          name as (typeof EXECUTABLE_DATASET_TYPES)[number]
        )
    ),
    enabled: true,
    paused: false,
  });

  const store: DatasetSchedulesStore = {
    version: 1,
    updatedAt: new Date().toISOString(),
    schedules: [schedule],
  };
  await writeStore(store);
  return store;
}

export async function listAutomationSchedules(): Promise<
  DatasetAutomationSchedule[]
> {
  const stored = await readStoreRaw();
  if (stored) {
    return stored.schedules.map((item) => normalizeSchedule(item));
  }
  const migrated = await migrateFromSetupIfNeeded();
  return migrated.schedules.map((item) => normalizeSchedule(item));
}

export async function getAutomationSchedule(
  id: string
): Promise<DatasetAutomationSchedule | null> {
  const schedules = await listAutomationSchedules();
  return schedules.find((item) => item.id === id) ?? null;
}

export async function saveAutomationSchedules(
  schedules: DatasetAutomationSchedule[]
): Promise<DatasetAutomationSchedule[]> {
  const normalized = schedules.map((item) =>
    normalizeSchedule({ ...item, updatedAt: new Date().toISOString() })
  );
  await writeStore({
    version: 1,
    updatedAt: new Date().toISOString(),
    schedules: normalized,
  });
  return normalized;
}

export async function upsertAutomationSchedule(
  input: Partial<DatasetAutomationSchedule> & {
    name?: string;
    frequency?: ScheduleFrequency;
  }
): Promise<DatasetAutomationSchedule> {
  const schedules = await listAutomationSchedules();
  const now = new Date().toISOString();

  if (input.id) {
    const index = schedules.findIndex((item) => item.id === input.id);
    if (index < 0) throw new Error("Schedule not found.");
    const next = normalizeSchedule({
      ...schedules[index],
      ...input,
      id: schedules[index].id,
      createdAt: schedules[index].createdAt,
      updatedAt: now,
      lastRunAt: schedules[index].lastRunAt,
      lastRunStatus: schedules[index].lastRunStatus,
      lastRunMessage: schedules[index].lastRunMessage,
      lastDurationMs: schedules[index].lastDurationMs,
    });
    // Preserve run stats unless explicitly provided
    if (input.lastRunAt === undefined) next.lastRunAt = schedules[index].lastRunAt;
    if (input.lastRunStatus === undefined) {
      next.lastRunStatus = schedules[index].lastRunStatus;
    }
    if (input.lastRunMessage === undefined) {
      next.lastRunMessage = schedules[index].lastRunMessage;
    }
    if (input.lastDurationMs === undefined) {
      next.lastDurationMs = schedules[index].lastDurationMs;
    }
    schedules[index] = next;
    await saveAutomationSchedules(schedules);
    return next;
  }

  const created = normalizeSchedule({
    ...input,
    id: undefined,
    createdAt: now,
    updatedAt: now,
  });
  schedules.push(created);
  await saveAutomationSchedules(schedules);
  return created;
}

export async function deleteAutomationSchedule(id: string) {
  const schedules = await listAutomationSchedules();
  const next = schedules.filter((item) => item.id !== id);
  if (next.length === schedules.length) {
    throw new Error("Schedule not found.");
  }
  await saveAutomationSchedules(next);
  return next;
}

export async function updateScheduleRunResult(
  id: string,
  result: {
    lastRunAt: string;
    lastRunStatus: ScheduleRunStatus;
    lastRunMessage: string;
    lastDurationMs: number;
  }
) {
  const schedules = await listAutomationSchedules();
  const index = schedules.findIndex((item) => item.id === id);
  if (index < 0) return;
  schedules[index] = {
    ...schedules[index],
    ...result,
    updatedAt: new Date().toISOString(),
  };
  await saveAutomationSchedules(schedules);
}

export function validateScheduleInput(
  body: unknown
): { ok: true; data: Partial<DatasetAutomationSchedule> } | { ok: false; error: string } {
  if (!body || typeof body !== "object") {
    return { ok: false, error: "Invalid schedule payload." };
  }
  const input = body as Record<string, unknown>;
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) return { ok: false, error: "Enter a schedule name." };

  if (!isFrequency(input.frequency)) {
    return { ok: false, error: "Select a valid schedule frequency." };
  }
  const frequency = resolveFrequency(input.frequency);

  const syncTime = normalizeHhMm(
    typeof input.syncTime === "string" ? input.syncTime : "07:00"
  );
  if (
    (frequency === "daily" ||
      frequency === "weekdays" ||
      frequency === "weekly") &&
    !/^\d{1,2}:\d{2}$/.test(syncTime)
  ) {
    return { ok: false, error: "Enter a valid sync time (HH:MM)." };
  }

  let customDays = normalizeCustomDays(input.customDays);
  let customTimes = normalizeCustomTimes(input.customTimes);

  if (frequency === "custom") {
    if (customDays.length === 0) {
      return { ok: false, error: "Select at least one day for the custom schedule." };
    }
    if (customTimes.length === 0) {
      return {
        ok: false,
        error: "Add at least one time for the custom schedule.",
      };
    }
  }

  const datasetNames = normalizeDatasetNames(input.datasetNames);
  if (datasetNames.length === 0) {
    return { ok: false, error: "Select at least one dataset." };
  }

  const dayOfWeek =
    typeof input.dayOfWeek === "number" ? input.dayOfWeek : Number(input.dayOfWeek);
  return {
    ok: true,
    data: {
      id: typeof input.id === "string" ? input.id : undefined,
      name,
      frequency,
      syncTime: customTimes[0] ?? syncTime,
      dayOfWeek:
        Number.isFinite(dayOfWeek) && dayOfWeek >= 0 && dayOfWeek <= 6
          ? Math.floor(dayOfWeek)
          : 1,
      customDays,
      customTimes,
      datasetNames,
      enabled: input.enabled !== false,
      paused: Boolean(input.paused),
    },
  };
}
