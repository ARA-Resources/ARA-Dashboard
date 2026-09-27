/**
 * Automatic Lateral scheduler policy.
 * Manual Run All (invokeLateralJob "manual") is independent of this flag.
 */
import { isProductionEnv } from "@/lib/config/runtime";

function trimEnv(name: string): string {
  return process.env[name]?.trim() ?? "";
}

const FLAG_ON = ["1", "true", "on", "yes"];
const FLAG_OFF = ["0", "false", "off", "no"];

/** "on" / "off" for a recognized flag value, null when unset or unrecognized. */
function readFlag(name: string): "on" | "off" | null {
  const raw = trimEnv(name).toLowerCase();
  if (FLAG_ON.includes(raw)) return "on";
  if (FLAG_OFF.includes(raw)) return "off";
  return null;
}

/**
 * Human-readable reason for a scheduler flag's effective state. Never prints
 * the raw value (only its length) — a mis-pasted secret could land here, as
 * a redaction placeholder once did in production.
 */
function describeFlag(name: string, fallbackText: string): string {
  const flag = readFlag(name);
  if (flag === "on") return `${name}=1`;
  if (flag === "off") return `${name}=0`;
  const raw = trimEnv(name);
  if (raw) {
    return `${name} has an unrecognized value (${raw.length} chars) — treated as ${fallbackText}; use 1 or 0`;
  }
  return `${name} unset — ${fallbackText}`;
}

/**
 * Whether cron auto-run may arm.
 * - ARA_DATASET_SCHEDULER=0/false/off → disabled
 * - ARA_DATASET_SCHEDULER=1/true/on → enabled
 * - absent in development → enabled (existing local behavior)
 * - absent in production → disabled (explicit 1 required)
 */
export function isDatasetSchedulerAutoEnabled(): boolean {
  const flag = readFlag("ARA_DATASET_SCHEDULER");
  if (flag === "off") return false;
  if (flag === "on") return true;
  return !isProductionEnv();
}

export function datasetSchedulerPolicyReason(): string {
  return describeFlag(
    "ARA_DATASET_SCHEDULER",
    isProductionEnv() ? "off (production default)" : "on (development default)"
  );
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
  return readFlag("ARA_EXECUTIVE_SCHEDULER") === "on";
}

export function executiveDatasetSchedulerPolicyReason(): string {
  return describeFlag(
    "ARA_EXECUTIVE_SCHEDULER",
    "off (default — Executive cron does not auto-arm until explicitly enabled)"
  );
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
