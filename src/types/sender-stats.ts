export interface DatasetSenderStats {
  datasetName: string;
  email: string;
  enabled: boolean;
  priority: number;
  lastEmailReceived: string | null;
  lastSuccessfulDownload: string | null;
  filesDownloaded: number;
  /** Downloads attempted (success + failure after match) */
  downloadAttempts: number;
  /** Successful Drive/Dataset Manager promotions */
  successfulDownloads: number;
  /** 0–100 */
  successRate: number;
}

export interface SenderStatsRecord {
  datasetName: string;
  email: string;
  lastEmailReceived: string | null;
  lastSuccessfulDownload: string | null;
  filesDownloaded: number;
  downloadAttempts: number;
  successfulDownloads: number;
}

export interface SenderStatsStore {
  version: 1;
  updatedAt: string;
  /** key: `${datasetName}|${email}` */
  records: Record<string, SenderStatsRecord>;
}

export function senderStatsKey(datasetName: string, email: string) {
  return `${datasetName}|${email.trim().toLowerCase()}`;
}
