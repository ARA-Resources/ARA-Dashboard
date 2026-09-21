/**
 * Verify Lateral Excel discovery selection + filename preservation (no network).
 */
import {
  buildLateralExcelDiscoveryQuery,
  buildLateralKeywordSearchClause,
  preserveOriginalExcelFilename,
  selectLateralExcelAttachment,
  sortLateralDiscoveriesChronologically,
  sortLateralDiscoveriesForProcessing,
  type LateralDiscoveredEmail,
} from "../src/services/lateral-processing/lateral-excel-discovery";
import {
  isAfterLateralGmailCheckpoint,
  isKnownProcessedLateralFingerprint,
} from "../src/services/lateral-processing/lateral-gmail-checkpoint-store";
import { appendRecentFingerprint, attachmentFingerprint, type RawGmailAttachment } from "../src/services/gmail/attachments";
import type { DatasetKeywordConfig } from "../src/types/dataset-setup";
import type { LateralGmailCheckpoint } from "../src/types/lateral-gmail-checkpoint";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

function mockAttachment(
  partial: Partial<RawGmailAttachment> & {
    attachmentName: string;
    attachmentId: string;
  }
): RawGmailAttachment {
  return {
    datasetName: "Lateral",
    messageId: partial.messageId ?? "msg-1",
    threadId: "thread-1",
    subject: partial.subject ?? "Weekly update",
    sender: partial.sender ?? "anyone@example.com",
    receivedAtMs: partial.receivedAtMs ?? 1_000,
    receivedAt: partial.receivedAt ?? "2026-08-12T10:00:00.000Z",
    attachmentId: partial.attachmentId,
    attachmentName: partial.attachmentName,
    mimeType: "application/vnd.ms-excel.sheet.macroEnabled.12",
    size: partial.size ?? 100,
    matchedKeyword: partial.matchedKeyword ?? {
      keyword: "ATCI Lateral",
      matchMode: "contains",
      matchedIn: "subject",
      priority: 1,
    },
  };
}

// --- Original filename preserved ---
assert(
  preserveOriginalExcelFilename("ATCI Lateral DS AI MasterSheet.xlsm") ===
    "ATCI Lateral DS AI MasterSheet.xlsm",
  "must keep original Excel filename"
);
assert(
  preserveOriginalExcelFilename("Copy of Report.xlsx") === "Copy of Report.xlsx",
  "must keep spaces in original name"
);
assert(
  preserveOriginalExcelFilename("folder/My Lateral.xls") === "My Lateral.xls",
  "must keep basename only"
);

let threw = false;
try {
  preserveOriginalExcelFilename("notes.pdf");
} catch {
  threw = true;
}
assert(threw, "non-Excel must be rejected");

// --- No sender in discovery query ---
const keywords: DatasetKeywordConfig[] = [
  {
    value: "ATCI Lateral",
    enabled: true,
    priority: 1,
    matchMode: "contains",
  },
  {
    value: "MasterSheet",
    enabled: true,
    priority: 2,
    matchMode: "contains",
  },
];

const query = buildLateralExcelDiscoveryQuery({
  afterMs: 1_700_000_000_000,
  keywords,
  fileTypes: ["xlsx", "xlsm", "xls"],
});

assert(!/from:/i.test(query), "must not hardcode sender (from:)");
assert(/filename:xlsx/i.test(query), "must search xlsx");
assert(/filename:xlsm/i.test(query), "must search xlsm");
assert(/filename:xls/i.test(query), "must search xls");
assert(
  query.includes("ATCI Lateral") || query.includes('"ATCI Lateral"'),
  "must include Lateral keywords in Gmail query"
);
assert(
  buildLateralKeywordSearchClause(keywords)?.includes("MasterSheet") === true,
  "keyword clause must include configured keywords"
);

