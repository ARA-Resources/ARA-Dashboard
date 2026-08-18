"use client";

import * as React from "react";
import {
  Download,
  History,
  RefreshCw,
  RotateCcw,
} from "lucide-react";
import { FadeIn } from "@/animations/fade-in";
import { PageHeader } from "@/components/layouts/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { SyncHistoryEntry, SyncHistoryStatus } from "@/types/sync-history";
import { cn } from "@/lib/utils";

const STATUS_STYLES: Record<SyncHistoryStatus, string> = {
  success: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  updated: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  partial: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
  skipped: "bg-muted text-muted-foreground",
  failed: "bg-rose-500/10 text-rose-700 dark:text-rose-300",
};

function formatDuration(ms: number) {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${ms} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const minutes = Math.floor(seconds / 60);
  const rem = Math.round(seconds % 60);
  return `${minutes}m ${rem}s`;
}

function formatSyncTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function statusLabel(status: SyncHistoryStatus) {
  if (status === "updated") return "Updated";
  return status.charAt(0).toUpperCase() + status.slice(1);
}

export function SyncHistoryPage() {
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [entries, setEntries] = React.useState<SyncHistoryEntry[]>([]);
  const [downloadingId, setDownloadingId] = React.useState<string | null>(null);
  const [retryingId, setRetryingId] = React.useState<string | null>(null);

  const load = React.useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/dataset/sync-history?limit=200", {
        cache: "no-store",
      });
      const payload = (await response.json()) as {
        entries?: SyncHistoryEntry[];
        error?: string;
      };
      if (!response.ok) {
        throw new Error(payload.error ?? "Failed to load sync history.");
      }
      setEntries(payload.entries ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load history.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  async function retryFailed(entry: SyncHistoryEntry) {
    setRetryingId(entry.id);
    setError(null);
    try {
      const response = await fetch("/api/dataset/ops", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "retry",
          historyEntryId: entry.id,
        }),
      });
      const payload = (await response.json().catch(() => null)) as {
        error?: string;
      } | null;
      if (!response.ok) {
        throw new Error(payload?.error ?? "Retry failed.");
      }
      await load(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Retry failed.");
    } finally {
      setRetryingId(null);
    }
  }

  async function downloadLog(entry: SyncHistoryEntry) {
    setDownloadingId(entry.id);
    try {
      const response = await fetch(`/api/dataset/sync-history/${entry.id}/log`);
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(payload?.error ?? "Failed to download log.");
      }
      const blob = await response.blob();
      const disposition = response.headers.get("Content-Disposition") ?? "";
      const match = /filename="([^"]+)"/.exec(disposition);
      const filename =
        match?.[1] ??
        `dataset-sync-${entry.logDay}-${entry.dataset}.jsonl`;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Download failed.");
    } finally {
      setDownloadingId(null);
    }
  }

  if (loading) {
    return (
      <div className="space-y-4">
        <PageHeader
          title="Sync History"
          description="Track Dataset Manager sync runs across Lateral, Executive, and Consulting."
        />
        <Skeleton className="h-64 w-full rounded-2xl" />
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="Sync History"
        description="Dataset sync runs with Gmail download, Drive upload, duration, status, and errors."
        actions={
          <Button
            type="button"
            variant="outline"
            className="rounded-xl gap-2"
            disabled={refreshing}
            onClick={() => {
              void load(true);
            }}
          >
            <RefreshCw
              className={cn("size-4", refreshing && "animate-spin")}
            />
            Refresh
          </Button>
        }
      />

      {error ? (
        <p className="mb-4 rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <FadeIn>
        <Card className="shadow-sm">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <span className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <History className="size-4" />
              </span>
              Sync runs
            </CardTitle>
            <CardDescription>
              {entries.length} recorded event
              {entries.length === 1 ? "" : "s"}. Notifications for each dataset
              appear in the bell panel.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto rounded-xl border border-border">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/40 hover:bg-muted/40">
                    <TableHead>Dataset</TableHead>
                    <TableHead className="min-w-40">Sync Time</TableHead>
                    <TableHead className="min-w-40">Downloaded From</TableHead>
                    <TableHead className="min-w-44">Uploaded To</TableHead>
                    <TableHead className="min-w-52">File Name</TableHead>
                    <TableHead className="text-right">Duration</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="min-w-48">Errors</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {entries.length === 0 ? (
                    <TableRow>
                      <TableCell
                        colSpan={9}
                        className="py-10 text-center text-sm text-muted-foreground"
                      >
                        No sync history yet. Run an automatic or manual Dataset
                        sync to populate this table.
                      </TableCell>
                    </TableRow>
                  ) : (
                    entries.map((entry) => (
                      <TableRow key={entry.id}>
                        <TableCell className="font-medium text-foreground">
                          {entry.dataset}
                        </TableCell>
                        <TableCell className="whitespace-nowrap tabular-nums text-muted-foreground">
                          {formatSyncTime(entry.syncTime)}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {entry.downloadedFrom}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {entry.uploadedTo}
                        </TableCell>
                        <TableCell>
                          <span className="block max-w-56 truncate text-sm text-foreground">
                            {entry.fileName}
                          </span>
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-muted-foreground">
                          {formatDuration(entry.durationMs)}
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant="secondary"
                            className={cn(
                              "rounded-md font-medium",
                              STATUS_STYLES[entry.status]
                            )}
                          >
                            {statusLabel(entry.status)}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <span
                            className={cn(
                              "block max-w-56 truncate text-sm",
                              entry.errors
                                ? "text-destructive"
                                : "text-muted-foreground"
                            )}
                            title={entry.errors ?? undefined}
                          >
                            {entry.errors || "—"}
                          </span>
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-1.5">
                            {entry.status === "failed" ? (
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                className="rounded-lg gap-1.5"
                                disabled={retryingId === entry.id}
                                onClick={() => {
                                  void retryFailed(entry);
                                }}
                              >
                                <RotateCcw className="size-3.5" />
                                Retry
                              </Button>
                            ) : null}
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              className="rounded-lg gap-1.5"
                              disabled={downloadingId === entry.id}
                              onClick={() => {
                                void downloadLog(entry);
                              }}
                            >
                              <Download className="size-3.5" />
                              Log
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      </FadeIn>
    </div>
  );
}
