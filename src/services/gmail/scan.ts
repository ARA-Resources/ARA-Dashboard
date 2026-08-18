import {
  readEncryptedJson,
  writeEncryptedJson,
} from "@/services/dataset/encrypted-json-store";
import { readDatasetSetup } from "@/services/dataset/secure-store";
import {
  attachmentFingerprint,
  extractExcelAttachmentsFromMessage,
  type RawGmailAttachment,
} from "@/services/gmail/attachments";
import { getAuthorizedGmailClient } from "@/services/gmail/oauth";
import {
  buildAfterTimestampExcelQuery,
  buildDateScopedExcelQuery,
  getCalendarDateInTimezone,
  getStartOfCalendarDayMs,
  resolveScanDate,
  type GmailScanMode,
  type ScanDateMode,
} from "@/services/gmail/query";
import { readSyncWatermark } from "@/services/dataset/sync-watermark-store";
import { DEFAULT_FILE_TYPES } from "@/types/dataset-setup";
import { DATASET_SYNC_NAMES, type DatasetSyncName } from "@/types/dataset-sync";
import { isExecutableDatasetType } from "@/types/dataset-execution";
import type {
  GmailAttachmentStatus,
  GmailDedupeState,
  GmailExcelAttachmentRow,
  GmailScanResult,
} from "@/types/gmail";

const DEDUPE_FILE = "gmail-dedupe.enc.json";
const SELECTION_FILE = "gmail-selection-overrides.json";
const MAX_MESSAGES = 100;

export interface GmailSelectionOverrides {
  /** Calendar day or incremental key (`after:<ms>`) the selection applies to */
  date: string | null;
  /** datasetName → selected row id */
  selectedByDataset: Partial<Record<DatasetSyncName, string>>;
  updatedAt: string;
}

async function readDedupeState(): Promise<GmailDedupeState> {
  const stored = await readEncryptedJson<GmailDedupeState>(DEDUPE_FILE);
  return (
    stored ?? {
      seenMessageIds: [],
      attachmentFingerprints: {},
      updatedAt: new Date().toISOString(),
    }
  );
}

async function writeDedupeState(state: GmailDedupeState) {
  await writeEncryptedJson(DEDUPE_FILE, state);
}

async function readSelectionOverrides(): Promise<GmailSelectionOverrides> {
  const stored = await readEncryptedJson<GmailSelectionOverrides>(SELECTION_FILE);
  return (
    stored ?? {
      date: null,
      selectedByDataset: {},
      updatedAt: new Date().toISOString(),
    }
  );
}

async function writeSelectionOverrides(state: GmailSelectionOverrides) {
  await writeEncryptedJson(SELECTION_FILE, state);
}

/** Allow a failed download/validation to be retried on the next sync. */
export async function forgetGmailMessageIds(messageIds: string[]) {
  if (messageIds.length === 0) return;
  const prior = await readDedupeState();
  const drop = new Set(messageIds);
  await writeDedupeState({
    ...prior,
    seenMessageIds: prior.seenMessageIds.filter((id) => {
      if (drop.has(id)) return false;
      const bare = id.includes(":") ? id.slice(id.indexOf(":") + 1) : id;
      return !drop.has(bare);
    }),
    updatedAt: new Date().toISOString(),
  });
}

/** Clear message IDs and attachment fingerprints so a failed item can retry. */
export async function forgetGmailAttachments(
  items: Array<{
    messageId: string;
    attachmentName: string;
    size: number;
    datasetName?: string;
  }>
) {
  if (items.length === 0) return;
  const prior = await readDedupeState();
  const dropMessages = new Set(items.map((item) => item.messageId));
  const dropFingerprints = new Set(
    items.map((item) =>
      attachmentFingerprint({
        datasetName: item.datasetName,
        attachmentName: item.attachmentName,
        size: item.size,
      })
    )
  );
  const nextFingerprints = { ...prior.attachmentFingerprints };
  for (const key of dropFingerprints) {
    delete nextFingerprints[key];
  }
  await writeDedupeState({
    ...prior,
    seenMessageIds: prior.seenMessageIds.filter((id) => {
      if (dropMessages.has(id)) return false;
      const bare = id.includes(":") ? id.slice(id.indexOf(":") + 1) : id;
      return !dropMessages.has(bare);
    }),
    attachmentFingerprints: nextFingerprints,
    updatedAt: new Date().toISOString(),
  });
}

