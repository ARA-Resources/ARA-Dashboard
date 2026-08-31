export function polishExcelDisplayValue(
  value: string | number | null | undefined
): string {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "number") return String(value);

  const trimmed = String(value).replace(/\s+/g, " ").trim();
  if (!trimmed) return "";

  const lower = trimmed.toLowerCase();

  const yesNo: Record<string, string> = { yes: "YES", no: "NO" };
  if (yesNo[lower]) return yesNo[lower];

  const statusWords: Record<string, string> = {
    active: "Active",
    new: "New",
    closed: "Closed",
    reopen: "Reopen",
    reopened: "Reopen",
    posted: "Posted",
    stale: "Stale",
  };
  if (statusWords[lower]) return statusWords[lower];

  return trimmed;
}
