"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import { useRouter, useSearchParams } from "next/navigation";
import {
  CalendarClock,
  Clock,
  FileSearch,
  FolderOpen,
  HardDrive,
  Inbox,
  Mail,
  MoreHorizontal,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Zap,
} from "lucide-react";
import { FadeIn } from "@/animations/fade-in";
import { ManagerSection } from "@/components/dataset/manager-section";
import { PageHeader } from "@/components/layouts/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { DATASET_CONFIGURATION_ROWS } from "@/data/mock/datasets.mock";
import type { DatasetConfigStatus } from "@/data/mock/datasets.mock";
import type { DatasetSetupConfig } from "@/types/dataset-setup";
import type { LateralDataProcessingSetup } from "@/types/lateral-processing-setup";
import type {
  DatasetDriveFileMeta,
  DatasetDriveFolderStats,
} from "@/types/drive-meta";
import type { DatasetSchedulerStatus } from "@/types/dataset-scheduler";
import type { MultiSchedulerStatus } from "@/types/dataset-schedule";
import type { LateralRunProgressSnapshot } from "@/types/lateral-scheduler";
import { DATASET_SYNC_NAMES } from "@/types/dataset-sync";
import { cn } from "@/lib/utils";
import { gmailOAuthStartHref } from "@/lib/config/gmail-oauth-start";
import { LateralRunProgressPanel } from "@/components/dataset/lateral-run-progress-panel";

const DatasetSetupWizard = dynamic(
  () =>
    import("@/components/dataset/setup-wizard").then((m) => m.DatasetSetupWizard),
  {
    loading: () => <Skeleton className="h-64 w-full rounded-2xl" />,
    ssr: false,
  }
);
const EnterpriseOpsPanel = dynamic(
  () =>
    import("@/components/dataset/enterprise-ops-panel").then(
      (m) => m.EnterpriseOpsPanel
    ),
  { ssr: false }
);
const GmailInboxPanel = dynamic(
  () =>
    import("@/components/dataset/gmail-inbox-panel").then(
      (m) => m.GmailInboxPanel
    ),
  { ssr: false }
);
const SchedulesPanel = dynamic(
  () =>
    import("@/components/dataset/schedules-panel").then((m) => m.SchedulesPanel),
  { ssr: false }
);
const LateralDatasetSetupWizard = dynamic(
  () =>
    import("@/components/dataset/lateral-dataset-setup-wizard").then(
      (m) => m.LateralDatasetSetupWizard
    ),
  {
    loading: () => <Skeleton className="h-64 w-full rounded-2xl" />,
    ssr: false,
  }
);
const LateralSchedulerPanel = dynamic(
  () =>
    import("@/components/dataset/lateral-scheduler-panel").then(
      (m) => m.LateralSchedulerPanel
    ),
  { ssr: false }
);
const LateralProcessingPreview = dynamic(
  () =>
    import("@/components/dataset/lateral-processing-preview").then(
      (m) => m.LateralProcessingPreview
    ),
  { ssr: false }
);
const UpdateGmailDrivePanel = dynamic(
  () =>
    import("@/components/dataset/update-gmail-drive-panel").then(
      (m) => m.UpdateGmailDrivePanel
    ),
  {
    loading: () => <Skeleton className="h-64 w-full rounded-2xl" />,
    ssr: false,
  }
);

const STATUS_STYLES: Record<DatasetConfigStatus, string> = {
  Active: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  Paused: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
  Error: "bg-rose-500/10 text-rose-700 dark:text-rose-300",
};

function ConnectionStatusBadge({
  status,
}: {
  status: "Connected" | "Not Connected" | "Pending setup";
}) {
  return (
    <Badge
      variant="secondary"
      className={cn(
        "rounded-md font-medium",
        status === "Connected" &&
          "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
        status === "Not Connected" &&
          "bg-rose-500/10 text-rose-700 dark:text-rose-300",
        status === "Pending setup" &&
          "bg-amber-500/10 text-amber-700 dark:text-amber-300"
      )}
    >
      {status}
    </Badge>
  );
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-1 sm:grid-cols-[9.5rem_1fr] sm:items-start sm:gap-3">
      <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="break-all text-sm text-foreground">{value}</dd>
    </div>
  );
}

function DatasetSearchSummary({ setup }: { setup: DatasetSetupConfig }) {
  return (
    <div className="space-y-3 sm:col-span-2">
      {DATASET_SYNC_NAMES.map((name) => {
        const config = setup.datasets?.[name];
        if (!config) return null;
        return (
          <div
            key={name}
            className="rounded-lg border border-border/60 bg-background/60 px-3 py-2"
          >
            <p className="text-sm font-medium text-foreground">
              {name}{" "}
              <span className="text-xs font-normal text-muted-foreground">
                {config.enabled ? "· enabled" : "· disabled"}
              </span>
            </p>
            <dl className="mt-2 grid gap-1.5 sm:grid-cols-2">
              <MetaRow
                label="Search Keywords"
                value={
                  (config.keywords ?? []).length
                    ? [...config.keywords]
                        .sort((a, b) => a.priority - b.priority)
                        .map(
                          (keyword) =>
                            `${keyword.value} [${keyword.matchMode}${keyword.enabled ? "" : ", off"}]`
                        )
                        .join(", ")
                    : "—"
                }
              />
              <MetaRow
                label="File Types"
                value={
                  config.fileTypes?.length
                    ? config.fileTypes.map((t) => `.${t}`).join(", ")
                    : "—"
                }
              />
              <MetaRow
                label="Drive Folder"
                value={
                  config.driveFolder?.folderName ||
                  config.driveFolder?.folderId ||
                  config.driveFolder?.folderUrl ||
                  "—"
                }
              />
              <MetaRow
                label="Folder ID"
                value={config.driveFolder?.folderId || "—"}
              />
            </dl>
          </div>
        );
      })}
    </div>
  );
}

function replacePolicyLabel(setup: DatasetSetupConfig) {
  if (setup.fileReplacePolicy === "replace") return "Yes — replace old file";
  if (setup.fileReplacePolicy === "keep_old") return "No — keep old file";
  return "Keep version history";
}