export async function getGmailDedupeSummary() {
  const state = await readDedupeState();
  return {
    seenMessageCount: state.seenMessageIds.length,
    fingerprintCount: Object.keys(state.attachmentFingerprints).length,
    updatedAt: state.updatedAt,
  };
}

/**
 * Manually select which matched file is Newest for a dataset on a scan date.
 */
export async function setManualDatasetSelection(options: {
  datasetName: DatasetSyncName;
  rowId: string;
  date: string;
}) {
  const prior = await readSelectionOverrides();
  const next: GmailSelectionOverrides = {
    date: options.date,
    selectedByDataset: {
      ...(prior.date === options.date ? prior.selectedByDataset : {}),
      [options.datasetName]: options.rowId,
    },
    updatedAt: new Date().toISOString(),
  };
  await writeSelectionOverrides(next);
  return next;
}

export async function clearManualDatasetSelection(
  datasetName?: DatasetSyncName
) {
  const prior = await readSelectionOverrides();
  if (!datasetName) {
    const empty: GmailSelectionOverrides = {
      date: null,
      selectedByDataset: {},
      updatedAt: new Date().toISOString(),
    };
    await writeSelectionOverrides(empty);
    return empty;
  }
  const nextSelected = { ...prior.selectedByDataset };
  delete nextSelected[datasetName];
  const next: GmailSelectionOverrides = {
    ...prior,
    selectedByDataset: nextSelected,
    updatedAt: new Date().toISOString(),
  };
  await writeSelectionOverrides(next);
  return next;
}

/**
 * Newest = latest received per dataset (or manual override).
 * All other matches stay visible as Matched / Superseded.
 */
function applyNewestPerDataset(
  raw: RawGmailAttachment[],
  overrides: GmailSelectionOverrides,
  scanDate: string
): GmailExcelAttachmentRow[] {
  const sorted = [...raw].sort((a, b) => b.receivedAtMs - a.receivedAtMs);
  const selectedIds =
    overrides.date === scanDate ? overrides.selectedByDataset : {};

  const autoNewestByDataset = new Map<DatasetSyncName, string>();
  for (const item of sorted) {
    if (!autoNewestByDataset.has(item.datasetName)) {
      autoNewestByDataset.set(
        item.datasetName,
        `${item.datasetName}:${item.messageId}:${item.attachmentId}`
      );
    }
  }

  const seenFingerprints = new Set<string>();
  const annotated: GmailExcelAttachmentRow[] = [];

  for (const item of sorted) {
    const id = `${item.datasetName}:${item.messageId}:${item.attachmentId}`;
    const fingerprint = attachmentFingerprint(item);
    const manualId = selectedIds[item.datasetName];
    const autoId = autoNewestByDataset.get(item.datasetName);
    const chosenId = manualId && sorted.some(
      (candidate) =>
        `${candidate.datasetName}:${candidate.messageId}:${candidate.attachmentId}` ===
        manualId
    )
      ? manualId
      : autoId;

    let status: GmailAttachmentStatus;
    if (seenFingerprints.has(fingerprint)) {
      status = "Duplicate attachment";
    } else if (id === chosenId) {
      status = manualId === id ? "Selected" : "Newest";
      seenFingerprints.add(fingerprint);
    } else {
      status = "Matched";
      seenFingerprints.add(fingerprint);
    }

    annotated.push({
      id,
      datasetName: item.datasetName,
      messageId: item.messageId,
      threadId: item.threadId,
      subject: item.subject,
      sender: item.sender,
      receivedAt: item.receivedAt,
      receivedAtMs: item.receivedAtMs,
      attachmentId: item.attachmentId,
      attachmentName: item.attachmentName,
      mimeType: item.mimeType,
      size: item.size,
      status,
      matchedKeyword: item.matchedKeyword?.keyword ?? null,
      matchedIn: item.matchedKeyword?.matchedIn ?? null,
      matchMode: item.matchedKeyword?.matchMode ?? null,
      selected: id === chosenId,
    });
  }

  return annotated;
}

/**
 * Scan inbox Excel emails, then assign attachments to datasets via keywords.
 *
 * Default mode is **incremental**: emails received after the last successful sync.
 * Pass `date` / `dateMode` for a manual calendar-day browse.
 */
