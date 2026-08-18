/**
 * Verify Lateral Excel discovery selection + filename preservation (no network).
 */
import {
  buildLateralExcelDiscoveryQuery,
  buildLateralKeywordSearchClause,
  preserveOriginalExcelFilename,
  selectLateralExcelAttachment,
  sortLateralDiscoveriesChronologically,
  type LateralDiscoveredEmail,
} from "../src/services/lateral-processing/lateral-excel-discovery";
import type { RawGmailAttachment } from "../src/services/gmail/attachments";
import type { DatasetKeywordConfig } from "../src/types/dataset-setup";

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
    size: 100,
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

console.log("verify-lateral-excel-discovery: OK");
