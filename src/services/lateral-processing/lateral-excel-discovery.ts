import type { gmail_v1 } from "googleapis";
import {
  extractExcelAttachmentsFromMessage,
  type RawGmailAttachment,
} from "@/services/gmail/attachments";
import {
  fileTypeClauseForQuery,
  toGmailEpochSeconds,
} from "@/services/gmail/query";
import type {
  DatasetFileType,
  DatasetKeywordConfig,
} from "@/types/dataset-setup";
import { DEFAULT_FILE_TYPES } from "@/types/dataset-setup";

function enabledLateralKeywords(
  keywords: DatasetKeywordConfig[] | undefined
): DatasetKeywordConfig[] {
  return [...(keywords ?? [])]
    .filter((keyword) => keyword.enabled && keyword.value.trim())
    .sort(
      (a, b) => a.priority - b.priority || a.value.localeCompare(b.value)
    );
}

/** Lateral Excel discovery supports only these extensions. */
export const LATERAL_EXCEL_EXTENSIONS = ["xlsx", "xlsm", "xls"] as const;

export interface LateralAttachmentSelection {
  selected: RawGmailAttachment;
  /** Why this attachment was chosen (never silent / random) */
  selectionReason: string;
  /** Other Excel attachments on the same email that were not chosen */
  rejectedAttachments: Array<{
    attachmentName: string;
    attachmentId: string;
    reason: string;
  }>;
}

export interface LateralDiscoveredEmail {
  messageId: string;
  threadId: string;
  subject: string;
  sender: string;
  receivedAt: string;
  receivedAtMs: number;
  selection: LateralAttachmentSelection;
}

/**
 * Exact ORIGINAL Excel basename for Google Drive (visible name).
 * No timestamps, UUIDs, random suffixes, "processed", or "copy" added.
 */
export function originalExcelFilenameForDrive(originalFilename: string): string {
  const base = (originalFilename || "").split(/[/\\]/).pop()?.trim() || "";
  if (!base) {
    throw new Error("Attachment has no original filename.");
  }
  if (!/\.(xlsx|xlsm|xls)$/i.test(base)) {
    throw new Error(
      `Attachment is not a supported Excel file (.xlsx/.xlsm/.xls): ${base}`
    );
  }
  return base;
}

/**
 * Local-disk safe form of the original Excel filename.
 * Only replaces characters illegal on Windows/macOS paths.
 * Drive uploads must use {@link originalExcelFilenameForDrive} instead.
 */