// --- Multi-attachment: prefer filename keyword match (not random) ---
const multi = selectLateralExcelAttachment([
  mockAttachment({
    attachmentId: "att-body",
    attachmentName: "Other Report.xlsx",
    matchedKeyword: {
      keyword: "ATCI Lateral",
      matchMode: "contains",
      matchedIn: "body",
      priority: 1,
    },
  }),
  mockAttachment({
    attachmentId: "att-file",
    attachmentName: "ATCI Lateral MasterSheet.xlsm",
    matchedKeyword: {
      keyword: "ATCI Lateral",
      matchMode: "contains",
      matchedIn: "attachment",
      priority: 1,
    },
  }),
  mockAttachment({
    attachmentId: "att-subject",
    attachmentName: "Weekly.xlsx",
    matchedKeyword: {
      keyword: "ATCI Lateral",
      matchMode: "contains",
      matchedIn: "subject",
      priority: 1,
    },
  }),
]);

assert(
  multi.selected.attachmentId === "att-file",
  "must prefer attachment-filename keyword match"
);
assert(
  multi.rejectedAttachments.length === 2,
  "must list rejected attachments"
);
assert(
  multi.selectionReason.includes("ATCI Lateral MasterSheet.xlsm"),
  "must log selected attachment name in reason"
);

// Deterministic tie-break by filename (same match field + priority)
const tied = selectLateralExcelAttachment([
  mockAttachment({
    attachmentId: "b",
    attachmentName: "Zed Lateral.xlsx",
    matchedKeyword: {
      keyword: "Lateral",
      matchMode: "contains",
      matchedIn: "attachment",
      priority: 1,
    },
  }),
  mockAttachment({
    attachmentId: "a",
    attachmentName: "AAA Lateral.xlsx",
    matchedKeyword: {
      keyword: "Lateral",
      matchMode: "contains",
      matchedIn: "attachment",
      priority: 1,
    },
  }),
]);
assert(
  tied.selected.attachmentName === "AAA Lateral.xlsx",
  "tie-break must be alphabetical filename, not random"
);

// --- Chronological multi-email order ---
const emails: LateralDiscoveredEmail[] = [
  {
    messageId: "msg-new",
    threadId: "t",
    subject: "new",
    sender: "a@x.com",
    receivedAt: "2026-08-12T12:00:00.000Z",
    receivedAtMs: 2_000,
    selection: {
      selected: mockAttachment({
        messageId: "msg-new",
        attachmentId: "1",
        attachmentName: "new.xlsm",
        receivedAtMs: 2_000,
      }),
      selectionReason: "only",
      rejectedAttachments: [],
    },
  },
  {
    messageId: "msg-old",
    threadId: "t",
    subject: "old",
    sender: "b@x.com",
    receivedAt: "2026-08-12T10:00:00.000Z",
    receivedAtMs: 1_000,
    selection: {
      selected: mockAttachment({
        messageId: "msg-old",
        attachmentId: "2",
        attachmentName: "old.xlsm",
        receivedAtMs: 1_000,
      }),
      selectionReason: "only",
      rejectedAttachments: [],
    },
  },
];

const ordered = sortLateralDiscoveriesChronologically(emails);
assert(ordered[0].messageId === "msg-old", "must process oldest email first");
assert(ordered[1].messageId === "msg-new", "newest email second");

// --- Regression: 2026-09-18 Book2.xlsx incident ---
// Real candidates from that day's .data/logs/lateral-gmail-2026-09-18.jsonl.
// Chronological-only order tried Book2.xlsx (05:55am, decoy, body-only
// match) before the real "AdhocDS (Lateral Vendors)..." file (09:33am,
// attachment-filename match) and hard-stopped on the first failure — the
// real file was never attempted. Tier-aware order must put the real file
// first regardless of arrival time.
function realCandidate(
  messageId: string,
  attachmentName: string,
  receivedAt: string,
  matchedIn: "attachment" | "body"
): LateralDiscoveredEmail {
  const receivedAtMs = Date.parse(receivedAt);
  return {
    messageId,
    threadId: "t",
    subject:
      matchedIn === "attachment"
        ? "FW: ATCI_Adhoc DS 18th Sep 2026"
        : "FW: Ad hoc DS - AI & Data",
    sender: "<anurag.shah@araresources.com>",
    receivedAt,
    receivedAtMs,
    selection: {
      selected: mockAttachment({
        messageId,
        attachmentId: `att-${messageId}`,
        attachmentName,
        receivedAt,
        receivedAtMs,
        sender: "<anurag.shah@araresources.com>",
        matchedKeyword: {
          keyword: "AdhocDS",
          matchMode: "contains",
          matchedIn,
          priority: 1,
        },
      }),
      selectionReason: "only",
      rejectedAttachments: [],
    },
  };
}

