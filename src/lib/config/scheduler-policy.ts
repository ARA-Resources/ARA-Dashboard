/**
 * Automatic Lateral scheduler policy.
 * Manual Run All (invokeLateralJob "manual") is independent of this flag.
 */
import { isProductionEnv } from "@/lib/config/runtime";

function trimEnv(name: string): string {
  return process.env[name]?.trim() ?? "";
}

/**
 * Whether cron auto-run may arm.
 * - ARA_DATASET_SCHEDULER=0/false/off → disabled
 * - ARA_DATASET_SCHEDULER=1/true/on → enabled
 * - absent in development → enabled (existing local behavior)
 * - absent in production → disabled (explicit 1 required)
 */
export function isDatasetSchedulerAutoEnabled(): boolean {
  const raw = trimEnv("ARA_DATASET_SCHEDULER").toLowerCase();
  if (raw === "0" || raw === "false" || raw === "off" || raw === "no") {
    return false;
  }
  if (raw === "1" || raw === "true" || raw === "on" || raw === "yes") {
    return true;
  }
  return !isProductionEnv();
}

export function datasetSchedulerPolicyReason(): string {
  const raw = trimEnv("ARA_DATASET_SCHEDULER");
  if (raw === "0" || raw.toLowerCase() === "false" || raw.toLowerCase() === "off") {
    return "ARA_DATASET_SCHEDULER=0";
  }
  if (raw === "1" || raw.toLowerCase() === "true" || raw.toLowerCase() === "on") {
    return "ARA_DATASET_SCHEDULER=1";
  }
  if (isProductionEnv()) {
    return "production default (ARA_DATASET_SCHEDULER unset)";
  }
  return "development default (ARA_DATASET_SCHEDULER unset)";
}

/** Calendar minute in the scheduler timezone, e.g. 2026-08-18T09:00 */
export function scheduleMinuteKey(atMs: number, timezone: string): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = fmt.formatToParts(new Date(atMs));
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}

/**
 * Skip a cron tick in the same timezone minute as when cron was armed.
 * Prevents an immediate Run All when the process starts at 09:00 or 11:00.
 * A start at 10:59 still allows 11:00. Missed past slots are not replayed
 * (node-cron does not catch up; this only covers the current minute).
 */
export function shouldSkipScheduledTickAfterArm(options: {
  armedAtMs: number;
  nowMs: number;
  timezone: string;
}): boolean {
  return (
    scheduleMinuteKey(options.armedAtMs, options.timezone) ===
    scheduleMinuteKey(options.nowMs, options.timezone)
  );
}

export function logDatasetSchedulerPolicy(): void {
  if (isDatasetSchedulerAutoEnabled()) {
    console.info(
      `[config] Automatic Lateral scheduler allowed (${datasetSchedulerPolicyReason()}). Manual Run All is independent.`
    );
    return;
  }
  console.info(
    `[config] Automatic Lateral scheduler is not armed (${datasetSchedulerPolicyReason()}). Manual operator Run All is unchanged.`
  );
}

/**
 * Automatic Executive scheduler policy (Phase E5).
 *
 * Deliberately a SEPARATE env var from ARA_DATASET_SCHEDULER — Lateral's
 * flag is already set to enable Lateral's cron in production, and reusing
 * it here would auto-arm Executive's cron the moment this code deploys.
 * The user explicitly required an independent, conscious enable step.
 *
 * Also deliberately stricter than Lateral's own default: Lateral treats an
 * absent env var as "enabled" in development for local convenience. Executive
 * defaults to OFF unconditionally (dev AND production) when unset — this is
 * a brand-new, unproven-in-production pipeline, not an established one.
 *
 * - ARA_EXECUTIVE_SCHEDULER=0/false/off → disabled
 * - ARA_EXECUTIVE_SCHEDULER=1/true/on → enabled
 * - absent (dev or production) → disabled
 *
 * Even when this returns true, cron still only arms when
 * `executive_scheduler_state.enabled` is also true (defaults to FALSE —
 * see migration 010) and not paused. Both gates must be explicitly opened.
 */
export function isExecutiveDatasetSchedulerAutoEnabled(): boolean {
  const raw = trimEnv("ARA_EXECUTIVE_SCHEDULER").toLowerCase();
  if (raw === "1" || raw === "true" || raw === "on" || raw === "yes") {
    return true;
  }
  return false;
}

export function executiveDatasetSchedulerPolicyReason(): string {
  const raw = trimEnv("ARA_EXECUTIVE_SCHEDULER");
  if (raw === "0" || raw.toLowerCase() === "false" || raw.toLowerCase() === "off") {
    return "ARA_EXECUTIVE_SCHEDULER=0";
  }
  if (raw === "1" || raw.toLowerCase() === "true" || raw.toLowerCase() === "on") {
    return "ARA_EXECUTIVE_SCHEDULER=1";
  }
  return "default (ARA_EXECUTIVE_SCHEDULER unset — Executive cron does not auto-arm until explicitly enabled)";
}

export function logExecutiveSchedulerPolicy(): void {
  if (isExecutiveDatasetSchedulerAutoEnabled()) {
    console.info(
      `[config] Automatic Executive scheduler allowed (${executiveDatasetSchedulerPolicyReason()}). Manual Run All is independent.`
    );
    return;
  }
  console.info(
    `[config] Automatic Executive scheduler is not armed (${executiveDatasetSchedulerPolicyReason()}). Manual operator Run All is unchanged.`
  );
}
