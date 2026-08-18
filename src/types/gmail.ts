/**
 * Gmail integration contracts — OAuth tokens never include passwords.
 */

import type { DatasetSyncName } from "@/types/dataset-sync";

export type GmailAttachmentStatus =
  | "Newest"
  | "Selected"
  | "Matched"
  | "Superseded"
  | "Duplicate email"
  | "Duplicate attachment";

export interface GmailOAuthTokens {
  access_token?: string | null;
  refresh_token?: string | null;
  scope?: string | null;
  token_type?: string | null;
  expiry_date?: number | null;
  id_token?: string | null;
}

export interface StoredGmailAuth {
  /** Authenticated mailbox email (from OAuth profile / token info) */
  email: string;
  /** Expected mailbox from Dataset setup (login_hint) */
  expectedEmail: string;
  tokens: GmailOAuthTokens;
  connectedAt: string;
  updatedAt: string;
}

export interface GmailExcelAttachmentRow {
  id: string;
  datasetName: DatasetSyncName;
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
  status: GmailAttachmentStatus;
  /** Highest-priority keyword that matched attachment, subject, or body */
  matchedKeyword: string | null;
  matchedIn: "subject" | "body" | "attachment" | null;
  matchMode: string | null;
  /** True when this row is the automatic or manually chosen file for the dataset */
  selected?: boolean;
}

export interface GmailDatasetQuery {
  datasetName: DatasetSyncName;
  query: string;
}

export interface GmailScanResult {
  connected: boolean;
  connectedEmail: string | null;
  /** Inbox Excel query used for this scan */
  query: string;
  /** Same shared query listed per enabled dataset */
  queries: GmailDatasetQuery[];
  /** incremental = after last successful sync; date = single calendar day */
  scanMode: "incremental" | "date";
  /** Calendar day label (browse mode) or today (incremental) */
  scanDate: string;
  /** Exclusive lower bound used for incremental scans */
  afterMs: number | null;
  /** Watermark at scan time */
  lastSuccessfulSyncAt: string | null;
  scannedAt: string;
  messageCount: number;
  rows: GmailExcelAttachmentRow[];
  warnings: string[];
}

export interface GmailDedupeState {
  /** Keys are `${datasetName}:${messageId}` so datasets never block each other */
  seenMessageIds: string[];
  /** attachment fingerprint → newest receivedAtMs */
  attachmentFingerprints: Record<string, number>;
  updatedAt: string;
}
