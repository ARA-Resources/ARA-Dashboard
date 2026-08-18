"use client";

import * as React from "react";
import Link from "next/link";
import {
  Activity,
  ExternalLink,
  FolderOpen,
  History,
  Mail,
  Pause,
  Play,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Upload,
} from "lucide-react";
import { FadeIn } from "@/animations/fade-in";
import { PageHeader } from "@/components/layouts/page-header";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ROUTES } from "@/constants/routes";
import { cn } from "@/lib/utils";
import type {
  DatasetAutomationHealthStatus,
  DatasetConfigOverviewRow,
  DatasetConfigurationOverview,
} from "@/types/dataset-config-overview";
import { isExecutableDatasetType } from "@/types/dataset-execution";

const STATUS_STYLES: Record<DatasetAutomationHealthStatus, string> = {
  Healthy: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  Attention: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
  Paused: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
  Disabled: "bg-muted text-muted-foreground",
  "Not configured": "bg-muted text-muted-foreground",
  Error: "bg-rose-500/10 text-rose-700 dark:text-rose-300",
};

function formatList(
  items: Array<{ label: string; muted?: boolean }>,
  empty = "—"
) {
  if (items.length === 0) return empty;
  return items
    .map((item) => (item.muted ? `${item.label} (off)` : item.label))
    .join(", ");
}

function Meta({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="grid gap-1 sm:grid-cols-[8.5rem_1fr] sm:items-start sm:gap-3">
      <dt className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="break-words text-sm text-foreground">{value}</dd>
    </div>
  );
}

