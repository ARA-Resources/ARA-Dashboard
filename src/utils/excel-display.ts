/**
 * Polish Excel cell / filter labels for consistent UI display.
 * Matching stays case-insensitive in apply-filters.
 */

const YES_NO: Record<string, string> = {
  yes: "YES",
  no: "NO",
};

const STATUS_WORDS: Record<string, string> = {
  active: "Active",
  new: "New",
  closed: "Closed",
  reopen: "Reopen",
  reopened: "Reopen",
  posted: "Posted",
  stale: "Stale",
};

function pad2(n: number) {
  return String(n).padStart(2, "0");
}

function fromUtcParts(year: number, month: number, day: number): string {
  return `${pad2(day)}-${pad2(month)}-${year}`;
}

/**
 * Format a cell value as DD-MM-YYYY when it represents a date.
 * Returns null when the value is not a recognizable date.
 */
export function formatExcelDateDdMmYyyy(
  value: string | number | null | undefined
): string | null {
  if (value === null || value === undefined || value === "") return null;

  if (typeof value === "number" && Number.isFinite(value)) {
    // Excel serial date (approx range covering 1954–2064)
    if (value > 20000 && value < 60000) {
      const utc = Date.UTC(1899, 11, 30) + Math.floor(value) * 86400000;
      const d = new Date(utc);
      return fromUtcParts(
        d.getUTCFullYear(),
        d.getUTCMonth() + 1,
        d.getUTCDate()
      );
    }
    return null;
  }

  const text = String(value).replace(/\s+/g, " ").trim();
  if (!text) return null;

  // Already DD-MM-YYYY
  if (/^\d{2}-\d{2}-\d{4}$/.test(text)) return text;

  // ISO / Excel normalize: YYYY-MM-DD (optional time)
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s].*)?$/);
  if (iso) {
    return `${iso[3]}-${iso[2]}-${iso[1]}`;
  }

  // DD/MM/YYYY or DD.MM.YYYY
  const dmy = text.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/);
  if (dmy) {
    return `${pad2(Number(dmy[1]))}-${pad2(Number(dmy[2]))}-${dmy[3]}`;
  }

  return null;
}

/** Convert YYYY-MM-DD (filter storage) → DD-MM-YYYY (UI). */
export function isoDateToDdMmYyyy(iso: string | undefined | null): string {
  if (!iso) return "";
  const m = String(iso).trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) {
    // Already DD-MM-YYYY
    if (/^\d{2}-\d{2}-\d{4}$/.test(String(iso).trim())) return String(iso).trim();
    return "";
  }
  return `${m[3]}-${m[2]}-${m[1]}`;
}

/**
 * Parse a typed date string into YYYY-MM-DD for filter storage.
 * Accepts DD-MM-YYYY (preferred) and YYYY-MM-DD.
 * Returns null when incomplete/invalid.
 */
export function parseDateInputToIso(raw: string): string | null {
  const text = String(raw ?? "").trim();
  if (!text) return null;

  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    const y = Number(iso[1]);
    const mo = Number(iso[2]);
    const d = Number(iso[3]);
    if (!isValidCalendarDate(y, mo, d)) return null;
    return `${iso[1]}-${iso[2]}-${iso[3]}`;
  }

  const dmy = text.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
  if (dmy) {
    const d = Number(dmy[1]);
    const mo = Number(dmy[2]);
    const y = Number(dmy[3]);
    if (!isValidCalendarDate(y, mo, d)) return null;
    return `${y}-${pad2(mo)}-${pad2(d)}`;
  }

  return null;
}

function isValidCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const dt = new Date(Date.UTC(year, month - 1, day));
  return (
    dt.getUTCFullYear() === year &&
    dt.getUTCMonth() === month - 1 &&
    dt.getUTCDate() === day
  );
}

/** Mask digits into DD-MM-YYYY while typing. */
export function maskDdMmYyyyInput(raw: string): string {
  const digits = String(raw ?? "").replace(/\D/g, "").slice(0, 8);
  if (digits.length <= 2) return digits;
  if (digits.length <= 4) return `${digits.slice(0, 2)}-${digits.slice(2)}`;
  return `${digits.slice(0, 2)}-${digits.slice(2, 4)}-${digits.slice(4)}`;
}

/** True when a Master Sheet header is a date-like column. */
export function isExcelDateColumnHeader(header: string): boolean {
  const name = header.trim();
  if (!name) return false;
  return (
    /^(date|opened|closed|updated|created)/i.test(name) ||
    /\bdate\b/i.test(name)
  );
}

export function polishExcelDisplayValue(
  value: string | number | null | undefined
): string {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "number") return String(value);

  const trimmed = String(value).replace(/\s+/g, " ").trim();
  if (!trimmed) return "";

  const lower = trimmed.toLowerCase();

  if (YES_NO[lower]) return YES_NO[lower];
  if (STATUS_WORDS[lower]) return STATUS_WORDS[lower];

  return trimmed;
}

/**
 * Collapse case variants (YEs / YES / yes) into one polished label.
 * Returns unique values suitable for filter chips.
 */
export function uniquePolishedValues(rawValues: string[]): string[] {
  const byKey = new Map<string, string>();

  for (const raw of rawValues) {
    const polished = polishExcelDisplayValue(raw);
    if (!polished) continue;
    const key = polished.toLowerCase();
    if (!byKey.has(key)) byKey.set(key, polished);
  }

  return [...byKey.values()].sort((a, b) => a.localeCompare(b));
}
