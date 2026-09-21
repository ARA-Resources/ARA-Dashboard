/**
 * Verify Lateral Gmail checkpoint cursor ordering (no network).
 */
import {
  compareLateralGmailCursor,
  isAfterLateralGmailCheckpoint,
  isKnownProcessedLateralFingerprint,
} from "../src/services/lateral-processing/lateral-gmail-checkpoint-store";
import { appendRecentFingerprint, attachmentFingerprint } from "../src/services/gmail/attachments";
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
  recentFingerprints: [],
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

// --- Regression: 2026-09-21 incident — same message, unstable attachmentId ---
// Root bug: a fresh Gmail messages.get() fetch of the literal SAME,
// already-checkpointed message returned a DIFFERENT-looking attachmentId
// than what was stored at checkpoint time, and the old comparator fell
// through to compare attachmentId lexicographically — spuriously
// readmitting an already-processed message as "new". The hardened
// comparator must ignore attachmentId entirely once (receivedAtMs,
// messageId) already match the checkpoint exactly.
assert(
  !isAfterLateralGmailCheckpoint(
    { messageId: "msg-100", attachmentId: "totally-different-attachment-id", receivedAtMs: 1_000 },
    checkpoint
  ),
  "same (receivedAtMs, messageId) as checkpoint must NOT be after it, regardless of attachmentId"
);
assert(
  !isAfterLateralGmailCheckpoint(
    { messageId: "msg-100", attachmentId: "", receivedAtMs: 1_000 },
    checkpoint
  ),
  "same (receivedAtMs, messageId) with an even lexicographically-earlier attachmentId must still not be after checkpoint"
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
  recentFingerprints: [],
  updatedAt: new Date().toISOString(),
};

assert(
  isAfterLateralGmailCheckpoint(
    { messageId: "any", attachmentId: "a", receivedAtMs: 1 },
    empty
  ),
  "empty checkpoint accepts any mail"
);

// --- Regression: 2026-09-21 incident — cross-message content duplicate ---
// A DIFFERENT messageId (e.g. a forwarded copy) can carry the exact same
// already-processed attachment content. The single (receivedAtMs, messageId)
// cursor legitimately can't see this — isKnownProcessedLateralFingerprint
// closes that gap via a bounded recent-fingerprint history.
const checkpointWithHistory: LateralGmailCheckpoint = {
  ...checkpoint,
  recentFingerprints: appendRecentFingerprint([], {
    fingerprint: attachmentFingerprint({
      datasetName: "Lateral",
      attachmentName: "AdhocDS (Lateral Vendors) as on 18th Sep 2026.xlsx",
      size: 3_205_892,
    }),
    messageId: "msg-100",
    receivedAtMs: 1_000,
    processedAt: "2026-08-12T10:05:00.000Z",
  }),
};

assert(
  isKnownProcessedLateralFingerprint(
    {
      attachmentName: "AdhocDS (Lateral Vendors) as on 18th Sep 2026.xlsx",
      size: 3_205_892,
    },
    checkpointWithHistory
  ),
  "a different messageId carrying the exact same filename+size as a recently-processed entry must be recognized as a known duplicate"
);
assert(
  !isKnownProcessedLateralFingerprint(
    {
      attachmentName: "AdhocDS (Lateral Vendors) as on 21st Sep 2026.xlsx",
      size: 3_205_892,
    },
    checkpointWithHistory
  ),
  "a genuinely different filename must NOT be flagged as a known duplicate (miss case)"
);
assert(
  !isKnownProcessedLateralFingerprint(
    {
      attachmentName: "AdhocDS (Lateral Vendors) as on 18th Sep 2026.xlsx",
      size: 999,
    },
    checkpointWithHistory
  ),
  "same filename but different size must NOT be flagged as a known duplicate"
);

console.log("PASS Lateral Gmail checkpoint cursor rules");
