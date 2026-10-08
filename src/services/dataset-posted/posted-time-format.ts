/**
 * IST time formatting for Posted-button messages ("started HH:MM IST",
 * "Last Posted: <date time IST>").
 *
 * Deliberately uses `Intl.DateTimeFormat` with an explicit `timeZone`
 * rather than local `Date` getters — the prod container has no `TZ` env
 * var set and runs in UTC, and a prior bug (see project memory:
 * `lateral-master-sheet-page.tsx`'s `formatLastRunDateTime`) showed that
 * local-getter formatting silently mislabels UTC as IST. Not fixing that
 * existing bug here (out of scope, deliberately deferred elsewhere) — just
 * not repeating it in new code.
 */

const IST_TIME_ZONE = "Asia/Kolkata";

export function formatIstTime(iso: string | null | undefined): string {
  if (!iso) return "unknown time";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "unknown time";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: IST_TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(d);
}

export function formatIstDateTime(iso: string | null | undefined): string {
  if (!iso) return "unknown time";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "unknown time";
  const datePart = new Intl.DateTimeFormat("en-GB", {
    timeZone: IST_TIME_ZONE,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(d);
  const timePart = formatIstTime(iso);
  return `${datePart} ${timePart} IST`;
}
