import type { CellValue } from "exceljs";

export function normalizeCellValue(value: CellValue): string | number | null {
  if (value === null || value === undefined) return null;

  if (typeof value === "string") {
    const trimmed = value.replace(/\s+/g, " ").trim();
    return trimmed.length ? trimmed : null;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === "boolean") {
    return value ? "TRUE" : "FALSE";
  }

  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }

  if (typeof value === "object") {
    if ("richText" in value && Array.isArray(value.richText)) {
      const text = value.richText
        .map((part) => part.text ?? "")
        .join("")
        .replace(/\s+/g, " ")
        .trim();
      return text.length ? text : null;
    }

    if ("text" in value && typeof value.text === "string") {
      const text = value.text.replace(/\s+/g, " ").trim();
      return text.length ? text : null;
    }

    if ("formula" in value || "sharedFormula" in value) {
      const result = "result" in value ? value.result : undefined;
      if (result === undefined || result === null) return null;
      if (result instanceof Error) return null;
      return normalizeCellValue(result as CellValue);
    }

    if ("error" in value) return null;
  }

  return String(value);
}

export function toHeaderKey(label: string, index: number, used: Set<string>) {
  const base = label.trim() || `Column ${index + 1}`;
  let key = base;
  let suffix = 2;
  while (used.has(key)) {
    key = `${base} (${suffix})`;
    suffix += 1;
  }
  used.add(key);
  return key;
}
