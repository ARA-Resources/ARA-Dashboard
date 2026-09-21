/**
 * Persistent cursor for Lateral Gmail incremental scanning.
 *
 * Advanced ONLY after the entire Lateral pipeline succeeds (Gmail → Drive source
 * → ATCI DS → Master → New Sheet → JR reconcile → Column K → final XLSM save).
 * processingResult is always "SUCCESS" when advanced; never advance on failure.
 */
export type LateralCheckpointProcessingResult = "SUCCESS";

/** One entry in the bounded recently-processed-fingerprint history. */
export interface LateralGmailRecentFingerprint {
  /** `attachmentFingerprint()` value: dataset::filename::size */
  fingerprint: string;
  messageId: string;
  receivedAtMs: number;
  processedAt: string;
}

export interface LateralGmailCheckpoint {
  version: 1;
  /** Gmail message ID of the last successfully processed matching email */
  messageId: string | null;
  /** Gmail attachment ID that was processed */
  attachmentId: string | null;
  /** Email received timestamp (ISO) */
  receivedAt: string | null;
  /** Email received timestamp (epoch ms) — primary ordering key with messageId */
  receivedAtMs: number | null;
  /** Original attachment filename */
  attachmentFilename: string | null;
  /** Google Drive file ID of the uploaded source Excel */
  driveFileId: string | null;
  /** When full pipeline processing completed successfully */
  processedAt: string | null;
  /**
   * Processing result — only "SUCCESS" is stored when the checkpoint advances.
   * null means empty / not yet successfully completed.
   */
  processingResult: LateralCheckpointProcessingResult | null;
  /**
   * Bounded history of recently-processed content fingerprints (filename+size),
   * newest last. Catches a same-content duplicate arriving under a DIFFERENT
   * Gmail messageId (e.g. a forwarded copy) that the single (receivedAtMs,
   * messageId) cursor above cannot recognize as already-processed on its own.
   * Optional: this type is reused as-is by Executive's checkpoint (see
   * executive-gmail-checkpoint-store.ts), which does not populate this field
   * yet — always present and populated for Lateral.
   */
  recentFingerprints?: LateralGmailRecentFingerprint[];
  updatedAt: string;
}

export interface LateralGmailCheckpointCursor {
  messageId: string;
  attachmentId: string;
  receivedAtMs: number;
}
