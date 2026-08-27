/**
 * Executive Gmail → Drive ingestion configuration (Phase 4A).
 *
 * Exact Gmail sender/subject/filename criteria are NOT hard-coded.
 * Operators must supply them via environment variables.
 */

import {
  peekExecutiveAttachmentPattern,
  peekExecutiveDriveFolderId,
  peekExecutiveGmailFrom,
  peekExecutiveGmailKeywords,
  peekExecutiveGmailSubject,
  peekExecutiveMasterDriveFileId,
} from "@/lib/config/runtime";

export const EXECUTIVE_DATASET_NAME = "Executive" as const;

export const EXECUTIVE_REQUIRED_SHEETS = [
  "Master Sheet",
  "P - Dashboard",
  "New Sheet",
  "Posted Sheet",
] as const;

export interface ExecutiveIngestionConfigStatus {
  gmailFromConfigured: boolean;
  gmailSubjectConfigured: boolean;
  gmailKeywordsConfigured: boolean;
  attachmentPatternConfigured: boolean;
  driveFolderConfigured: boolean;
  masterDriveFileConfigured: boolean;
  /** At least one Gmail search criterion is set. */
  gmailSearchConfigured: boolean;
  /** Drive destination for source upload is set. */
  driveUploadConfigured: boolean;
  /** Ready to attempt a live fetch (search + upload destination). */
  fetchReady: boolean;
  missing: string[];
  notes: string[];
}

export function getExecutiveIngestionConfigStatus(): ExecutiveIngestionConfigStatus {
  const from = peekExecutiveGmailFrom();
  const subject = peekExecutiveGmailSubject();
  const keywords = peekExecutiveGmailKeywords();
  const attachmentPattern = peekExecutiveAttachmentPattern();
  const driveFolder = peekExecutiveDriveFolderId();
  const masterDrive = peekExecutiveMasterDriveFileId();

  const gmailSearchConfigured =
    Boolean(from) || Boolean(subject) || keywords.length > 0;

  const missing: string[] = [];
  if (!gmailSearchConfigured) {
    missing.push(
      "ARA_EXECUTIVE_GMAIL_FROM and/or ARA_EXECUTIVE_GMAIL_SUBJECT and/or ARA_EXECUTIVE_GMAIL_KEYWORDS"
    );
  }
  if (!driveFolder) {
    missing.push("ARA_EXECUTIVE_DRIVE_FOLDER_ID");
  }

  const notes: string[] = [
    "Repository does not define exact Executive Gmail sender/subject/filename criteria.",
    "DEFAULT_DATASET_KEYWORDS.Executive are setup-seed placeholders only — not used as live search defaults.",
    "Phase 4A does not overwrite ARA_EXECUTIVE_MASTER_DRIVE_FILE_ID (dashboard Master). Source upload uses the Drive folder.",
  ];

  if (attachmentPattern) {
    notes.push("ARA_EXECUTIVE_ATTACHMENT_PATTERN is set and will filter attachment names.");
  }

  return {
    gmailFromConfigured: Boolean(from),
    gmailSubjectConfigured: Boolean(subject),
    gmailKeywordsConfigured: keywords.length > 0,
    attachmentPatternConfigured: Boolean(attachmentPattern),
    driveFolderConfigured: Boolean(driveFolder),
    masterDriveFileConfigured: Boolean(masterDrive),
    gmailSearchConfigured,
    driveUploadConfigured: Boolean(driveFolder),
    fetchReady: gmailSearchConfigured && Boolean(driveFolder),
    missing,
    notes,
  };
}

export function readExecutiveIngestionEnv() {
  return {
    from: peekExecutiveGmailFrom(),
    subject: peekExecutiveGmailSubject(),
    keywords: peekExecutiveGmailKeywords(),
    attachmentPattern: peekExecutiveAttachmentPattern(),
    driveFolderId: peekExecutiveDriveFolderId(),
  };
}