const incidentCandidates: LateralDiscoveredEmail[] = [
  realCandidate(
    "1a0b3153fd0b6707",
    "Book2.xlsx",
    "2026-09-18T05:55:02.000Z",
    "body"
  ),
  realCandidate(
    "1a0b3154eb48ac9d",
    "Book2.xlsx",
    "2026-09-18T05:55:02.000Z",
    "body"
  ),
  realCandidate(
    "1a0b3dd462baf0ba",
    "AdhocDS (Lateral Vendors) as on 18th Sep 2026.xlsx",
    "2026-09-18T09:33:04.000Z",
    "attachment"
  ),
  realCandidate(
    "1a0b3ddba95cb3e0",
    "AdhocDS (Lateral Vendors) as on 18th Sep 2026.xlsx",
    "2026-09-18T09:33:06.000Z",
    "attachment"
  ),
];

// Old (chronological-only) order: Book2.xlsx tried first — this is the bug.
const chronological = sortLateralDiscoveriesChronologically(incidentCandidates);
assert(
  chronological[0].selection.selected.attachmentName === "Book2.xlsx",
  "sanity check: chronological-only order reproduces the incident (Book2.xlsx first)"
);

// New (tier-aware) order: the real, attachment-matched file must be tried first.
const forProcessing = sortLateralDiscoveriesForProcessing(incidentCandidates);
assert(
  forProcessing[0].selection.selected.attachmentName ===
    "AdhocDS (Lateral Vendors) as on 18th Sep 2026.xlsx",
  "tier-aware order must try the real attachment-matched file before the body-matched decoy"
);
assert(
  forProcessing[1].selection.selected.attachmentName ===
    "AdhocDS (Lateral Vendors) as on 18th Sep 2026.xlsx",
  "both real-file duplicate messages must sort before both decoy duplicates"
);
assert(
  forProcessing[0].messageId === "1a0b3dd462baf0ba",
  "within the same tier, earlier-received message must still come first (09:33:04 before 09:33:06)"
);
assert(
  forProcessing[2].selection.selected.attachmentName === "Book2.xlsx" &&
    forProcessing[3].selection.selected.attachmentName === "Book2.xlsx",
  "decoy duplicates must sort last, after both real-file candidates"
);

// --- Regression: 2026-09-21 incident — stale duplicates starving the real file ---
// Real shape from that day's .data/logs/lateral-gmail-2026-09-21.jsonl:
// checkpoint sat on the 18th-Sep file; two near-duplicate messages carrying
// the SAME 18th-Sep attachment content kept re-qualifying as "new" candidates
// (one via the exact-same-messageId/attachmentId-churn bug, one via a
// genuinely different messageId carrying identical content) and, because
// they're older, always sorted ahead of the genuinely new 21st-Sep file
// under sortLateralDiscoveriesForProcessing's oldest-first tie-break — so
// the real file was never tried. This reproduces the full discovery
// pipeline (checkpoint filter -> fingerprint filter -> tier sort) the way
// the real loop in lateral-gmail-incremental-sync.ts applies it, and
// asserts only the genuine candidate survives.
const STALE_FILENAME = "AdhocDS (Lateral Vendors) as on 18th Sep 2026.xlsx";
const STALE_SIZE = 3_205_892;
const GENUINE_FILENAME = "AdhocDS (Lateral Vendors) as on 21st Sep 2026.xlsx";
const GENUINE_SIZE = 3_312_500;