export function DatasetConfigurationDashboard() {
  const [loading, setLoading] = React.useState(true);
  const [overview, setOverview] =
    React.useState<DatasetConfigurationOverview | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [actionMessage, setActionMessage] = React.useState<string | null>(null);
  const [busyDataset, setBusyDataset] = React.useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/dataset/configuration");
      const payload = (await response.json().catch(() => null)) as
        | (DatasetConfigurationOverview & { error?: string })
        | null;
      if (!response.ok || !payload) {
        throw new Error(payload?.error ?? "Failed to load configuration.");
      }
      setOverview(payload);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load.");
    } finally {
      setLoading(false);
    }
  }

  React.useEffect(() => {
    void load();
  }, []);

  async function runAction(
    datasetName: string,
    action: string
  ) {
    setBusyDataset(datasetName);
    setActionMessage(null);
    setError(null);
    try {
      const response = await fetch("/api/dataset/configuration", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, datasetName }),
      });
      const payload = (await response.json().catch(() => null)) as {
        error?: string;
        message?: string;
        overview?: DatasetConfigurationOverview;
        scan?: unknown;
        folder?: unknown;
      } | null;
      if (!response.ok) {
        throw new Error(payload?.error ?? "Action failed.");
      }
      if (payload?.overview) setOverview(payload.overview);
      setActionMessage(payload?.message ?? "Done.");
      if (action === "test_gmail" || action === "test_upload") {
        // keep message; no full reload required
      } else {
        await load();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed.");
    } finally {
      setBusyDataset(null);
    }
  }

  function renderCard(row: DatasetConfigOverviewRow) {
    const busy = busyDataset === row.datasetName;
    const schedulesPaused =
      row.schedules.length > 0 &&
      row.schedules.every((schedule) => schedule.statusLabel !== "Active");

    return (
      <Card key={row.datasetName} className="shadow-sm">
        <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
          <div className="space-y-1">
            <CardTitle className="flex items-center gap-2 text-base">
              <span className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <ShieldCheck className="size-4" />
              </span>
              {row.datasetName}
            </CardTitle>
            <CardDescription>{row.statusDetail}</CardDescription>
          </div>
          <Badge
            variant="secondary"
            className={cn(
              "rounded-md font-medium",
              STATUS_STYLES[row.status]
            )}
          >
            {row.status}
          </Badge>
        </CardHeader>
        <CardContent className="space-y-4">
          <dl className="space-y-2.5 rounded-xl border border-border/70 bg-muted/20 px-3 py-3">
            <Meta
              label="Gmail Account"
              value={
                row.gmailAccount ? (
                  <span>
                    {row.gmailAccount}
                    <span className="ml-2 text-xs text-muted-foreground">
                      {row.gmailConnected
                        ? `connected${
                            row.gmailConnectedEmail
                              ? ` · ${row.gmailConnectedEmail}`
                              : ""
                          }`
                        : "not connected"}
                    </span>
                  </span>
                ) : (
                  "—"
                )
              }
            />
            <Meta
              label="Search Keywords"
              value={formatList(
                row.keywords.map((keyword) => ({
                  label: `${keyword.value} [${keyword.matchMode}]`,
                  muted: !keyword.enabled,
                }))
              )}
            />
            <Meta
              label="Drive Folder"
              value={
                <span>
                  {row.driveFolder.name}
                  {row.driveFolder.id !== "—" ? (
                    <span className="mt-0.5 block font-mono text-xs text-muted-foreground">
                      {row.driveFolder.id}
                    </span>
                  ) : null}
                </span>
              }
            />
            <Meta
              label="Schedule(s)"
              value={
                row.schedules.length === 0
                  ? "—"
                  : row.schedules
                      .map(
                        (schedule) =>
                          `${schedule.name} · ${schedule.timeLabel} (${schedule.statusLabel})`
                      )
                      .join(" · ")
              }
            />
            <Meta
              label="Last Sync"
              value={
                row.lastSyncAt
                  ? `${new Date(row.lastSyncAt).toLocaleString("en-IN")}${
                      row.lastSyncStatus ? ` · ${row.lastSyncStatus}` : ""
                    }`
                  : "—"
              }
            />
            <Meta
              label="Next Sync"
              value={
                row.nextSyncAt
                  ? new Date(row.nextSyncAt).toLocaleString("en-IN")
                  : "—"
              }
            />
            <Meta
              label="Current File"
              value={row.currentFileName || "—"}
            />
          </dl>

          <div className="flex flex-wrap gap-2">
            <Link
              href={`${ROUTES.datasetLateral}?edit=1&dataset=${encodeURIComponent(row.datasetName)}`}
              className={cn(
                buttonVariants({ size: "sm" }),
                "rounded-xl gap-1.5"
              )}
            >
              <Settings2 className="size-3.5" />
              Edit Configuration
            </Link>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="rounded-xl gap-1.5"
              disabled={busy || !isExecutableDatasetType(row.datasetName)}
              title={
                isExecutableDatasetType(row.datasetName)
                  ? "Run Lateral automation now"
                  : `${row.datasetName} processing is not enabled yet`
              }
              onClick={() => void runAction(row.datasetName, "run_now")}
            >
              <Play className="size-3.5" />
              {isExecutableDatasetType(row.datasetName)
                ? "Run Now"
                : "Coming soon"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="rounded-xl gap-1.5"
              disabled={
                busy ||
                !isExecutableDatasetType(row.datasetName) ||
                (row.datasetName !== "Lateral" && row.schedules.length === 0)
              }
              onClick={() =>
                void runAction(
                  row.datasetName,
                  schedulesPaused ? "resume" : "pause"
                )
              }
            >
              {schedulesPaused ? (
                <>
                  <Play className="size-3.5" />
                  Resume Automation
                </>
              ) : (
                <>
                  <Pause className="size-3.5" />
                  Pause Automation
                </>
              )}
            </Button>
            <Link
              href={ROUTES.datasetSyncHistory}
              className={cn(
                buttonVariants({ size: "sm", variant: "outline" }),
                "rounded-xl gap-1.5"
              )}
            >
              <History className="size-3.5" />
              View Logs
            </Link>
            {row.driveFolder.openUrl ? (
              <a
                href={row.driveFolder.openUrl}
                target="_blank"
                rel="noreferrer"
                className={cn(
                  buttonVariants({ size: "sm", variant: "outline" }),
                  "rounded-xl gap-1.5"
                )}
              >
                <FolderOpen className="size-3.5" />
                Open Google Drive Folder
                <ExternalLink className="size-3" />
              </a>
            ) : (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="rounded-xl gap-1.5"
                disabled
              >
                <FolderOpen className="size-3.5" />
                Open Google Drive Folder
              </Button>
            )}
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="rounded-xl gap-1.5"
              disabled={busy}
              onClick={() => void runAction(row.datasetName, "test_gmail")}
            >
              <Mail className="size-3.5" />
              Test Gmail Search
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="rounded-xl gap-1.5"
              disabled={busy}
              onClick={() => void runAction(row.datasetName, "test_upload")}
            >
              <Upload className="size-3.5" />
              Test Upload
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (loading) {
    return (
      <div className="space-y-4">
        <PageHeader
          title="Dataset Configuration"
          description="Loading automation overview…"
        />
        <div className="grid gap-4 lg:grid-cols-3">
          <Skeleton className="h-28 rounded-xl" />
          <Skeleton className="h-28 rounded-xl" />
          <Skeleton className="h-28 rounded-xl" />
        </div>
        <Skeleton className="h-72 rounded-xl" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Dataset Configuration"
        description="One place to review Lateral, Executive, and Consulting automation health — keywords, Drive folders, schedules, and sync status."
        actions={
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              className="rounded-xl gap-1.5"
              onClick={() => void load()}
            >
              <RefreshCw className="size-4" />
              Refresh
            </Button>
            <Link
              href={`${ROUTES.datasetLateral}?edit=1`}
              className={cn(buttonVariants(), "rounded-xl gap-1.5")}
            >
              <Settings2 className="size-4" />
              Configure Dataset
            </Link>
          </div>
        }
      />

      {error ? (
        <p className="rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {actionMessage ? (
        <p className="rounded-xl border border-primary/20 bg-primary/5 px-3 py-2 text-sm text-primary">
          {actionMessage}
        </p>
      ) : null}

      <p className="rounded-xl border border-border/70 bg-muted/20 px-3 py-2 text-sm text-muted-foreground">
        Last successful sync:{" "}
        <span className="font-medium text-foreground">
          {overview?.lastSuccessfulSyncAt
            ? new Date(overview.lastSuccessfulSyncAt).toLocaleString("en-IN")
            : "— (next run uses start of today)"}
        </span>
        <span className="mt-0.5 block text-xs">
          Scheduled runs search Gmail for Excel emails received after this
          timestamp.
        </span>
      </p>

      <FadeIn>
        <div className="grid gap-3 sm:grid-cols-3">
          <Card className="shadow-sm">
            <CardContent className="flex items-center gap-3 py-4">
              <span className="flex size-10 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-700 dark:text-emerald-300">
                <Activity className="size-5" />
              </span>
              <div>
                <p className="text-2xl font-semibold tabular-nums">
                  {overview?.healthyCount ?? 0}
                </p>
                <p className="text-xs text-muted-foreground">Healthy</p>
              </div>
            </CardContent>
          </Card>
          <Card className="shadow-sm">
            <CardContent className="flex items-center gap-3 py-4">
              <span className="flex size-10 items-center justify-center rounded-xl bg-amber-500/10 text-amber-700 dark:text-amber-300">
                <Activity className="size-5" />
              </span>
              <div>
                <p className="text-2xl font-semibold tabular-nums">
                  {overview?.attentionCount ?? 0}
                </p>
                <p className="text-xs text-muted-foreground">Needs attention</p>
              </div>
            </CardContent>
          </Card>
          <Card className="shadow-sm">
            <CardContent className="flex items-center gap-3 py-4">
              <span className="flex size-10 items-center justify-center rounded-xl bg-muted text-muted-foreground">
                <Pause className="size-5" />
              </span>
              <div>
                <p className="text-2xl font-semibold tabular-nums">
                  {overview?.pausedCount ?? 0}
                </p>
                <p className="text-xs text-muted-foreground">Paused / disabled</p>
              </div>
            </CardContent>
          </Card>
        </div>
      </FadeIn>

      <div className="grid gap-4 xl:grid-cols-1">
        {(overview?.rows ?? []).map((row, index) => (
          <FadeIn key={row.datasetName} delay={index * 0.04}>
            {renderCard(row)}
          </FadeIn>
        ))}
      </div>
    </div>
  );
}
