/**
 * Executive demand-sheet Gmail discovery (Phase E2).
 *
 * Mirrors `lateral-excel-discovery.ts` structurally (same query-building /
 * selection-among-candidates pattern), with two deliberate differences:
 *
 * 1. Extension is fixed to .xlsx only — the confirmed Executive demand sheet
 *    is always `ATCI Exec DS_<date>.xlsx`, never .xlsm/.xls (Lateral has no
 *    fixed filename and must support all three).
 * 2. After the normal keyword-gated match (same `extractExcelAttachmentsFromMessage`
 *    / `setup.datasets.Executive.keywords` gate every other dataset uses), an
 *    additional AND-filter requires the attachment name to match the confirmed
 *    "ATCI Exec DS_*.xlsx" pattern (`isExecutiveDsAttachmentName`). This is the
 *    "ATCI Exec DS_*.xlsx filter" from the approved spec — a hard narrowing on
 *    top of the standard keyword gate, not a replacement for it.
 */
import type { gmail_v1 } from "googleapis";
import {
  extractExcelAttachmentsFromMessage,
  type RawGmailAttachment,
} from "@/services/gmail/attachments";
import {
  fileTypeClauseForQuery,
  toGmailEpochSeconds,
} from "@/services/gmail/query";
import { isExecutiveDsAttachmentName } from "@/services/dataset/executive-dataset-mapping";
import type {
  DatasetFileType,
  DatasetKeywordConfig,
} from "@/types/dataset-setup";

function enabledExecutiveKeywords(
  keywords: DatasetKeywordConfig[] | undefined
): DatasetKeywordConfig[] {
  return [...(keywords ?? [])]
    .filter((keyword) => keyword.enabled && keyword.value.trim())
    .sort(
      (a, b) => a.priority - b.priority || a.value.localeCompare(b.value)
    );
}

/** Executive demand sheet is confirmed .xlsx only. */
export const EXECUTIVE_EXCEL_EXTENSIONS = ["xlsx"] as const;

export interface ExecutiveAttachmentSelection {
  selected: RawGmailAttachment;
  selectionReason: string;
  rejectedAttachments: Array<{
    attachmentName: string;
    attachmentId: string;
    reason: string;
  }>;
}

export interface ExecutiveDiscoveredEmail {
  messageId: string;
  threadId: string;
  subject: string;
  sender: string;
  receivedAt: string;
  receivedAtMs: number;
  selection: ExecutiveAttachmentSelection;
}

/**
 * Exact ORIGINAL Excel basename for Google Drive (visible name).
 * No timestamps, UUIDs, random suffixes, "processed", or "copy" added.
 * Also enforces the confirmed "ATCI Exec DS_*.xlsx" naming pattern.
 */
export function originalExecutiveDsFilenameForDrive(
  originalFilename: string
): string {
  const base = (originalFilename || "").split(/[/\\]/).pop()?.trim() || "";
  if (!base) {
    throw new Error("Attachment has no original filename.");
  }
  if (!isExecutiveDsAttachmentName(base)) {
    throw new Error(
      `Attachment does not match the Executive demand-sheet naming pattern ("ATCI Exec DS_*.xlsx"): ${base}`
    );
  }
  return base;
}

/**
 * Local-disk safe form of the original Excel filename.
 * Only replaces characters illegal on Windows/macOS paths.
 * Drive uploads must use {@link originalExecutiveDsFilenameForDrive} instead.
 */