const incidentCheckpoint: LateralGmailCheckpoint = {
  version: 1,
  messageId: "1a0b3dd462baf0ba",
  attachmentId: "some-attachment-id-from-checkpoint-time",
  receivedAt: "2026-09-18T09:33:04.000Z",
  receivedAtMs: Date.parse("2026-09-18T09:33:04.000Z"),
  attachmentFilename: STALE_FILENAME,
  driveFileId: "drive-checkpointed",
  processedAt: "2026-09-18T12:02:50.945Z",
  processingResult: "SUCCESS",
  recentFingerprints: appendRecentFingerprint([], {
    fingerprint: attachmentFingerprint({
      datasetName: "Lateral",
      attachmentName: STALE_FILENAME,
      size: STALE_SIZE,
    }),
    messageId: "1a0b3dd462baf0ba",
    receivedAtMs: Date.parse("2026-09-18T09:33:04.000Z"),
    processedAt: "2026-09-18T12:02:50.945Z",
  }),
  updatedAt: "2026-09-18T12:02:50.945Z",
};

function incidentCandidate(
  messageId: string,
  attachmentName: string,
  size: number,
  receivedAt: string
): LateralDiscoveredEmail {
  const receivedAtMs = Date.parse(receivedAt);
  return {
    messageId,
    threadId: "t",
    subject: "Fwd/FW: ATCI_Adhoc DS",
    sender: "<someone@araresources.com>",
    receivedAt,
    receivedAtMs,
    selection: {
      selected: mockAttachment({
        messageId,
        attachmentId: `att-${messageId}`,
        attachmentName,
        receivedAt,
        receivedAtMs,
        sender: "<someone@araresources.com>",
        size,
        matchedKeyword: {
          keyword: "AdhocDS",
          matchMode: "contains",
          matchedIn: "attachment",
          priority: 1,
        },
      }),
      selectionReason: "only",
      rejectedAttachments: [],
    },
  };
}

const staleExactSameMessage = incidentCandidate(
  "1a0b3dd462baf0ba", // same messageId as the checkpoint itself
  STALE_FILENAME,
  STALE_SIZE,
  "2026-09-18T09:33:04.000Z"
);
const staleDifferentMessageSameContent = incidentCandidate(
  "1a0b3ddba95cb3e0", // different messageId, later receivedAtMs, identical content
  STALE_FILENAME,
  STALE_SIZE,
  "2026-09-18T09:33:06.000Z"
);
const genuineNewCandidate = incidentCandidate(
  "1a0c31f2f1fffcb1",
  GENUINE_FILENAME,
  GENUINE_SIZE,
  "2026-09-21T08:39:37.000Z"
);

// Mirrors the discovery loop's two-stage filter in
// lateral-gmail-incremental-sync.ts: isAfterLateralGmailCheckpoint first,
// then isKnownProcessedLateralFingerprint.
function discoveryFilter(
  candidates: LateralDiscoveredEmail[],
  checkpoint: LateralGmailCheckpoint
): LateralDiscoveredEmail[] {
  return candidates.filter((c) => {
    const selected = c.selection.selected;
    if (
      !isAfterLateralGmailCheckpoint(
        {
          messageId: selected.messageId,
          attachmentId: selected.attachmentId,
          receivedAtMs: selected.receivedAtMs,
        },
        checkpoint
      )
    ) {
      return false;
    }
    if (
      isKnownProcessedLateralFingerprint(
        { attachmentName: selected.attachmentName, size: selected.size },
        checkpoint
      )
    ) {
      return false;
    }
    return true;
  });
}

const filtered = discoveryFilter(
  [staleExactSameMessage, staleDifferentMessageSameContent, genuineNewCandidate],
  incidentCheckpoint
);
assert(
  filtered.length === 1 && filtered[0].messageId === "1a0c31f2f1fffcb1",
  `hardened discovery filter must leave only the genuine 21st-Sep candidate, got ${JSON.stringify(filtered.map((f) => f.messageId))}`
);

const finalQueue = sortLateralDiscoveriesForProcessing(filtered);
assert(
  finalQueue.length === 1 &&
    finalQueue[0].selection.selected.attachmentName === GENUINE_FILENAME,
  "final processing queue must contain only the genuine candidate — neither stale duplicate reaches the queue at all"
);

console.log("verify-lateral-excel-discovery: OK");
