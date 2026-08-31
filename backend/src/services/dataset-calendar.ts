const DATASET_TZ =
  process.env.ARA_DATASET_TZ?.trim() ||
  process.env.TZ?.trim().replace(/^:/, "") ||
  "Asia/Kolkata";

/** Calendar day in YYYY-MM-DD for the dataset timezone. */
export function getCalendarDateInTimezone(
  date: Date = new Date(),
  timeZone = DATASET_TZ
): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}
