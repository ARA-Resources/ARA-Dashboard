/**
 * Excel serial date -> calendar date, for the Accenture Final Report's
 * dated master-sheet export (replay mode only — the classic single-row
 * export has no Date column, so nothing else in this codebase has ever
 * needed this conversion; confirmed by grep, there is no prior helper).
 *
 * Excel's epoch is 1899-12-30 (not 1900-01-01), which is what makes its
 * fake 1900-02-29 leap-day bug fall out for free for every real-world date
 * past 1900 — the standard conversion, not a workaround. SheetJS's
 * `raw: true` read mode (used throughout this file's own parser) gives the
 * bare serial number for a date cell, same as any other numeric cell, so
 * `cellToText` has already turned it into a plain decimal string like
 * "46048" by the time it reaches here.
 *
 * Every step this replay engine logs is stamped at noon India Standard
 * Time of its file date (not midnight, not the literal file date with no
 * time at all) — a fixed, unambiguous instant per calendar day, chosen so
 * no day-boundary rounding in either direction can push a step's
 * `changed_at` into the wrong calendar day once stored as UTC.
 */

const EXCEL_EPOCH_UTC_MS = Date.UTC(1899, 11, 30);
const MS_PER_DAY = 86_400_000;
const NOON_IST_UTC_HOUR = 6; // noon IST (UTC+5:30) = 06:30 UTC
const NOON_IST_UTC_MINUTE = 30;

/** Raw "Date" cell text (an Excel serial number, as `cellToText` renders it) -> noon IST of that calendar day. Null if unparseable. */
export function parseAccentureReportDate(raw: string): Date | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const serial = Number(trimmed);
  if (!Number.isFinite(serial) || serial <= 0) return null;
  const dayIndex = Math.floor(serial);
  const utcMidnight = new Date(EXCEL_EPOCH_UTC_MS + dayIndex * MS_PER_DAY);
  return new Date(
    Date.UTC(
      utcMidnight.getUTCFullYear(),
      utcMidnight.getUTCMonth(),
      utcMidnight.getUTCDate(),
      NOON_IST_UTC_HOUR,
      NOON_IST_UTC_MINUTE,
      0,
      0
    )
  );
}

/** YYYY-MM-DD (UTC calendar day) for grouping/same-day-dedupe — independent of the noon-IST time-of-day above. */
export function accentureReportDateKey(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const serial = Number(trimmed);
  if (!Number.isFinite(serial) || serial <= 0) return null;
  const dayIndex = Math.floor(serial);
  const utcMidnight = new Date(EXCEL_EPOCH_UTC_MS + dayIndex * MS_PER_DAY);
  return utcMidnight.toISOString().slice(0, 10);
}

/**
 * The exclusive upper-bound UTC instant for "on or before the end of
 * `dateKey` in India Standard Time" — i.e. the post-cutoff freeze guard
 * (candidate-accenture-replay-engine.ts) treats any `changed_at` `>=` this
 * instant as after the file's last report date. `dateKey` is a plain
 * "YYYY-MM-DD" (as returned by `accentureReportDateKey`), always a real
 * calendar day with no time-of-day component — end of that day in IST is
 * the start of the next IST day, 18.5 hours after that day's UTC midnight
 * (IST is UTC+5:30, no DST).
 */
export function istEndOfDayExclusiveUtc(dateKey: string): Date {
  const utcMidnight = new Date(`${dateKey}T00:00:00.000Z`);
  return new Date(utcMidnight.getTime() + 18.5 * 60 * 60 * 1000);
}
