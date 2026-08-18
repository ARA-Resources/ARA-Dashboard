/**
 * Persistent cursor for Lateral Gmail incremental scanning.
 *
 * Advanced ONLY after the entire Lateral pipeline succeeds (Gmail → Drive source
 * → ATCI DS → Master → New Sheet → JR reconcile → Column K → final XLSM save).
 * processingResult is always "SUCCESS" when advanced; never advance on failure.
 */
export type LateralCheckpointProcessingResult = "SUCCESS";

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
  updatedAt: string;
}

export interface LateralGmailCheckpointCursor {
  messageId: string;
  attachmentId: string;
  receivedAtMs: number;
}