function syncLabel(setup: DatasetSetupConfig) {
  if (setup.syncFrequency === "hourly") return "Every hour";
  if (setup.syncFrequency === "weekdays") {
    return `Weekdays at ${setup.syncTime}`;
  }
  if (setup.syncFrequency === "custom") {
    const days = setup.customDays?.length
      ? setup.customDays.join(",")
      : "custom days";
    const times = setup.customTimes?.length
      ? setup.customTimes.join(", ")
      : setup.syncTime;
    return `Custom · ${days} · ${times}`;
  }
  return `Daily at ${setup.syncTime}`;
}

function driveFolderDisplay(setup: DatasetSetupConfig) {
  return DATASET_SYNC_NAMES.map((name) => {
    const folder = setup.datasets?.[name]?.driveFolder;
    if (!folder) return `${name}: —`;
    const label =
      folder.folderName ||
      folder.folderId ||
      folder.folderUrl ||
      "—";
    return `${name}: ${label}`;
  }).join(" · ");
}

type ManagerSectionId =
  | "configuration"
  | "drive-mapping"
  | "enterprise-ops"
  | "schedules"
  | "scheduler-controls"
  | "lateral-scheduler"
  | "gmail-connection"
  | "drive-connection"
  | "gmail-attachments"
  | "lateral-processing-preview"
  | "dataset-files";

const MANAGER_SECTION_IDS: ManagerSectionId[] = [
  "configuration",
  "drive-mapping",
  "enterprise-ops",
  "schedules",
  "scheduler-controls",
  "lateral-scheduler",
  "gmail-connection",
  "drive-connection",
  "gmail-attachments",
  "lateral-processing-preview",
  "dataset-files",
];

