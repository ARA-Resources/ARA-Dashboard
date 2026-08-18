import type { gmail_v1 } from "googleapis";
import {
  extractMessageBodyText,
  resolveKeywordMatchForConfig,
  type KeywordMatchResult,
} from "@/services/gmail/keyword-match";
import {
  isExcelFilename,
  matchesFileType,
  normalizeAttachmentKey,
} from "@/services/gmail/query";
import type {
  DatasetFileType,
  DatasetKeywordConfig,
} from "@/types/dataset-setup";
import type { DatasetSyncName } from "@/types/dataset-sync";

export interface RawGmailAttachment {
  datasetName: DatasetSyncName;
  messageId: string;
  threadId: string;
  subject: string;
  sender: string;
  receivedAtMs: number;
  receivedAt: string;
  attachmentId: string;
  attachmentName: string;
  mimeType: string;
  size: number;
  matchedKeyword: KeywordMatchResult | null;
}

function headerValue(
  headers: gmail_v1.Schema$MessagePartHeader[] | undefined,
  name: string
): string {
  const hit = headers?.find(
    (header) => header.name?.toLowerCase() === name.toLowerCase()
  );
  return hit?.value?.trim() ?? "";
}

function walkParts(
  part: gmail_v1.Schema$MessagePart | undefined,
  acc: Array<{
    filename: string;
    mimeType: string;
    attachmentId: string;
    size: number;
  }>
) {
  if (!part) return;
  const filename = part.filename?.trim() ?? "";
  const attachmentId = part.body?.attachmentId ?? "";
  if (filename && attachmentId) {
    acc.push({
      filename,
      mimeType: part.mimeType ?? "application/octet-stream",
      attachmentId,
      size: part.body?.size ?? 0,
    });
  }
  for (const child of part.parts ?? []) {
    walkParts(child, acc);
  }
}

export function extractExcelAttachmentsFromMessage(
  message: gmail_v1.Schema$Message,
  options: {
    datasetName: DatasetSyncName;
    keywords: DatasetKeywordConfig[];
    fileTypes: DatasetFileType[];
  }
): RawGmailAttachment[] {
  const messageId = message.id ?? "";
  const threadId = message.threadId ?? "";
  if (!messageId) return [];

  const headers = message.payload?.headers;
  const subject = headerValue(headers, "Subject") || "(no subject)";
  const sender = headerValue(headers, "From") || "Unknown sender";
  const body = extractMessageBodyText(message.payload);
  const receivedAtMs = Number(message.internalDate ?? 0);
  const receivedAt = receivedAtMs
    ? new Date(receivedAtMs).toISOString()
    : new Date().toISOString();

  const parts: Array<{
    filename: string;
    mimeType: string;
    attachmentId: string;
    size: number;
  }> = [];
  walkParts(message.payload, parts);

  const results: RawGmailAttachment[] = [];

  for (const part of parts) {
    if (
      !isExcelFilename(part.filename) ||
      !matchesFileType(part.filename, options.fileTypes)
    ) {
      continue;
    }

    const resolved = resolveKeywordMatchForConfig(
      { keywords: options.keywords },
      {
        subject,
        body,
        attachmentName: part.filename,
      }
    );
    if (!resolved.ok) continue;

    results.push({
      datasetName: options.datasetName,
      messageId,
      threadId,
      subject,
      sender,
      receivedAtMs,
      receivedAt,
      attachmentId: part.attachmentId,
      attachmentName: part.filename,
      mimeType: part.mimeType,
      size: part.size,
      matchedKeyword: resolved.match,
    });
  }

  return results;
}

export function attachmentFingerprint(row: {
  datasetName?: string;
  attachmentName: string;
  size: number;
}): string {
  const dataset = row.datasetName ?? "_";
  return `${dataset}::${normalizeAttachmentKey(row.attachmentName)}::${row.size}`;
}

export function versionGroupKey(
  datasetName: string,
  attachmentName: string
): string {
  return `${datasetName}::${normalizeAttachmentKey(attachmentName).replace(
    /\.(xlsx|xlsm|xls)$/i,
    ""
  )}`;
}
