import "server-only";

import type { gmail_v1 } from "googleapis";
import { getAuthorizedGmailClient } from "@/services/gmail/oauth";
import { fileTypeClauseForQuery } from "@/services/gmail/query";
import { isExcelFilename, matchesFileType } from "@/services/gmail/query";
import { readExecutiveIngestionEnv } from "@/services/dataset/executive-ingestion-config";
import {
  EXECUTIVE_DS_ATTACHMENT_PREFIX,
  isExecutiveDsAttachmentName,
} from "@/services/dataset/executive-dataset-mapping";

export interface ExecutiveDsGmailCandidate {
  messageId: string;
  threadId: string;
  subject: string;
  sender: string;
  receivedAt: string;
  receivedAtMs: number;
  attachmentId: string;
  attachmentName: string;
  mimeType: string;
  size: number;
}

function gmailSearchTerm(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (/[\s"()]/.test(trimmed)) {
    return `"${trimmed.replace(/"/g, "")}"`;
  }
  return trimmed;
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

/**
 * Gmail query for Executive DS XLSX.
 * Confirmed attachment naming: ATCI Exec DS_<date>.xlsx
 * Optional from/subject/keywords from Phase 4A env still apply when set.
 */
export function buildExecutiveDsGmailSearchQuery(): string {
  const env = readExecutiveIngestionEnv();
  const parts: string[] = [
    "in:inbox",
    fileTypeClauseForQuery(["xlsx"]),
    `filename:${gmailSearchTerm(EXECUTIVE_DS_ATTACHMENT_PREFIX)}`,
  ];

  if (env.from) parts.push(`from:${gmailSearchTerm(env.from)}`);
  if (env.subject) parts.push(`subject:${gmailSearchTerm(env.subject)}`);
  if (env.keywords.length > 0) {
    const clause = env.keywords
      .map((keyword) => gmailSearchTerm(keyword))
      .filter(Boolean)
      .join(" OR ");
    if (clause) parts.push(`(${clause})`);
  }

  return parts.join(" ");
}

export async function discoverExecutiveDsGmailCandidates(options?: {
  maxMessages?: number;
}): Promise<{ candidates: ExecutiveDsGmailCandidate[] }> {
  const query = buildExecutiveDsGmailSearchQuery();
  const { gmail } = await getAuthorizedGmailClient();
  const maxMessages = Math.min(Math.max(options?.maxMessages ?? 25, 1), 50);

  const listed = await gmail.users.messages.list({
    userId: "me",
    q: query,
    maxResults: maxMessages,
  });

  const ids = (listed.data.messages ?? [])
    .map((item) => item.id)
    .filter((id): id is string => Boolean(id));

  const candidates: ExecutiveDsGmailCandidate[] = [];

  for (const messageId of ids) {
    const full = await gmail.users.messages.get({
      userId: "me",
      id: messageId,
      format: "full",
    });
    const message = full.data;
    const internalDate = Number(message.internalDate ?? 0);
    const headers = message.payload?.headers;
    const subject = headerValue(headers, "Subject") || "(no subject)";
    const sender = headerValue(headers, "From") || "Unknown sender";
    const receivedAt = new Date(internalDate || Date.now()).toISOString();

    const parts: Array<{
      filename: string;
      mimeType: string;
      attachmentId: string;
      size: number;
    }> = [];
    walkParts(message.payload, parts);

    for (const part of parts) {
      if (
        !isExcelFilename(part.filename) ||
        !matchesFileType(part.filename, ["xlsx"])
      ) {
        continue;
      }
      if (!isExecutiveDsAttachmentName(part.filename)) continue;

      candidates.push({
        messageId,
        threadId: message.threadId ?? "",
        subject,
        sender,
        receivedAt,
        receivedAtMs: internalDate,
        attachmentId: part.attachmentId,
        attachmentName: part.filename,
        mimeType: part.mimeType,
        size: part.size,
      });
    }
  }

  candidates.sort((a, b) => b.receivedAtMs - a.receivedAtMs);
  return { candidates };
}

export async function downloadExecutiveDsAttachment(options: {
  messageId: string;
  attachmentId: string;
}): Promise<Buffer> {
  const { gmail } = await getAuthorizedGmailClient();
  const response = await gmail.users.messages.attachments.get({
    userId: "me",
    messageId: options.messageId,
    id: options.attachmentId,
  });
  const data = response.data.data;
  if (!data) {
    throw new Error("Gmail attachment payload was empty.");
  }
  return Buffer.from(data, "base64url");
}
