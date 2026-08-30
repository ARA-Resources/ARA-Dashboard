import "server-only";

import type { gmail_v1 } from "googleapis";
import { getAuthorizedGmailClient } from "@/services/gmail/oauth";
import {
  extractMessageBodyText,
  resolveKeywordMatchForConfig,
} from "@/services/gmail/keyword-match";
import { isExcelFilename, matchesFileType } from "@/services/gmail/query";
import { fileTypeClauseForQuery } from "@/services/gmail/query";
import { readExecutiveIngestionEnv } from "@/services/dataset/executive-ingestion-config";
import { matchesExecutiveAttachmentPattern } from "@/services/dataset/executive-workbook-validate";
import type { DatasetKeywordConfig } from "@/types/dataset-setup";

export interface ExecutiveGmailCandidate {
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
 * Build Executive Gmail search from configured env only.
 * Throws if no search criteria are configured (never invents defaults).
 */
export function buildExecutiveGmailSearchQuery(): string {
  const env = readExecutiveIngestionEnv();
  const parts: string[] = ["in:inbox", fileTypeClauseForQuery(["xlsm"])];

  if (env.from) {
    parts.push(`from:${gmailSearchTerm(env.from)}`);
  }
  if (env.subject) {
    parts.push(`subject:${gmailSearchTerm(env.subject)}`);
  }
  if (env.keywords.length > 0) {
    const clause = env.keywords
      .map((keyword) => gmailSearchTerm(keyword))
      .filter(Boolean)
      .join(" OR ");
    if (clause) parts.push(`(${clause})`);
  }

  if (!env.from && !env.subject && env.keywords.length === 0) {
    throw new Error(
      "Executive Gmail search is not configured. Set ARA_EXECUTIVE_GMAIL_FROM, ARA_EXECUTIVE_GMAIL_SUBJECT, and/or ARA_EXECUTIVE_GMAIL_KEYWORDS."
    );
  }

  return parts.join(" ");
}

function toKeywords(envKeywords: string[]): DatasetKeywordConfig[] {
  return envKeywords.map((value, index) => ({
    value,
    enabled: true,
    priority: index + 1,
    matchMode: "contains" as const,
  }));
}

/**
 * Discover Executive XLSM candidates. Newest first.
 * Does not download attachment bytes. Does not modify Gmail messages.
 */
export async function discoverExecutiveGmailCandidates(options?: {
  maxMessages?: number;
}): Promise<{
  candidates: ExecutiveGmailCandidate[];
}> {
  const env = readExecutiveIngestionEnv();
  const query = buildExecutiveGmailSearchQuery();
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

  const keywords = toKeywords(env.keywords);
  const candidates: ExecutiveGmailCandidate[] = [];

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
    const body = extractMessageBodyText(message.payload);
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
        !matchesFileType(part.filename, ["xlsm"])
      ) {
        continue;
      }
      if (
        !matchesExecutiveAttachmentPattern(
          part.filename,
          env.attachmentPattern
        )
      ) {
        continue;
      }

      if (keywords.length > 0) {
        const resolved = resolveKeywordMatchForConfig(
          { keywords },
          {
            subject,
            body,
            attachmentName: part.filename,
          }
        );
        if (!resolved.ok) continue;
      }

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

export async function downloadExecutiveGmailAttachment(options: {
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