export async function scanGmailExcelAttachments(options?: {
  datasetNames?: DatasetSyncName[];
  /** Force calendar-day browse when set (or when dateMode is today/yesterday/custom). */
  date?: string;
  dateMode?: ScanDateMode | string;
  /** Default: incremental. Use "date" with date/dateMode for a single day. */
  scanMode?: GmailScanMode | string;
}): Promise<GmailScanResult> {
  const setup = await readDatasetSetup();
  if (!setup) {
    throw new Error("Complete Dataset setup before scanning Gmail.");
  }

  const watermark = await readSyncWatermark();
  const explicitDateMode =
    options?.dateMode === "today" ||
    options?.dateMode === "yesterday" ||
    options?.dateMode === "custom" ||
    Boolean(options?.date && options?.scanMode !== "incremental");

  const scanMode: GmailScanMode =
    options?.scanMode === "date" || explicitDateMode
      ? "date"
      : "incremental";

  const scanDate = resolveScanDate({
    mode: options?.dateMode,
    date: options?.date,
  });

  let afterMs =
    watermark.lastSuccessfulSyncAtMs ??
    getStartOfCalendarDayMs(getCalendarDateInTimezone());
  const warnings: string[] = [];

  if (scanMode === "incremental" && !watermark.lastSuccessfulSyncAtMs) {
    warnings.push(
      `No prior successful sync — searching from start of today (${getCalendarDateInTimezone()}).`
    );
  }

  const { auth, gmail } = await getAuthorizedGmailClient();

  const allow = options?.datasetNames?.length
    ? new Set(options.datasetNames)
    : null;

  const enabledDatasets = DATASET_SYNC_NAMES.filter((name) => {
    if (allow && !allow.has(name)) return false;
    // Hard scope: only executable dataset types may be searched for sync/processing.
    // Executive/Consulting keywords remain in setup for future independent processors.
    if (!isExecutableDatasetType(name)) return false;
    return setup.datasets?.[name]?.enabled !== false;
  });

  if (enabledDatasets.length === 0) {
    throw new Error(
      "No executable datasets are enabled for Gmail search. Only Lateral Dataset automation runs currently."
    );
  }

  if (
    setup.gmailAddress &&
    auth.email &&
    setup.gmailAddress.toLowerCase() !== auth.email.toLowerCase()
  ) {
    warnings.push(
      `Connected mailbox (${auth.email}) differs from setup Gmail (${setup.gmailAddress}).`
    );
  }

  const fileTypes = new Set(DEFAULT_FILE_TYPES);
  for (const name of enabledDatasets) {
    for (const type of setup.datasets[name].fileTypes ?? []) {
      fileTypes.add(type);
    }
  }

  const query =
    scanMode === "incremental"
      ? buildAfterTimestampExcelQuery({
          afterMs,
          fileTypes: Array.from(fileTypes),
        })
      : buildDateScopedExcelQuery({
          date: scanDate,
          fileTypes: Array.from(fileTypes),
        });

  const list = await gmail.users.messages.list({
    userId: "me",
    q: query,
    maxResults: MAX_MESSAGES,
  });

  const messageRefs = list.data.messages ?? [];
  const raw: RawGmailAttachment[] = [];

  for (const ref of messageRefs) {
    if (!ref.id) continue;
    const full = await gmail.users.messages.get({
      userId: "me",
      id: ref.id,
      format: "full",
    });

    for (const datasetName of enabledDatasets) {
      const config = setup.datasets[datasetName];
      const matches = extractExcelAttachmentsFromMessage(full.data, {
        datasetName,
        keywords: config.keywords,
        fileTypes: config.fileTypes,
      });
      for (const match of matches) {
        // Enforce exclusive lower bound for incremental (Gmail after: can be fuzzy).
        if (scanMode === "incremental" && match.receivedAtMs <= afterMs) {
          continue;
        }
        raw.push(match);
      }
    }
  }

  const overrideKey =
    scanMode === "incremental"
      ? `after:${afterMs}`
      : scanDate;
  const overrides = await readSelectionOverrides();
  const rows = applyNewestPerDataset(raw, overrides, overrideKey);

  const queries = enabledDatasets.map((datasetName) => ({
    datasetName,
    query,
  }));

  return {
    connected: true,
    connectedEmail: auth.email,
    query,
    queries,
    scanMode,
    scanDate: scanMode === "date" ? scanDate : getCalendarDateInTimezone(),
    afterMs: scanMode === "incremental" ? afterMs : null,
    lastSuccessfulSyncAt: watermark.lastSuccessfulSyncAt,
    scannedAt: new Date().toISOString(),
    messageCount: messageRefs.length,
    rows,
    warnings,
  };
}

/** @deprecated Prefer `@/services/dataset/google-connection` — kept for existing imports. */
export { getGmailConnectionStatus } from "@/services/dataset/google-connection";
