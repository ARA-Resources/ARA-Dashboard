/**
 * Stage 30A: processing date formatting for preview mapped rows.
 * Matches Next lateral-new-sheet-refresh.ts (preview subset).
 */

export function formatProcessingDateDDMMYYYY(date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getDate())}-${pad(date.getMonth() + 1)}-${date.getFullYear()}`;
}