export function preserveOriginalExcelFilename(originalFilename: string): string {
  const base = originalExcelFilenameForDrive(originalFilename);
  return base.replace(/[\u0000-\u001f<>:"/\\|?*]/g, "_");
}

/**
 * Quote a keyword for Gmail search when it contains spaces or special chars.
 * No sender (`from:`) filter — any mailbox sender may deliver Lateral Excel.
 */
function gmailSearchTerm(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (/[\s"()]/.test(trimmed)) {
    return `"${trimmed.replace(/"/g, "")}"`;
  }
  return trimmed;
}

/**
 * Build an OR clause from configured Lateral keywords for Gmail search.
 * Gmail matches these against message content, subject, and attachment names.
 * Regex keywords are excluded from the query (still applied client-side).
 */
export function buildLateralKeywordSearchClause(
  keywords: DatasetKeywordConfig[]
): string | null {
  const terms = enabledLateralKeywords(keywords)
    .filter((keyword) => keyword.matchMode !== "regex")
    .map((keyword) => gmailSearchTerm(keyword.value))
    .filter(Boolean);

  if (terms.length === 0) return null;
  return `(${terms.join(" OR ")})`;
}

/**
 * Lateral Gmail discovery query:
 * - after checkpoint timestamp
 * - Excel filenames only (.xlsx / .xlsm / .xls)
 * - configured Lateral keywords (content / subject / filename)
 * - NO hardcoded sender
 */
export function buildLateralExcelDiscoveryQuery(options: {
  afterMs: number;
  keywords: DatasetKeywordConfig[];
  fileTypes?: DatasetFileType[];
}): string {
  const fileTypes =
    options.fileTypes && options.fileTypes.length > 0
      ? options.fileTypes.filter((type) =>
          (LATERAL_EXCEL_EXTENSIONS as readonly string[]).includes(type)
        )
      : [...DEFAULT_FILE_TYPES];

  const parts = [
    "in:inbox",
    `after:${toGmailEpochSeconds(options.afterMs)}`,
    fileTypeClauseForQuery(
      fileTypes.length > 0 ? fileTypes : [...DEFAULT_FILE_TYPES]
    ),
  ];

  const keywordClause = buildLateralKeywordSearchClause(options.keywords);
  if (keywordClause) {
    parts.push(keywordClause);
  }

  return parts.join(" ");
}

function fieldRank(matchedIn: string | undefined): number {
  // Prefer attachment filename matches over subject/body (lower = better).
  if (matchedIn === "attachment") return 0;
  if (matchedIn === "subject") return 1;
  if (matchedIn === "body") return 2;
  return 9;
}

/**
 * Score a Lateral Excel candidate. Lower score wins.
 * Deterministic: attachment match → keyword priority → filename → attachmentId.
 */
export function scoreLateralExcelCandidate(row: RawGmailAttachment): number {
  const where = fieldRank(row.matchedKeyword?.matchedIn);
  const priority = row.matchedKeyword?.priority ?? 999;
  return where * 1_000_000 + priority * 1_000;
}

function compareLateralCandidates(
  a: RawGmailAttachment,
  b: RawGmailAttachment
): number {
  const scoreDiff = scoreLateralExcelCandidate(a) - scoreLateralExcelCandidate(b);
  if (scoreDiff !== 0) return scoreDiff;
  const byName = a.attachmentName.localeCompare(b.attachmentName);
  if (byName !== 0) return byName;
  return a.attachmentId.localeCompare(b.attachmentId);
}

/**
 * When a message has multiple Excel attachments, pick the one that best matches
 * configured Lateral criteria. Never picks randomly.
 */
export function selectLateralExcelAttachment(
  candidates: RawGmailAttachment[]
): LateralAttachmentSelection {
  const excelOnly = candidates.filter((row) =>
    /\.(xlsx|xlsm|xls)$/i.test(row.attachmentName)
  );

  if (excelOnly.length === 0) {
    throw new Error(
      "No Excel attachments (.xlsx/.xlsm/.xls) matched Lateral keywords."
    );
  }

  if (excelOnly.length === 1) {
    const selected = excelOnly[0];
    return {
      selected,
      selectionReason: `Only matching Excel attachment: "${selected.attachmentName}" (keyword "${selected.matchedKeyword?.keyword}" in ${selected.matchedKeyword?.matchedIn}).`,
      rejectedAttachments: [],
    };
  }

  const ranked = [...excelOnly].sort(compareLateralCandidates);
  const selected = ranked[0];
  const rejectedAttachments = ranked.slice(1).map((row) => ({
    attachmentName: row.attachmentName,
    attachmentId: row.attachmentId,
    reason: `Not selected — ranked below "${selected.attachmentName}" (keyword "${row.matchedKeyword?.keyword}" in ${row.matchedKeyword?.matchedIn}, priority ${row.matchedKeyword?.priority ?? "n/a"}).`,
  }));

  return {
    selected,
    selectionReason: `Selected "${selected.attachmentName}" among ${excelOnly.length} Excel attachments: prefer attachment-filename keyword match, then keyword priority, then filename order. Matched keyword "${selected.matchedKeyword?.keyword}" in ${selected.matchedKeyword?.matchedIn}.`,
    rejectedAttachments,
  };
}

/**
 * Discover Lateral Excel on one Gmail message.
 * - Uses configured keywords only (no hardcoded sender)
 * - Matches subject, body, and attachment filename
 * - Excel only: .xlsx / .xlsm / .xls
 */
export function discoverLateralExcelInMessage(
  message: gmail_v1.Schema$Message,
  options: {
    keywords: DatasetKeywordConfig[];
    fileTypes?: DatasetFileType[];
  }
): LateralDiscoveredEmail | null {
  if (enabledLateralKeywords(options.keywords).length === 0) {
    return null;
  }

  const fileTypes =
    options.fileTypes && options.fileTypes.length > 0
      ? options.fileTypes.filter((type) =>
          (LATERAL_EXCEL_EXTENSIONS as readonly string[]).includes(type)
        )
      : [...DEFAULT_FILE_TYPES];

  const matches = extractExcelAttachmentsFromMessage(message, {
    datasetName: "Lateral",
    keywords: options.keywords,
    fileTypes: fileTypes.length > 0 ? fileTypes : [...DEFAULT_FILE_TYPES],
  });

  if (matches.length === 0) return null;

  const selection = selectLateralExcelAttachment(matches);
  const selected = selection.selected;

  return {
    messageId: selected.messageId,
    threadId: selected.threadId,
    subject: selected.subject,
    sender: selected.sender,
    receivedAt: selected.receivedAt,
    receivedAtMs: selected.receivedAtMs,
    selection,
  };
}

/**
 * Order discovered Lateral emails chronologically (oldest first).
 * Deterministic secondary key: messageId.
 * Override only when configuration explicitly specifies another order later.
 */
export function sortLateralDiscoveriesChronologically(
  rows: LateralDiscoveredEmail[]
): LateralDiscoveredEmail[] {
  return [...rows].sort((a, b) => {
    if (a.receivedAtMs !== b.receivedAtMs) return a.receivedAtMs - b.receivedAtMs;
    return a.messageId.localeCompare(b.messageId);
  });
}