export function preserveOriginalExecutiveDsFilename(
  originalFilename: string
): string {
  const base = originalExecutiveDsFilenameForDrive(originalFilename);
  return base.replace(/[\u0000-\u001f<>:"/\\|?*]/g, "_");
}

function gmailSearchTerm(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (/[\s"()]/.test(trimmed)) {
    return `"${trimmed.replace(/"/g, "")}"`;
  }
  return trimmed;
}

/**
 * Build an OR clause from configured Executive keywords for Gmail search.
 * Same semantics as Lateral's — Gmail matches against message content,
 * subject, and attachment names. Regex keywords are excluded from the
 * server-side query (still applied client-side via keyword-match).
 */
export function buildExecutiveKeywordSearchClause(
  keywords: DatasetKeywordConfig[]
): string | null {
  const terms = enabledExecutiveKeywords(keywords)
    .filter((keyword) => keyword.matchMode !== "regex")
    .map((keyword) => gmailSearchTerm(keyword.value))
    .filter(Boolean);

  if (terms.length === 0) return null;
  return `(${terms.join(" OR ")})`;
}

/**
 * Executive Gmail discovery query:
 * - after checkpoint timestamp
 * - .xlsx only
 * - server-side filename hint on the confirmed "ATCI Exec DS_" prefix
 *   (a stable, confirmed constant — unlike Lateral, which has no fixed name)
 * - configured Executive keywords (content / subject / filename)
 * - NO hardcoded sender
 */
export function buildExecutiveExcelDiscoveryQuery(options: {
  afterMs: number;
  keywords: DatasetKeywordConfig[];
  fileTypes?: DatasetFileType[];
}): string {
  const fileTypes =
    options.fileTypes && options.fileTypes.length > 0
      ? options.fileTypes.filter((type) =>
          (EXECUTIVE_EXCEL_EXTENSIONS as readonly string[]).includes(type)
        )
      : [...EXECUTIVE_EXCEL_EXTENSIONS];

  const parts = [
    "in:inbox",
    `after:${toGmailEpochSeconds(options.afterMs)}`,
    fileTypeClauseForQuery(
      fileTypes.length > 0 ? fileTypes : [...EXECUTIVE_EXCEL_EXTENSIONS]
    ),
    `filename:"ATCI Exec DS_"`,
  ];

  const keywordClause = buildExecutiveKeywordSearchClause(options.keywords);
  if (keywordClause) {
    parts.push(keywordClause);
  }

  return parts.join(" ");
}

function fieldRank(matchedIn: string | undefined): number {
  if (matchedIn === "attachment") return 0;
  if (matchedIn === "subject") return 1;
  if (matchedIn === "body") return 2;
  return 9;
}

/**
 * Score an Executive Excel candidate. Lower score wins.
 * Deterministic: attachment match → keyword priority → filename → attachmentId.
 */
export function scoreExecutiveExcelCandidate(row: RawGmailAttachment): number {
  const where = fieldRank(row.matchedKeyword?.matchedIn);
  const priority = row.matchedKeyword?.priority ?? 999;
  return where * 1_000_000 + priority * 1_000;
}

function compareExecutiveCandidates(
  a: RawGmailAttachment,
  b: RawGmailAttachment
): number {
  const scoreDiff =
    scoreExecutiveExcelCandidate(a) - scoreExecutiveExcelCandidate(b);
  if (scoreDiff !== 0) return scoreDiff;
  const byName = a.attachmentName.localeCompare(b.attachmentName);
  if (byName !== 0) return byName;
  return a.attachmentId.localeCompare(b.attachmentId);
}

/**
 * When a message has multiple attachments matching the Executive demand-sheet
 * pattern, pick the one that best matches configured Executive criteria.
 * Never picks randomly.
 */
export function selectExecutiveExcelAttachment(
  candidates: RawGmailAttachment[]
): ExecutiveAttachmentSelection {
  const dsOnly = candidates.filter((row) =>
    isExecutiveDsAttachmentName(row.attachmentName)
  );

  if (dsOnly.length === 0) {
    throw new Error(
      'No attachments matched the Executive demand-sheet pattern ("ATCI Exec DS_*.xlsx").'
    );
  }

  if (dsOnly.length === 1) {
    const selected = dsOnly[0];
    return {
      selected,
      selectionReason: `Only matching Executive demand-sheet attachment: "${selected.attachmentName}" (keyword "${selected.matchedKeyword?.keyword}" in ${selected.matchedKeyword?.matchedIn}).`,
      rejectedAttachments: [],
    };
  }

  const ranked = [...dsOnly].sort(compareExecutiveCandidates);
  const selected = ranked[0];
  const rejectedAttachments = ranked.slice(1).map((row) => ({
    attachmentName: row.attachmentName,
    attachmentId: row.attachmentId,
    reason: `Not selected — ranked below "${selected.attachmentName}" (keyword "${row.matchedKeyword?.keyword}" in ${row.matchedKeyword?.matchedIn}, priority ${row.matchedKeyword?.priority ?? "n/a"}).`,
  }));

  return {
    selected,
    selectionReason: `Selected "${selected.attachmentName}" among ${dsOnly.length} Executive demand-sheet attachments: prefer attachment-filename keyword match, then keyword priority, then filename order. Matched keyword "${selected.matchedKeyword?.keyword}" in ${selected.matchedKeyword?.matchedIn}.`,
    rejectedAttachments,
  };
}

/**
 * Discover the Executive demand sheet on one Gmail message.
 * - Uses configured Executive keywords (same gate every dataset uses)
 * - Matches subject, body, and attachment filename
 * - Then requires the attachment name to match "ATCI Exec DS_*.xlsx"
 */
export function discoverExecutiveExcelInMessage(
  message: gmail_v1.Schema$Message,
  options: {
    keywords: DatasetKeywordConfig[];
    fileTypes?: DatasetFileType[];
  }
): ExecutiveDiscoveredEmail | null {
  if (enabledExecutiveKeywords(options.keywords).length === 0) {
    return null;
  }

  const fileTypes =
    options.fileTypes && options.fileTypes.length > 0
      ? options.fileTypes.filter((type) =>
          (EXECUTIVE_EXCEL_EXTENSIONS as readonly string[]).includes(type)
        )
      : [...EXECUTIVE_EXCEL_EXTENSIONS];

  const matches = extractExcelAttachmentsFromMessage(message, {
    datasetName: "Executive",
    keywords: options.keywords,
    fileTypes: fileTypes.length > 0 ? fileTypes : [...EXECUTIVE_EXCEL_EXTENSIONS],
  }).filter((row) => isExecutiveDsAttachmentName(row.attachmentName));

  if (matches.length === 0) return null;

  const selection = selectExecutiveExcelAttachment(matches);
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
 * Order discovered Executive emails chronologically (oldest first).
 * Deterministic secondary key: messageId.
 */
export function sortExecutiveDiscoveriesChronologically(
  rows: ExecutiveDiscoveredEmail[]
): ExecutiveDiscoveredEmail[] {
  return [...rows].sort((a, b) => {
    if (a.receivedAtMs !== b.receivedAtMs) return a.receivedAtMs - b.receivedAtMs;
    return a.messageId.localeCompare(b.messageId);
  });
}
