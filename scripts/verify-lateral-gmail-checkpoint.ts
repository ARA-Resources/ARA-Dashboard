/**
 * Verify Lateral Gmail checkpoint cursor ordering (no network).
 */
import {
  compareLateralGmailCursor,
  isAfterLateralGmailCheckpoint,
} from "../src/services/lateral-processing/lateral-gmail-checkpoint-store";
import type { LateralGmailCheckpoint } from "../src/types/lateral-gmail-checkpoint";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

const checkpoint: LateralGmailCheckpoint = {
  version: 1,
  messageId: "msg-100",
  attachmentId: "att-1",
  receivedAt: "2026-08-12T10:00:00.000Z",
  receivedAtMs: 1_000,
  attachmentFilename: "Lateral.xlsx",
  driveFileId: "drive-1",
  processedAt: "2026-08-12T10:05:00.000Z",
  processingResult: "SUCCESS",
  updatedAt: "2026-08-12T10:05:00.000Z",
};

assert(
  !isAfterLateralGmailCheckpoint(
    { messageId: "msg-100", attachmentId: "att-1", receivedAtMs: 1_000 },
    checkpoint
  ),
  "same message must not be after checkpoint"
);

assert(
  !isAfterLateralGmailCheckpoint(
    { messageId: "msg-050", attachmentId: "att-9", receivedAtMs: 900 },
    checkpoint
  ),
  "older email must not be after checkpoint"
);

assert(
  isAfterLateralGmailCheckpoint(
    { messageId: "msg-200", attachmentId: "att-2", receivedAtMs: 1_500 },
    checkpoint
  ),
  "newer email must be after checkpoint"
);

assert(
  isAfterLateralGmailCheckpoint(
    { messageId: "msg-150", attachmentId: "att-3", receivedAtMs: 1_000 },
    checkpoint
  ),
  "same ms with later messageId must be after checkpoint"
);

assert(
  !isAfterLateralGmailCheckpoint(
    { messageId: "msg-050", attachmentId: "att-3", receivedAtMs: 1_000 },
    checkpoint
  ),
  "same ms with earlier messageId must not be after checkpoint"
);

assert(
  compareLateralGmailCursor(
    { messageId: "b", attachmentId: "1", receivedAtMs: 2 },
    { messageId: "a", attachmentId: "1", receivedAtMs: 1 }
  ) > 0,
  "ordering by time then messageId"
);

const empty: LateralGmailCheckpoint = {
  version: 1,
  messageId: null,
  attachmentId: null,
  receivedAt: null,
  receivedAtMs: null,
  attachmentFilename: null,
  driveFileId: null,
  processedAt: null,
  processingResult: null,
  updatedAt: new Date().toISOString(),
};

assert(
  isAfterLateralGmailCheckpoint(
    { messageId: "any", attachmentId: "a", receivedAtMs: 1 },
    empty
  ),
  "empty checkpoint accepts any mail"
);

console.log("PASS Lateral Gmail checkpoint cursor rules");
