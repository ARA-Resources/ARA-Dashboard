import type {
  DatasetKeywordConfig,
  KeywordMatchMode,
} from "@/types/dataset-setup";
import { getEnabledKeywords } from "@/types/dataset-setup";

export type KeywordMatchField = "subject" | "body" | "attachment";

export interface KeywordMatchResult {
  keyword: string;
  matchMode: KeywordMatchMode;
  matchedIn: KeywordMatchField;
  priority: number;
}

function stripHtml(html: string) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeBodyData(data?: string | null): string {
  if (!data) return "";
  try {
    const normalized = data.replace(/-/g, "+").replace(/_/g, "/");
    return Buffer.from(normalized, "base64").toString("utf8");
  } catch {
    return "";
  }
}

/** Extract searchable plain text from a Gmail message payload. */
export function extractMessageBodyText(payload: {
  mimeType?: string | null;
  filename?: string | null;
  body?: { data?: string | null } | null;
  parts?: Array<{
    mimeType?: string | null;
    filename?: string | null;
    body?: { data?: string | null } | null;
    parts?: unknown[];
  }> | null;
} | null | undefined): string {
  if (!payload) return "";

  const chunks: string[] = [];

  type Part = NonNullable<typeof payload>;

  function walk(part: Part | null | undefined) {
    if (!part) return;
    const filename = part.filename?.trim() ?? "";
    if (filename) return; // skip attachment parts
    const mime = (part.mimeType ?? "").toLowerCase();
    const decoded = decodeBodyData(part.body?.data);
    if (decoded) {
      if (mime.includes("text/html")) chunks.push(stripHtml(decoded));
      else if (mime.includes("text/plain") || !mime) chunks.push(decoded);
    }
    for (const child of (part.parts as Part[] | undefined) ?? []) {
      walk(child);
    }
  }

  walk(payload);
  return chunks.join(" ").replace(/\s+/g, " ").trim();
}

export function keywordMatchesText(
  keyword: DatasetKeywordConfig,
  text: string
): boolean {
  const needle = keyword.value.trim();
  if (!needle) return false;
  const haystack = text ?? "";

  switch (keyword.matchMode) {
    case "exact":
      return haystack.trim().toLowerCase() === needle.toLowerCase();
    case "starts_with":
      return haystack.toLowerCase().startsWith(needle.toLowerCase());
    case "ends_with":
      return haystack.toLowerCase().endsWith(needle.toLowerCase());
    case "regex": {
      try {
        return new RegExp(needle, "i").test(haystack);
      } catch {
        return false;
      }
    }
    case "contains":
    default:
      return haystack.toLowerCase().includes(needle.toLowerCase());
  }
}

/**
 * Find the highest-priority keyword that matches subject, body, or attachment name.
 * Returns null when keywords are configured but none match.
 */
export function findBestKeywordMatch(
  keywords: DatasetKeywordConfig[],
  fields: {
    subject: string;
    body: string;
    attachmentName: string;
  }
): KeywordMatchResult | null {
  const enabled = [...keywords]
    .filter((keyword) => keyword.enabled && keyword.value.trim())
    .sort(
      (a, b) => a.priority - b.priority || a.value.localeCompare(b.value)
    );

  if (enabled.length === 0) return null;

  for (const keyword of enabled) {
    // Match order: attachment filename → subject → body
    const checks: Array<[KeywordMatchField, string]> = [
      ["attachment", fields.attachmentName],
      ["subject", fields.subject],
      ["body", fields.body],
    ];
    for (const [matchedIn, text] of checks) {
      if (keywordMatchesText(keyword, text)) {
        return {
          keyword: keyword.value,
          matchMode: keyword.matchMode,
          matchedIn,
          priority: keyword.priority,
        };
      }
    }
  }

  return null;
}

/**
 * When no keywords are enabled, reject (keywords are required for dataset assignment).
 * When keywords exist, require at least one match on attachment, subject, or body.
 */
export function resolveKeywordMatchForConfig(
  config: { keywords?: DatasetKeywordConfig[] } | null | undefined,
  fields: {
    subject: string;
    body: string;
    attachmentName: string;
  }
): { ok: true; match: KeywordMatchResult | null } | { ok: false } {
  const enabled = getEnabledKeywords(
    config as Parameters<typeof getEnabledKeywords>[0]
  );
  if (enabled.length === 0) {
    return { ok: false };
  }
  const match = findBestKeywordMatch(enabled, fields);
  if (!match) return { ok: false };
  return { ok: true, match };
}

export function formatKeywordMatchLabel(
  match: KeywordMatchResult | null | undefined
): string {
  if (!match) return "—";
  const where =
    match.matchedIn === "attachment"
      ? "attachment"
      : match.matchedIn === "subject"
        ? "subject"
        : "body";
  return `${match.keyword} (${where})`;
}