export function DatasetManager() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [loading, setLoading] = React.useState(true);
  const [setup, setSetup] = React.useState<DatasetSetupConfig | null>(null);
  const [editing, setEditing] = React.useState(false);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [gmailConnected, setGmailConnected] = React.useState(false);
  const [gmailConnectedEmail, setGmailConnectedEmail] = React.useState<
    string | null
  >(null);
  const [gmailLastSync, setGmailLastSync] = React.useState<string | null>(null);
  const [driveConnected, setDriveConnected] = React.useState(false);
  const [sharedConnectionNote, setSharedConnectionNote] = React.useState(
    "One Google account is shared by Lateral, Executive, and Consulting."
  );
  const [driveMetaByDataset, setDriveMetaByDataset] = React.useState<
    Record<string, DatasetDriveFileMeta>
  >({});
  const [currentByDataset, setCurrentByDataset] = React.useState<
    Record<
      string,
      {
        fileName: string;
        filePath: string;
        updatedAt: string;
        size: number;
        businessUnitId: string;
      }
    >
  >({});
  const [scheduler, setScheduler] = React.useState<MultiSchedulerStatus | null>(
    null
  );
  const [schedulerBusy, setSchedulerBusy] = React.useState(false);
  const [folderStats, setFolderStats] = React.useState<
    DatasetDriveFolderStats[]
  >([]);
  const [folderStatsLoading, setFolderStatsLoading] = React.useState(false);
  const [openSections, setOpenSections] = React.useState<
    Set<ManagerSectionId>
  >(() => new Set());
  const [lateralSetup, setLateralSetup] =
    React.useState<LateralDataProcessingSetup | null>(null);
  const [editingLateralSetup, setEditingLateralSetup] = React.useState(false);
  const [editingConnections, setEditingConnections] = React.useState(false);
  const [reconnectHint, setReconnectHint] = React.useState<string | null>(null);
  const [runAllConfirm, setRunAllConfirm] = React.useState(false);
  const [runAllBusy, setRunAllBusy] = React.useState(false);
  const [lateralJobRunning, setLateralJobRunning] = React.useState(false);
  const [lateralRunProgress, setLateralRunProgress] =
    React.useState<LateralRunProgressSnapshot | null>(null);
  const [runAllFeedback, setRunAllFeedback] = React.useState<{
    kind: "success" | "error";
    message: string;
  } | null>(null);
  const [schedulerRefreshKey, setSchedulerRefreshKey] = React.useState(0);

  const refreshLateralJobStatus = React.useCallback(async () => {
    const response = await fetch("/api/dataset/lateral/scheduler");
    const payload = (await response.json().catch(() => null)) as {
      running?: boolean;
      error?: string;
      processing?: { runProgress?: LateralRunProgressSnapshot | null };
    } | null;
    if (response.ok) {
      setLateralJobRunning(Boolean(payload?.running));
      setLateralRunProgress(payload?.processing?.runProgress ?? null);
    }
    return payload;
  }, []);

  async function runAllLateralProcessing() {
    setRunAllBusy(true);
    setRunAllFeedback(null);
    setLateralJobRunning(true);
    void refreshLateralJobStatus().catch(() => undefined);
    try {
      const response = await fetch("/api/dataset/lateral/scheduler", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "run_now" }),
      });
      const payload = (await response.json().catch(() => null)) as {
        error?: string;
        outcome?: { message?: string; status?: string };
      } | null;
      if (!response.ok) {
        throw new Error(payload?.error ?? "Run All failed.");
      }
      const outcomeStatus = payload?.outcome?.status;
      const message =
        payload?.outcome?.message ?? "Lateral processing finished.";
      setRunAllFeedback({
        kind: outcomeStatus === "failed" ? "error" : "success",
        message,
      });
      setSchedulerRefreshKey((key) => key + 1);
      const currentRes = await fetch("/api/dataset/current");
      const currentPayload = (await currentRes.json().catch(() => null)) as {
        datasets?: Array<{
          datasetName: string;
          businessUnitId: string;
          fileName: string;
          filePath: string;
          updatedAt: string;
          size: number;
        }>;
      } | null;
      const nextCurrent: typeof currentByDataset = {};
      for (const item of currentPayload?.datasets ?? []) {
        nextCurrent[item.datasetName] = {
          fileName: item.fileName,
          filePath: item.filePath,
          updatedAt: item.updatedAt,
          size: item.size,
          businessUnitId: item.businessUnitId,
        };
      }
      setCurrentByDataset(nextCurrent);
      await refreshFolderStats();
    } catch (error) {
      setRunAllFeedback({
        kind: "error",
        message:
          error instanceof Error ? error.message : "Run All failed unexpectedly.",
      });
    } finally {
      setRunAllBusy(false);
      setRunAllConfirm(false);
      await refreshLateralJobStatus().catch(() => undefined);
    }
  }

  function toggleSection(id: ManagerSectionId) {
    const opening = !openSections.has(id);
    setOpenSections((prev) => {
      const next = new Set(prev);
      if (opening) next.add(id);
      else next.delete(id);
      return next;
    });
    if (opening && id === "drive-mapping") {
      void refreshFolderStats(true);
    }
  }

  async function refreshFolderStats(live = true) {
    setFolderStatsLoading(true);
    try {
      const res = await fetch(
        live
          ? "/api/dataset/drive/folders?live=1"
          : "/api/dataset/drive/folders"
      );
      const payload = (await res.json().catch(() => null)) as {
        folders?: DatasetDriveFolderStats[];
      } | null;
      setFolderStats(payload?.folders ?? []);
    } finally {
      setFolderStatsLoading(false);
    }
  }

  React.useEffect(() => {
    void refreshLateralJobStatus().catch(() => undefined);
  }, [refreshLateralJobStatus]);

  React.useEffect(() => {
    if (!runAllBusy && !lateralJobRunning) return;
    const timer = window.setInterval(() => {
      void refreshLateralJobStatus().catch(() => undefined);
    }, 1500);
    return () => window.clearInterval(timer);
  }, [runAllBusy, lateralJobRunning, refreshLateralJobStatus]);

  React.useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setLoadError(null);
      try {
        // Critical path only — local/fast endpoints so the shell paints quickly.
        const [setupRes, connectionsRes, schedulerRes] = await Promise.all([
          fetch("/api/dataset/setup"),
          fetch("/api/dataset/connections"),
          fetch("/api/dataset/scheduler"),
        ]);
        const payload = (await setupRes.json()) as {
          configured?: boolean;
          setup?: DatasetSetupConfig | null;
          error?: string;
        };
        const connectionsPayload = (await connectionsRes
          .json()
          .catch(() => null)) as {
          email?: string | null;
          updatedAt?: string | null;
          gmail?: { connected?: boolean; label?: string };
          drive?: { connected?: boolean; label?: string };
          datasetTypes?: string[];
          error?: string;
        } | null;
        const schedulerPayload = (await schedulerRes
          .json()
          .catch(() => null)) as MultiSchedulerStatus | null;
        if (!setupRes.ok) {
          throw new Error(payload.error ?? "Failed to load dataset setup.");
        }
        if (!cancelled) {
          setSetup(payload.setup ?? null);
          setEditing(!payload.configured);
          setGmailConnected(Boolean(connectionsPayload?.gmail?.connected));
          setDriveConnected(Boolean(connectionsPayload?.drive?.connected));
          setGmailConnectedEmail(connectionsPayload?.email ?? null);
          setGmailLastSync(connectionsPayload?.updatedAt ?? null);
          if (connectionsPayload?.datasetTypes?.length) {
            setSharedConnectionNote(
              `One Google account is shared by ${connectionsPayload.datasetTypes.join(", ")}.`
            );
          }
          setScheduler(schedulerPayload);
          setLoading(false);
        }

        // Secondary local data — does not block first paint.
        const [driveMetaRes, currentRes, foldersRes, lateralSetupRes] = await Promise.all([
          fetch("/api/dataset/drive/metadata"),
          fetch("/api/dataset/current"),
          fetch("/api/dataset/drive/folders"),
          fetch("/api/dataset/lateral-processing/setup"),
        ]);
        if (cancelled) return;

        const driveMetaPayload = (await driveMetaRes
          .json()
          .catch(() => null)) as {
          byDataset?: Record<string, DatasetDriveFileMeta>;
        } | null;
        const currentPayload = (await currentRes.json().catch(() => null)) as {
          datasets?: Array<{
            datasetName: string;
            businessUnitId: string;
            fileName: string;
            filePath: string;
            updatedAt: string;
            size: number;
          }>;
        } | null;
        const foldersPayload = (await foldersRes.json().catch(() => null)) as {
          folders?: DatasetDriveFolderStats[];
        } | null;
        const lateralSetupPayload = (await lateralSetupRes
          .json()
          .catch(() => null)) as {
          setup?: LateralDataProcessingSetup | null;
        } | null;

        setDriveMetaByDataset(driveMetaPayload?.byDataset ?? {});
        setFolderStats(foldersPayload?.folders ?? []);
        setLateralSetup(lateralSetupPayload?.setup ?? null);
        const nextCurrent: typeof currentByDataset = {};
        for (const item of currentPayload?.datasets ?? []) {
          nextCurrent[item.datasetName] = {
            fileName: item.fileName,
            filePath: item.filePath,
            updatedAt: item.updatedAt,
            size: item.size,
            businessUnitId: item.businessUnitId,
          };
        }
        setCurrentByDataset(nextCurrent);
      } catch (err) {
        if (!cancelled) {
          setLoadError(
            err instanceof Error ? err.message : "Failed to load setup."
          );
          setEditing(true);
          setLoading(false);
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  React.useEffect(() => {
    if (loading) return;
    if (!setup) return;
    if (searchParams.get("editConnections") === "1") {
      setEditingConnections(true);
      router.replace("/dataset/lateral", { scroll: false });
      return;
    }
    if (searchParams.get("editLateral") === "1") {
      setEditingLateralSetup(true);
      router.replace("/dataset/lateral", { scroll: false });
      return;
    }
    if (searchParams.get("edit") !== "1") return;
    setEditing(true);
    router.replace("/dataset/lateral", { scroll: false });
  }, [loading, searchParams, setup, router]);

  const latestDriveUpload = React.useMemo(() => {
    const values = Object.values(driveMetaByDataset);
    if (values.length === 0) return null;
    return values.sort((a, b) =>
      b.uploadTime.localeCompare(a.uploadTime)
    )[0];
  }, [driveMetaByDataset]);

  if (loading) {
    return (
      <div className="space-y-4">
        <PageHeader
          title="Lateral Dataset"
          description="Complete Lateral setup. Shared Gmail and Drive connections are under Common Connections."
        />
        <Skeleton className="h-40 w-full rounded-2xl" />
        <Skeleton className="h-64 w-full rounded-2xl" />
      </div>
    );
  }

  if (editing || !setup) {
    return (
      <div>
        <PageHeader
          title="Lateral Dataset"
          description={
            setup
              ? "Edit configuration anytime. Save Changes reloads automation immediately — no restart."
              : "Setup required. Complete the wizard so automation can use your Gmail and Drive."
          }
        />
        {loadError ? (
          <p className="mb-4 rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {loadError}
          </p>
        ) : null}
        <DatasetSetupWizard
          key={setup?.updatedAt ?? "new-setup"}
          initial={setup}
          editing={Boolean(setup)}
          onCancel={
            setup
              ? () => {
                  setEditing(false);
                  setLoadError(null);
                }
              : undefined
          }
          onReset={async () => {
            const response = await fetch("/api/dataset/setup", {
              method: "DELETE",
            });
            const payload = (await response.json().catch(() => null)) as {
              error?: string;
              scheduler?: DatasetSchedulerStatus;
            } | null;
            if (!response.ok) {
              throw new Error(payload?.error ?? "Failed to reset configuration.");
            }
            setSetup(null);
            setEditing(true);
            if (payload?.scheduler) setScheduler(payload.scheduler);
          }}
          onSaved={(next) => {
            // updatedAt at epoch means reset cleared config
            if (new Date(next.updatedAt).getTime() === 0) {
              setSetup(null);
              setEditing(true);
              return;
            }
            setSetup(next);
            setEditing(false);
            setLoadError(null);
            void refreshFolderStats();
            void (async () => {
              const response = await fetch("/api/dataset/scheduler", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ action: "reload" }),
              });
              const payload = (await response.json().catch(() => null)) as {
                scheduler?: DatasetSchedulerStatus;
              } | null;
              if (payload?.scheduler) setScheduler(payload.scheduler);
            })();
          }}
        />
      </div>
    );
  }

  if (editingConnections && setup) {
    return (
      <div className="space-y-4">
        <PageHeader
          title="Lateral Dataset"
          description="Update the shared Gmail ID and per-dataset Google Drive folders."
        />
        <UpdateGmailDrivePanel
          setup={setup}
          onCancel={() => {
            setEditingConnections(false);
            setReconnectHint(null);
          }}
          onSaved={(next, options) => {
            setSetup(next);
            setEditingConnections(false);
            void refreshFolderStats(true);
            if (options.emailChanged) {
              setGmailConnected(false);
              setDriveConnected(false);
              setGmailConnectedEmail(null);
              setReconnectHint(
                "Gmail ID updated. Connect the shared Google account again for Gmail and Drive."
              );
              setOpenSections((prev) => {
                const n = new Set(prev);
                n.add("gmail-connection");
                n.add("drive-connection");
                return n;
              });
            } else {
              setReconnectHint(null);
              // Refresh live connection status after folder-only edits
              void fetch("/api/dataset/connections")
                .then((r) => r.json())
                .then((payload) => {
                  setGmailConnected(Boolean(payload?.gmail?.connected));
                  setDriveConnected(Boolean(payload?.drive?.connected));
                  setGmailConnectedEmail(payload?.email ?? null);
                  setGmailLastSync(payload?.updatedAt ?? null);
                })
                .catch(() => undefined);
            }
          }}
        />
      </div>
    );
  }

  if (editingLateralSetup) {
    return (
      <div>
        <PageHeader
          title="Lateral Dataset Setup"
          description="Configure keywords, Drive folders, source/master workbooks, sheets, schedule, and timezone. No Excel data is modified during configuration."
        />
        <LateralDatasetSetupWizard
          initial={lateralSetup}
          onCancel={() => setEditingLateralSetup(false)}
          onSaved={(next) => {
            setLateralSetup(next);
            setEditingLateralSetup(false);
            void refreshFolderStats(true);
            void fetch("/api/dataset/scheduler")
              .then((r) => r.json())
              .then((payload) => {
                if (payload) setScheduler(payload);
              })
              .catch(() => undefined);
          }}
        />
      </div>
    );
  }

  const gmailStatus = gmailConnected
    ? ("Connected" as const)
    : ("Not Connected" as const);
  const driveStatus = driveConnected
    ? ("Connected" as const)
    : ("Not Connected" as const);

  const datasetRows = DATASET_CONFIGURATION_ROWS.map((row) => {
    const driveMeta = driveMetaByDataset[row.name];
    const current = currentByDataset[row.name];
    return {
      ...row,
      sourceGmail: setup.gmailAddress,
      googleDriveFolder: driveFolderDisplay(setup),
      currentFile: current?.fileName ?? driveMeta?.fileName ?? row.currentFile,
      lastUpdated: current
        ? new Date(current.updatedAt).toLocaleString("en-IN")
        : driveMeta
          ? new Date(driveMeta.uploadTime).toLocaleString("en-IN")
          : row.lastUpdated,
      driveFileId: driveMeta?.driveFileId ?? null,
      driveUploadTime: driveMeta?.uploadTime ?? null,
      driveFileSize: driveMeta?.fileSize ?? current?.size ?? null,
      driveVersionNumber: driveMeta?.versionNumber ?? null,
      feedsDashboard: Boolean(current),
      status: current
        ? ("Active" as DatasetConfigStatus)
        : driveMeta
          ? ("Active" as DatasetConfigStatus)
          : row.status,
    };
  });

  const allOpen = MANAGER_SECTION_IDS.every((id) => openSections.has(id));
  const runAllDisabled = runAllBusy || lateralJobRunning;
  const runAllButtonLabel = runAllDisabled
    ? lateralRunProgress?.currentStageLabel?.trim() || "Running…"
    : "Run All";
  const confirmRunLabel = runAllDisabled
    ? lateralRunProgress?.currentStageLabel?.trim() || "Running…"
    : "Confirm Run All";

  return (
    <div>
      <PageHeader
        title="Lateral Dataset"
        description="Lateral automation: Gmail → Download → Validate → Drive → Master Sheet update → Dashboard cache → Company Dashboard."
        actions={
          runAllConfirm ? (
            <>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="rounded-xl"
                disabled={runAllDisabled}
                onClick={() => setRunAllConfirm(false)}
              >
                Cancel
              </Button>
              <Button
                type="button"
                size="sm"
                className="rounded-xl gap-1.5"
                disabled={runAllDisabled}
                onClick={() => void runAllLateralProcessing()}
              >
                <Zap className="size-3.5" />
                {confirmRunLabel}
              </Button>
            </>
          ) : (
            <Button
              type="button"
              size="sm"
              className="rounded-xl gap-1.5"
              disabled={runAllDisabled}
              onClick={() => {
                setRunAllConfirm(true);
                setRunAllFeedback(null);
              }}
            >
              <Zap className="size-3.5" />
              {runAllButtonLabel}
            </Button>
          )
        }
      />

      {runAllConfirm ? (
        <div className="mb-4 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-900 dark:text-amber-100">
          <p className="font-medium">Run the full Lateral pipeline?</p>
          <p className="mt-1 text-xs text-amber-800/90 dark:text-amber-200/90">
            Gmail scan → download &amp; validate source Excel → upload to Drive
            → update New Sheet → reconcile Job Status (Column K) → Posted Sheet
            (Column M) → refresh P-Roles → save &amp; upload Master Workbook.
          </p>
        </div>
      ) : null}

      {runAllDisabled && lateralRunProgress ? (
        <div className="mb-4">
          <LateralRunProgressPanel progress={lateralRunProgress} />
        </div>
      ) : null}

      {runAllFeedback ? (
        <div
          className={cn(
            "mb-4 rounded-xl border px-4 py-3 text-sm",
            runAllFeedback.kind === "success"
              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-800 dark:text-emerald-200"
              : "border-destructive/30 bg-destructive/10 text-destructive"
          )}
        >
          {runAllFeedback.message}
        </div>
      ) : null}

      <FadeIn>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border/80 bg-muted/20 px-4 py-3">
          <div>
            <p className="text-sm font-medium text-foreground">Control panels</p>
            <p className="text-xs text-muted-foreground">
              Click a section to show details. Click again to hide.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="rounded-xl"
              onClick={() =>
                setOpenSections(
                  allOpen ? new Set() : new Set(MANAGER_SECTION_IDS)
                )
              }
            >
              {allOpen ? "Collapse all" : "Expand all"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="rounded-xl gap-1.5"
              onClick={() => {
                setEditingConnections(true);
                setLoadError(null);
              }}
            >
              <Mail className="size-3.5" />
              Update Gmail & Drive
            </Button>
            <Button
              type="button"
              size="sm"
              className="rounded-xl gap-1.5"
              onClick={() => {
                setEditing(true);
                setLoadError(null);
              }}
            >
              <Settings2 className="size-3.5" />
              Configure Dataset
            </Button>
          </div>
        </div>
      </FadeIn>

      <div className="space-y-3">
        {reconnectHint ? (
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-200">
            {reconnectHint}
          </div>
        ) : null}
        <FadeIn>
          <ManagerSection
            id="configuration"
            title="Configuration"
            description="Gmail, keywords, Drive, schedule, versions, and notifications."
            icon={Settings2}
            open={openSections.has("configuration")}
            onToggle={() => toggleSection("configuration")}
          >
            <div className="space-y-3">
              <div className="flex justify-end">
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    className="rounded-xl gap-2"
                    onClick={() => {
                      setEditingConnections(true);
                      setLoadError(null);
                    }}
                  >
                    <Mail className="size-4" />
                    Update Gmail ID & Drive folders
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="rounded-xl gap-2"
                    onClick={() => {
                      setEditingLateralSetup(true);
                      setLoadError(null);
                    }}
                  >
                    <Settings2 className="size-4" />
                    Edit Lateral Setup
                  </Button>
                  <Button
                    type="button"
                    className="rounded-xl gap-2"
                    onClick={() => {
                      setEditing(true);
                      setLoadError(null);
                    }}
                  >
                    <Settings2 className="size-4" />
                    Configure Dataset
                  </Button>
                </div>
              </div>
              <dl className="grid gap-3 rounded-xl border border-border/70 bg-muted/20 px-3 py-3 sm:grid-cols-2">
                <MetaRow label="Gmail account" value={setup.gmailAddress || "—"} />
                <MetaRow
                  label="Drive account"
                  value={setup.driveAccountEmail || "—"}
                />
                <DatasetSearchSummary setup={setup} />
                <MetaRow
                  label="Drive folder"
                  value={driveFolderDisplay(setup)}
                />
                <MetaRow label="Schedule" value={syncLabel(setup)} />
                <MetaRow
                  label="File policy"
                  value={replacePolicyLabel(setup)}
                />
                <MetaRow
                  label="Notifications"
                  value={[
                    setup.notifyOnFailure !== false ? "Failure" : null,
                    setup.notifyOnSuccess ? "Success" : null,
                    setup.alertEmail || null,
                  ]
                    .filter(Boolean)
                    .join(" · ") || "In-app only"}
                />
                <MetaRow
                  label="Lateral Dataset Setup"
                  value={
                    lateralSetup
                      ? `Configured · ${new Date(lateralSetup.updatedAt).toLocaleString("en-IN")}`
                      : "Not configured"
                  }
                />
              </dl>
            </div>
          </ManagerSection>
        </FadeIn>

        <FadeIn>
          <ManagerSection
            id="drive-mapping"
            title="Drive folder mapping"
            description="Each dataset uploads only to its mapped folder. Never mixed."
            icon={HardDrive}
            open={openSections.has("drive-mapping")}
            onToggle={() => toggleSection("drive-mapping")}
            badge={
              folderStats.length ? (
                <Badge variant="secondary" className="rounded-md text-[10px]">
                  {folderStats.length} mapped
                </Badge>
              ) : null
            }
          >
            <div className="space-y-3">
              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="rounded-xl gap-1.5"
                  onClick={() => {
                    setEditingConnections(true);
                    setLoadError(null);
                  }}
                >
                  <Settings2 className="size-3.5" />
                  Update folders
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="rounded-xl gap-1.5"
                  disabled={folderStatsLoading}
                  onClick={() => void refreshFolderStats(true)}
                >
                  <RefreshCw
                    className={cn(
                      "size-3.5",
                      folderStatsLoading && "animate-spin"
                    )}
                  />
                  {folderStatsLoading ? "Refreshing…" : "Refresh from Drive"}
                </Button>
              </div>
              {folderStats.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No folder mappings yet. Configure a separate Drive folder for
                  Lateral, Executive, and Consulting.
                </p>
              ) : (
                <div className="overflow-x-auto rounded-xl border border-border">
                  <Table>
                    <TableHeader>
                      <TableRow className="bg-muted/40 hover:bg-muted/40">
                        <TableHead>Dataset</TableHead>
                        <TableHead>Folder Name</TableHead>
                        <TableHead>Folder ID</TableHead>
                        <TableHead>Last Upload</TableHead>
                        <TableHead className="text-right">Total Files</TableHead>
                        <TableHead className="text-right">Storage Used</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {folderStats.map((row) => (
                        <TableRow key={row.datasetName}>
                          <TableCell className="font-medium">
                            {row.datasetName}
                          </TableCell>
                          <TableCell>{row.folderName || "—"}</TableCell>
                          <TableCell className="break-all font-mono text-xs">
                            {row.folderId || "—"}
                          </TableCell>
                          <TableCell className="whitespace-nowrap text-sm text-muted-foreground tabular-nums">
                            {row.lastUpload
                              ? new Date(row.lastUpload).toLocaleString("en-IN")
                              : "—"}
                            {row.lastUploadFileName ? (
                              <span className="mt-0.5 block max-w-48 truncate text-xs">
                                {row.lastUploadFileName}
                              </span>
                            ) : null}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {row.totalFiles}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {row.storageUsedLabel}
                            {row.error ? (
                              <span className="mt-0.5 block text-xs text-amber-700 dark:text-amber-300">
                                {row.error}
                              </span>
                            ) : null}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </div>
          </ManagerSection>
        </FadeIn>

        <FadeIn>
          <ManagerSection
            id="enterprise-ops"
            title="Enterprise Ops"
            description="Retry, checksums, dedupe, Drive quota, pause/resume, rollback, and health."
            icon={ShieldCheck}
            open={openSections.has("enterprise-ops")}
            onToggle={() => toggleSection("enterprise-ops")}
          >
            <EnterpriseOpsPanel
              embedded
              scheduler={scheduler}
              onSchedulerChange={setScheduler}
              onDatasetsChanged={() => {
                void (async () => {
                  const currentRes = await fetch("/api/dataset/current");
                  const currentPayload = (await currentRes
                    .json()
                    .catch(() => null)) as {
                    datasets?: Array<{
                      datasetName: string;
                      businessUnitId: string;
                      fileName: string;
                      filePath: string;
                      updatedAt: string;
                      size: number;
                    }>;
                  } | null;
                  const nextCurrent: typeof currentByDataset = {};
                  for (const item of currentPayload?.datasets ?? []) {
                    nextCurrent[item.datasetName] = {
                      fileName: item.fileName,
                      filePath: item.filePath,
                      updatedAt: item.updatedAt,
                      size: item.size,
                      businessUnitId: item.businessUnitId,
                    };
                  }
                  setCurrentByDataset(nextCurrent);
                  await refreshFolderStats();
                })();
              }}
            />
          </ManagerSection>
        </FadeIn>

        <FadeIn>
          <ManagerSection
            id="lateral-scheduler"
            title="Lateral processing"
            description="Lateral connections, schedule, last sync result, and sync history. Run Now uses the same job as the daily cron."
            icon={Clock}
            open={openSections.has("lateral-scheduler")}
            onToggle={() => toggleSection("lateral-scheduler")}
          >
            <LateralSchedulerPanel
              key={schedulerRefreshKey}
              onEditSetup={() => setEditingLateralSetup(true)}
            />
          </ManagerSection>
        </FadeIn>

        <FadeIn>
          <ManagerSection
            id="schedules"
            title="Automation schedules"
            description={`Unlimited schedules for Lateral, Executive, and Consulting · TZ ${scheduler?.timezone ?? "Asia/Kolkata"}`}
            icon={CalendarClock}
            open={openSections.has("schedules")}
            onToggle={() => toggleSection("schedules")}
            badge={
              <Badge variant="secondary" className="rounded-md text-[10px]">
                {scheduler?.scheduleCount ?? 0} schedule
                {(scheduler?.scheduleCount ?? 0) === 1 ? "" : "s"}
              </Badge>
            }
          >
            <SchedulesPanel
              embedded
              scheduler={scheduler}
              onSchedulerChange={setScheduler}
              busy={schedulerBusy}
            />
          </ManagerSection>
        </FadeIn>

        <FadeIn>
          <ManagerSection
            id="scheduler-controls"
            title="Scheduler controls"
            description={
              scheduler?.globalPaused
                ? "All schedules are globally paused"
                : `${scheduler?.activeCount ?? 0} active of ${scheduler?.scheduleCount ?? 0} schedule(s) · ${scheduler?.timezone ?? "Asia/Kolkata"}`
            }
            icon={Clock}
            open={openSections.has("scheduler-controls")}
            onToggle={() => toggleSection("scheduler-controls")}
            badge={
              <ConnectionStatusBadge
                status={
                  scheduler?.globalPaused
                    ? "Pending setup"
                    : scheduler?.enabled
                      ? "Connected"
                      : "Not Connected"
                }
              />
            }
          >
            <div className="space-y-4">
              <dl className="grid gap-3 rounded-xl border border-border/70 bg-muted/20 px-3 py-3 sm:grid-cols-2">
                <MetaRow
                  label="Status"
                  value={
                    scheduler?.running
                      ? "Running now"
                      : scheduler?.enabled
                        ? "Armed"
                        : "Not armed"
                  }
                />
                <MetaRow
                  label="Active schedules"
                  value={String(scheduler?.activeCount ?? 0)}
                />
                <MetaRow
                  label="Next run"
                  value={
                    scheduler?.nextRunAt
                      ? new Date(scheduler.nextRunAt).toLocaleString("en-IN")
                      : "—"
                  }
                />
                <MetaRow
                  label="Last run"
                  value={
                    scheduler?.lastRunAt
                      ? `${new Date(scheduler.lastRunAt).toLocaleString("en-IN")}${
                          scheduler.lastRunStatus
                            ? ` · ${scheduler.lastRunStatus}`
                            : ""
                        }`
                      : "Not run yet"
                  }
                />
              </dl>
              {scheduler?.lastRunMessage ? (
                <p className="text-sm text-muted-foreground">
                  {scheduler.lastRunMessage}
                </p>
              ) : null}
              {scheduler?.lastError ? (
                <p className="text-sm text-destructive">{scheduler.lastError}</p>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  className="rounded-xl gap-2"
                  disabled={schedulerBusy}
                  onClick={() => {
                    void (async () => {
                      setSchedulerBusy(true);
                      try {
                        const response = await fetch("/api/dataset/scheduler", {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({
                            action: scheduler?.globalPaused ? "resume" : "pause",
                          }),
                        });
                        const payload = (await response.json()) as {
                          scheduler?: MultiSchedulerStatus;
                          error?: string;
                        };
                        if (!response.ok) {
                          throw new Error(payload.error ?? "Action failed.");
                        }
                        setScheduler(payload.scheduler ?? null);
                      } catch (error) {
                        setLoadError(
                          error instanceof Error
                            ? error.message
                            : "Failed to update scheduler."
                        );
                      } finally {
                        setSchedulerBusy(false);
                      }
                    })();
                  }}
                >
                  {scheduler?.globalPaused ? "Resume all" : "Pause all"}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="rounded-xl gap-2"
                  disabled={schedulerBusy}
                  onClick={() => {
                    void (async () => {
                      setSchedulerBusy(true);
                      try {
                        const response = await fetch("/api/dataset/scheduler", {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ action: "reload" }),
                        });
                        const payload = (await response.json()) as {
                          scheduler?: MultiSchedulerStatus;
                          error?: string;
                        };
                        if (!response.ok) {
                          throw new Error(payload.error ?? "Reload failed.");
                        }
                        setScheduler(payload.scheduler ?? null);
                      } catch (error) {
                        setLoadError(
                          error instanceof Error
                            ? error.message
                            : "Failed to reload scheduler."
                        );
                      } finally {
                        setSchedulerBusy(false);
                      }
                    })();
                  }}
                >
                  <RefreshCw className="size-4" />
                  Reload schedules
                </Button>
                <Button
                  type="button"
                  className="rounded-xl gap-2"
                  disabled={schedulerBusy || Boolean(scheduler?.running)}
                  onClick={() => {
                    void (async () => {
                      setSchedulerBusy(true);
                      try {
                        const response = await fetch("/api/dataset/scheduler", {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ action: "run_now" }),
                        });
                        const payload = (await response.json()) as {
                          scheduler?: MultiSchedulerStatus;
                          error?: string;
                        };
                        if (!response.ok) {
                          throw new Error(payload.error ?? "Sync failed.");
                        }
                        setScheduler(payload.scheduler ?? null);
                        const currentRes = await fetch("/api/dataset/current");
                        const currentPayload = (await currentRes
                          .json()
                          .catch(() => null)) as {
                          datasets?: Array<{
                            datasetName: string;
                            businessUnitId: string;
                            fileName: string;
                            filePath: string;
                            updatedAt: string;
                            size: number;
                          }>;
                        } | null;
                        const nextCurrent: typeof currentByDataset = {};
                        for (const item of currentPayload?.datasets ?? []) {
                          nextCurrent[item.datasetName] = {
                            fileName: item.fileName,
                            filePath: item.filePath,
                            updatedAt: item.updatedAt,
                            size: item.size,
                            businessUnitId: item.businessUnitId,
                          };
                        }
                        setCurrentByDataset(nextCurrent);
                      } catch (error) {
                        setLoadError(
                          error instanceof Error
                            ? error.message
                            : "Failed to run sync."
                        );
                      } finally {
                        setSchedulerBusy(false);
                      }
                    })();
                  }}
                >
                  <RefreshCw className="size-4" />
                  Run sync now
                </Button>
              </div>
            </div>
          </ManagerSection>
        </FadeIn>

        <FadeIn>
          <ManagerSection
            id="gmail-connection"
            title="Gmail Connection"
            description={`${sharedConnectionNote} Tokens stay on the server — never in the browser.`}
            icon={Mail}
            open={openSections.has("gmail-connection")}
            onToggle={() => toggleSection("gmail-connection")}
            badge={<ConnectionStatusBadge status={gmailStatus} />}
          >
            <div className="space-y-4">
              <dl className="space-y-3 rounded-xl border border-border/70 bg-muted/20 px-3 py-3">
                <MetaRow label="Gmail Connection" value={gmailStatus} />
                <MetaRow
                  label="Connected Email"
                  value={gmailConnectedEmail || setup.gmailAddress || "—"}
                />
                <MetaRow
                  label="Shared with"
                  value="Lateral · Executive · Consulting"
                />
                <MetaRow
                  label="Last token update"
                  value={
                    gmailLastSync
                      ? new Date(gmailLastSync).toLocaleString("en-IN")
                      : "Not connected yet"
                  }
                />
              </dl>
              <DatasetSearchSummary setup={setup} />
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  className="rounded-xl gap-2"
                  onClick={() => {
                    setEditingConnections(true);
                    setLoadError(null);
                  }}
                >
                  <Settings2 className="size-4" />
                  Update Gmail ID
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="rounded-xl gap-2"
                  onClick={() => {
                    window.location.href = gmailOAuthStartHref(
                      setup.gmailAddress
                    );
                  }}
                >
                  <RefreshCw className="size-4" />
                  {gmailConnected ? "Reconnect Gmail" : "Connect Gmail"}
                </Button>
              </div>
            </div>
          </ManagerSection>
        </FadeIn>

        <FadeIn>
          <ManagerSection
            id="drive-connection"
            title="Google Drive Connection"
            description={`${sharedConnectionNote} Same OAuth as Gmail. Replace policy: ${replacePolicyLabel(setup)}`}
            icon={HardDrive}
            open={openSections.has("drive-connection")}
            onToggle={() => toggleSection("drive-connection")}
            badge={<ConnectionStatusBadge status={driveStatus} />}
          >
            <div className="space-y-4">
              <dl className="space-y-3 rounded-xl border border-border/70 bg-muted/20 px-3 py-3">
                <MetaRow label="Google Drive Connection" value={driveStatus} />
                <MetaRow
                  label="Connected Account"
                  value={
                    gmailConnectedEmail ||
                    setup.driveAccountEmail ||
                    setup.gmailAddress ||
                    "—"
                  }
                />
                <MetaRow
                  label="Shared with"
                  value="Lateral · Executive · Consulting"
                />
                <MetaRow
                  label="Folder mapping"
                  value={driveFolderDisplay(setup)}
                />
                <MetaRow
                  label="Last Upload"
                  value={
                    latestDriveUpload
                      ? new Date(latestDriveUpload.uploadTime).toLocaleString(
                          "en-IN"
                        )
                      : "Not uploaded yet"
                  }
                />
                <MetaRow label="Schedule" value={syncLabel(setup)} />
              </dl>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  className="rounded-xl gap-2"
                  onClick={() => {
                    setEditingConnections(true);
                    setLoadError(null);
                  }}
                >
                  <Settings2 className="size-4" />
                  Update Drive folders
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="rounded-xl gap-2"
                  onClick={() => {
                    window.location.href = gmailOAuthStartHref(
                      setup.gmailAddress || setup.driveAccountEmail
                    );
                  }}
                >
                  <RefreshCw className="size-4" />
                  {driveConnected ? "Reconnect Drive" : "Connect Drive"}
                </Button>
              </div>
            </div>
          </ManagerSection>
        </FadeIn>

        <FadeIn>
          <ManagerSection
            id="gmail-attachments"
            title="Gmail Excel attachments"
            description="Scan inbox, assign by keywords, and run sync for Lateral, Executive, and Consulting."
            icon={Inbox}
            open={openSections.has("gmail-attachments")}
            onToggle={() => toggleSection("gmail-attachments")}
          >
            <GmailInboxPanel
              embedded
              setupEmail={setup.gmailAddress}
              onSyncComplete={() => {
                void (async () => {
                  const [driveRes, currentRes] = await Promise.all([
                    fetch("/api/dataset/drive/metadata"),
                    fetch("/api/dataset/current"),
                  ]);
                  const drivePayload = (await driveRes
                    .json()
                    .catch(() => null)) as {
                    byDataset?: Record<string, DatasetDriveFileMeta>;
                  } | null;
                  const currentPayload = (await currentRes
                    .json()
                    .catch(() => null)) as {
                    datasets?: Array<{
                      datasetName: string;
                      businessUnitId: string;
                      fileName: string;
                      filePath: string;
                      updatedAt: string;
                      size: number;
                    }>;
                  } | null;
                  setDriveMetaByDataset(drivePayload?.byDataset ?? {});
                  const nextCurrent: typeof currentByDataset = {};
                  for (const item of currentPayload?.datasets ?? []) {
                    nextCurrent[item.datasetName] = {
                      fileName: item.fileName,
                      filePath: item.filePath,
                      updatedAt: item.updatedAt,
                      size: item.size,
                      businessUnitId: item.businessUnitId,
                    };
                  }
                  setCurrentByDataset(nextCurrent);
                  await refreshFolderStats();
                })();
              }}
            />
          </ManagerSection>
        </FadeIn>

        <FadeIn>
          <ManagerSection
            id="lateral-processing-preview"
            title="Lateral Dataset Processing Pipeline"
            description="Safe end-to-end sync: latest source Excel → New Sheet → reconcile → VBA → Drive destination → Dataset Manager."
            icon={FileSearch}
            open={openSections.has("lateral-processing-preview")}
            onToggle={() => toggleSection("lateral-processing-preview")}
            badge={
              lateralSetup ? (
                <Badge variant="secondary" className="rounded-md text-[10px]">
                  Setup configured
                </Badge>
              ) : (
                <Badge
                  variant="secondary"
                  className="rounded-md bg-amber-500/10 text-amber-700 dark:text-amber-300 text-[10px]"
                >
                  Setup required
                </Badge>
              )
            }
          >
            {lateralSetup ? (
              <LateralProcessingPreview />
            ) : (
              <div className="rounded-xl border border-amber-400/30 bg-amber-400/5 px-4 py-3 text-sm">
                <p className="font-medium text-amber-800 dark:text-amber-200">
                  Setup not configured
                </p>
                <p className="mt-1 text-muted-foreground">
                  Complete the{" "}
                  <button
                    type="button"
                    className="underline underline-offset-2"
                    onClick={() => {
                      setEditingLateralSetup(true);
                      setLoadError(null);
                    }}
                  >
                    Lateral Dataset Setup
                  </button>{" "}
                  wizard first, then return here to preview the column
                  mapping.
                </p>
              </div>
            )}
          </ManagerSection>
        </FadeIn>

        <FadeIn>
          <ManagerSection
            id="dataset-files"
            title="Dataset Configuration"
            description="Latest current files under Dataset Manager feed Company dashboards."
            icon={FolderOpen}
            open={openSections.has("dataset-files")}
            onToggle={() => toggleSection("dataset-files")}
          >
            <div className="overflow-x-auto rounded-xl border border-border">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/40 hover:bg-muted/40">
                    <TableHead>Dataset Name</TableHead>
                    <TableHead className="min-w-40">Source Gmail</TableHead>
                    <TableHead className="min-w-48">
                      Google Drive Folder
                    </TableHead>
                    <TableHead className="min-w-56">Current File</TableHead>
                    <TableHead className="min-w-40">Drive File ID</TableHead>
                    <TableHead className="min-w-36">Upload Time</TableHead>
                    <TableHead className="text-right">File Size</TableHead>
                    <TableHead className="text-right">Version</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Schedule</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {datasetRows.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell className="font-medium text-foreground">
                        {row.name}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {row.sourceGmail}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {row.googleDriveFolder}
                      </TableCell>
                      <TableCell>
                        <div className="space-y-1">
                          <span className="block max-w-64 truncate text-sm text-foreground">
                            {row.currentFile}
                          </span>
                          {row.feedsDashboard ? (
                            <Badge
                              variant="secondary"
                              className="rounded-md bg-primary/10 text-primary"
                            >
                              Feeds dashboard
                            </Badge>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell>
                        <span className="block max-w-40 truncate font-mono text-xs text-muted-foreground">
                          {row.driveFileId ?? "—"}
                        </span>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground tabular-nums">
                        {row.driveUploadTime
                          ? new Date(row.driveUploadTime).toLocaleString(
                              "en-IN"
                            )
                          : "—"}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {row.driveFileSize != null
                          ? `${(row.driveFileSize / 1024).toFixed(1)} KB`
                          : "—"}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {row.driveVersionNumber != null
                          ? `v${row.driveVersionNumber}`
                          : "—"}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant="secondary"
                          className={cn(
                            "rounded-md font-medium",
                            STATUS_STYLES[row.status]
                          )}
                        >
                          {row.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {syncLabel(setup)}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="rounded-lg"
                          disabled
                          aria-label={`Actions for ${row.name}`}
                        >
                          <MoreHorizontal className="size-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </ManagerSection>
        </FadeIn>
      </div>
    </div>
  );
}
