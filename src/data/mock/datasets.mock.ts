export type DatasetConfigStatus = "Active" | "Paused" | "Error";
export type DatasetSchedule = "Manual" | "Daily" | "Weekly";

export interface GmailConnectionPlaceholder {
  connectionStatus: "Connected" | "Disconnected";
  connectedEmail: string;
  lastSync: string;
}

export interface DriveConnectionPlaceholder {
  driveName: string;
  folder: string;
  folderId: string;
  lastUpload: string;
  connectionStatus: "Connected" | "Disconnected";
}

export interface DatasetConfigRow {
  id: string;
  name: string;
  sourceGmail: string;
  googleDriveFolder: string;
  currentFile: string;
  lastUpdated: string;
  status: DatasetConfigStatus;
  schedule: DatasetSchedule;
}

export const GMAIL_CONNECTION_PLACEHOLDER: GmailConnectionPlaceholder = {
  connectionStatus: "Connected",
  connectedEmail: "ara.datasets@example.com",
  lastSync: "07 Aug 2026, 02:14 PM IST",
};

export const DRIVE_CONNECTION_PLACEHOLDER: DriveConnectionPlaceholder = {
  driveName: "ARA Hiring Shared Drive",
  folder: "ATCI Control Sheets",
  folderId: "1aBcDeFgHiJkLmNoPqRsTuVwXyZ",
  lastUpload: "07 Aug 2026, 01:52 PM IST",
  connectionStatus: "Connected",
};

/** Initial business-unit datasets — UI placeholders only. */
export const DATASET_CONFIGURATION_ROWS: DatasetConfigRow[] = [
  {
    id: "ds-lateral",
    name: "Lateral",
    sourceGmail: "ara.datasets@example.com",
    googleDriveFolder: "ATCI Control Sheets / Lateral",
    currentFile: "ATCI Lateral DS AI MasterSheet Final 2026.xlsm",
    lastUpdated: "07 Aug 2026, 01:52 PM",
    status: "Active",
    schedule: "Daily",
  },
  {
    id: "ds-executive",
    name: "Executive",
    sourceGmail: "ara.datasets@example.com",
    googleDriveFolder: "ATCI Control Sheets / Executive",
    currentFile: "ATCI Executive MasterSheet 2026.xlsx",
    lastUpdated: "06 Aug 2026, 06:10 PM",
    status: "Paused",
    schedule: "Weekly",
  },
  {
    id: "ds-consulting",
    name: "Consulting",
    sourceGmail: "ara.datasets@example.com",
    googleDriveFolder: "ATCI Control Sheets / Consulting",
    currentFile: "ATCI Consulting Openings 2026.xlsx",
    lastUpdated: "05 Aug 2026, 11:40 AM",
    status: "Active",
    schedule: "Manual",
  },
];
