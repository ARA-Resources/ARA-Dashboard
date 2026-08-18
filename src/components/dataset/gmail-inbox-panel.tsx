"use client";

import * as React from "react";
import {
  CheckCircle2,
  Download,
  Inbox,
  Link2,
  RefreshCw,
  Unplug,
  Upload,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { DatasetSyncResult } from "@/types/dataset-sync";
import type {
  GmailAttachmentStatus,
  GmailExcelAttachmentRow,
  GmailScanResult,
} from "@/types/gmail";
import { cn } from "@/lib/utils";
import { gmailOAuthStartHref } from "@/lib/config/gmail-oauth-start";

const STATUS_STYLES: Record<GmailAttachmentStatus, string> = {
  Newest: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  Selected: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 ring-1 ring-emerald-500/40",
  Matched: "bg-primary/10 text-primary",
  Superseded: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
  "Duplicate email": "bg-muted text-muted-foreground",
  "Duplicate attachment": "bg-muted text-muted-foreground",
};

const SYNC_STATUS_STYLES: Record<string, string> = {
  promoted: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  uploaded_drive: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  stored_temp: "bg-primary/10 text-primary",
  validation_failed: "bg-rose-500/10 text-rose-700 dark:text-rose-300",
  download_failed: "bg-rose-500/10 text-rose-700 dark:text-rose-300",
  upload_failed: "bg-rose-500/10 text-rose-700 dark:text-rose-300",
  skipped_duplicate: "bg-muted text-muted-foreground",
  skipped_superseded: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
  unmapped: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
};

type DatePreset = "since_last_sync" | "today" | "yesterday" | "custom";

interface GmailInboxPanelProps {
  setupEmail: string;
  onSyncComplete?: () => void;
  embedded?: boolean;
}

function formatReceived(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function localTodayIso() {
  const now = new Date();
  const offset = now.getTimezoneOffset();
  const local = new Date(now.getTime() - offset * 60_000);
  return local.toISOString().slice(0, 10);
}

function shiftIsoDate(iso: string, days: number) {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + days));
  return date.toISOString().slice(0, 10);
}

export function GmailInboxPanel({
  setupEmail,
  onSyncComplete,
  embedded = false,
}: GmailInboxPanelProps) {
  const [connected, setConnected] = React.useState(false);
  const [connectedEmail, setConnectedEmail] = React.useState<string | null>(
    null
  );
  const [oauthConfigured, setOauthConfigured] = React.useState(true);
  const [statusError, setStatusError] = React.useState<string | null>(null);
  const [scan, setScan] = React.useState<GmailScanResult | null>(null);
  const [syncResult, setSyncResult] = React.useState<DatasetSyncResult | null>(
    null
  );
  const [loadingStatus, setLoadingStatus] = React.useState(true);
  const [scanning, setScanning] = React.useState(false);
  const [syncing, setSyncing] = React.useState(false);
  const [rowBusyId, setRowBusyId] = React.useState<string | null>(null);
  const [scanError, setScanError] = React.useState<string | null>(null);
  const [banner, setBanner] = React.useState<string | null>(null);
  const [datePreset, setDatePreset] =
    React.useState<DatePreset>("since_last_sync");
  const [customDate, setCustomDate] = React.useState(localTodayIso());
  const [lastSuccessfulSyncAt, setLastSuccessfulSyncAt] = React.useState<
    string | null
  >(null);

  const resolvedDate =
    datePreset === "today"
      ? localTodayIso()
      : datePreset === "yesterday"
        ? shiftIsoDate(localTodayIso(), -1)
        : customDate;

  const isIncremental = datePreset === "since_last_sync";

  const refreshStatus = React.useCallback(async () => {
    setLoadingStatus(true);
    setStatusError(null);
    try {
      const response = await fetch("/api/dataset/gmail/status");
      const payload = (await response.json()) as {
        connected?: boolean;
        email?: string | null;
        oauthConfigured?: boolean;
        today?: string;
        lastSuccessfulSyncAt?: string | null;
        error?: string;
      };
      setOauthConfigured(payload.oauthConfigured ?? false);
      setConnected(Boolean(payload.connected));
      setConnectedEmail(payload.email ?? null);
      setLastSuccessfulSyncAt(payload.lastSuccessfulSyncAt ?? null);
      if (payload.today) {
        setCustomDate((prev) => (datePreset === "custom" ? prev : payload.today!));
      }
      if (!payload.connected && payload.error) {
        setStatusError(payload.error);
      }
    } catch (error) {
      setStatusError(
        error instanceof Error ? error.message : "Failed to read Gmail status."
      );
    } finally {
      setLoadingStatus(false);
    }
  }, [datePreset]);

  React.useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  React.useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const gmail = params.get("gmail");
    if (!gmail) return;
    if (gmail === "connected") {
      setBanner(
        "Gmail connected with OAuth2. Tokens stored encrypted — no password saved."
      );
      void refreshStatus();
    } else if (gmail === "error") {
      setBanner(
        `Gmail connection failed: ${params.get("reason") ?? "unknown_error"}`
      );
    }
    const url = new URL(window.location.href);
    url.searchParams.delete("gmail");
    url.searchParams.delete("reason");
    window.history.replaceState({}, "", url.pathname);
  }, [refreshStatus]);

  async function handleScan() {
    setScanning(true);
    setScanError(null);
    try {
      const params = new URLSearchParams(
        isIncremental
          ? { scanMode: "incremental" }
          : {
              date: resolvedDate,
              dateMode: datePreset,
              scanMode: "date",
            }
      );
      const response = await fetch(`/api/dataset/gmail/messages?${params}`);
      const payload = (await response.json()) as GmailScanResult & {
        error?: string;
      };
      if (!response.ok) {
        throw new Error(payload.error ?? "Failed to scan Gmail.");
      }
      setScan(payload);
      setConnected(true);
      setConnectedEmail(payload.connectedEmail);
      setLastSuccessfulSyncAt(payload.lastSuccessfulSyncAt);
      const windowLabel =
        payload.scanMode === "incremental"
          ? payload.lastSuccessfulSyncAt
            ? `after ${formatReceived(payload.lastSuccessfulSyncAt)}`
            : "since start of today (first run)"
          : payload.scanDate;
      setBanner(
        `Scanned ${windowLabel}: ${payload.messageCount} message(s), ${payload.rows.length} keyword match(es). Newest per dataset is highlighted.`
      );
      if (payload.warnings?.length) {
        setBanner(
          (prev) =>
            `${prev ?? ""} ${payload.warnings.join(" ")}`.trim()
        );
      }
    } catch (error) {
      setScanError(
        error instanceof Error ? error.message : "Failed to scan Gmail."
      );
    } finally {
      setScanning(false);
    }
  }

  async function handleSync(selectedRowIds?: string[]) {
    setSyncing(true);
    setScanError(null);
    try {
      const response = await fetch("/api/dataset/gmail/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          selectedRowIds?.length
            ? {
                selectedRowIds,
                single: true,
                scanMode: isIncremental ? "incremental" : "date",
                date: isIncremental ? undefined : resolvedDate,
                dateMode: isIncremental ? undefined : datePreset,
              }
            : isIncremental
              ? { scanMode: "incremental" }
              : {
                  scanMode: "date",
                  date: resolvedDate,
                  dateMode: datePreset,
                  single: true,
                }
        ),
      });
      const payload = (await response.json()) as DatasetSyncResult & {
        error?: string;
      };
      if (!response.ok) {
        throw new Error(payload.error ?? "Dataset sync failed.");
      }
      setSyncResult(payload);
      setBanner(
        `Sync complete · ${payload.uploadedCount ?? 0} uploaded to Drive · ${payload.failedCount} failed · existing datasets preserved on validation failure`
      );
      onSyncComplete?.();
      await refreshStatus();
      await handleScan();
    } catch (error) {
      setScanError(
        error instanceof Error ? error.message : "Dataset sync failed."
      );
    } finally {
      setSyncing(false);
      setRowBusyId(null);
    }
  }

  async function handleSelect(row: GmailExcelAttachmentRow) {
    if (!scan) return;
    const selectionKey =
      scan.scanMode === "incremental" && scan.afterMs != null
        ? `after:${scan.afterMs}`
        : scan.scanDate;
    setRowBusyId(row.id);
    setScanError(null);
    try {
      const response = await fetch("/api/dataset/gmail/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "select",
          datasetName: row.datasetName,
          rowId: row.id,
          date: selectionKey,
        }),
      });
      const payload = (await response.json()) as GmailScanResult & {
        error?: string;
        message?: string;
      };
      if (!response.ok) {
        throw new Error(payload.error ?? "Failed to select file.");
      }
      setScan(payload);
      setBanner(
        payload.message ??
          `Manual override: ${row.attachmentName} selected for ${row.datasetName}.`
      );
    } catch (error) {
      setScanError(
        error instanceof Error ? error.message : "Failed to select file."
      );
    } finally {
      setRowBusyId(null);
    }
  }

  async function handleDisconnect() {
    await fetch("/api/dataset/gmail/status", { method: "DELETE" });
    setConnected(false);
    setConnectedEmail(null);
    setScan(null);
    setSyncResult(null);
    setBanner("Gmail disconnected. OAuth tokens removed.");
  }

  const rows: GmailExcelAttachmentRow[] = scan?.rows ?? [];

  const headerActions = (
    <div className="flex flex-wrap gap-2">
          {connected ? (
            <>
              <Button
                type="button"
                variant="outline"
                className="rounded-xl gap-2"
                onClick={() => void handleScan()}
                disabled={scanning || syncing}
              >
                <RefreshCw
                  className={cn("size-4", scanning && "animate-spin")}
                />
                {scanning ? "Scanning…" : "Scan inbox"}
              </Button>
              <Button
                type="button"
                className="rounded-xl gap-2"
                onClick={() => void handleSync()}
                disabled={scanning || syncing}
              >
                <Download
                  className={cn("size-4", syncing && "animate-pulse")}
                />
                {syncing ? "Syncing…" : "Run sync"}
              </Button>
              <Button
                type="button"
                variant="outline"
                className="rounded-xl gap-2"
                onClick={() => void handleDisconnect()}
              >
                <Unplug className="size-4" />
                Disconnect
              </Button>
            </>
          ) : (
            <Button
              type="button"
              className="rounded-xl gap-2"
              disabled={!oauthConfigured || loadingStatus}
              onClick={() => {
                window.location.href = gmailOAuthStartHref(setupEmail);
              }}
            >
              <Link2 className="size-4" />
              Connect Gmail
            </Button>
          )}
        </div>
  );

  const body = (
    <div className="space-y-3">
        {embedded ? (
          <div className="mb-1 flex flex-wrap justify-end gap-2">{headerActions}</div>
        ) : null}

        {banner ? (
          <p className="rounded-xl border border-primary/30 bg-primary/5 px-3 py-2 text-sm text-foreground">
            {banner}
          </p>
        ) : null}

        {!oauthConfigured ? (
          <p className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm text-amber-800 dark:text-amber-200">
            Gmail OAuth is not configured yet. Add{" "}
            <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code>{" "}
            to <code>.env.local</code>, restart the app, then click{" "}
            <strong>Connect Gmail</strong> and sign in as the configured Gmail
            account. Redirect URI:{" "}
            <code>/api/dataset/gmail/oauth/callback</code>. Never store Gmail
            passwords.
          </p>
        ) : null}

        <div className="flex flex-wrap items-end gap-3 rounded-xl border border-border/70 bg-muted/20 px-3 py-3">
          <div className="space-y-1">
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Search window
            </p>
            <div className="flex flex-wrap gap-2">
              {(
                [
                  ["since_last_sync", "Since last sync"],
                  ["today", "Today"],
                  ["yesterday", "Yesterday"],
                  ["custom", "Custom Date"],
                ] as const
              ).map(([value, label]) => (
                <Button
                  key={value}
                  type="button"
                  size="sm"
                  variant={datePreset === value ? "default" : "outline"}
                  className="rounded-lg"
                  onClick={() => setDatePreset(value)}
                >
                  {label}
                </Button>
              ))}
            </div>
          </div>
          {datePreset === "custom" ? (
            <div className="space-y-1">
              <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                Custom
              </p>
              <Input
                type="date"
                value={customDate}
                onChange={(event) => setCustomDate(event.target.value)}
                className="h-8 w-44 rounded-lg"
              />
            </div>
          ) : null}
          <div className="space-y-0.5 pb-1 text-sm">
            <p className="text-muted-foreground">
              Last successful sync:{" "}
              <span className="font-medium text-foreground">
                {lastSuccessfulSyncAt
                  ? formatReceived(lastSuccessfulSyncAt)
                  : "— (first run uses start of today)"}
              </span>
            </p>
            <p className="text-xs text-muted-foreground">
              Active window:{" "}
              <span className="font-medium text-foreground">
                {isIncremental
                  ? "after last successful sync"
                  : resolvedDate}
              </span>
              {scan?.scanMode ? (
                <span className="ml-2">
                  (last scan: {scan.scanMode}
                  {scan.scanMode === "incremental" && scan.lastSuccessfulSyncAt
                    ? ` · ${formatReceived(scan.lastSuccessfulSyncAt)}`
                    : scan.scanMode === "date"
                      ? ` · ${scan.scanDate}`
                      : ""}
                  )
                </span>
              ) : null}
            </p>
          </div>
        </div>

        <div className="grid gap-2 rounded-xl border border-border/70 bg-muted/20 px-3 py-3 text-sm sm:grid-cols-2">
          <p>
            <span className="text-muted-foreground">Setup mailbox: </span>
            {setupEmail || "—"}
          </p>
          <p>
            <span className="text-muted-foreground">OAuth mailbox: </span>
            {loadingStatus
              ? "Checking…"
              : connected
                ? connectedEmail || "Connected"
                : "Not connected"}
          </p>
          {scan?.query ? (
            <div className="sm:col-span-2 space-y-1">
              <span className="text-muted-foreground">Search query: </span>
              <code className="text-xs">{scan.query}</code>
            </div>
          ) : null}
        </div>

        {statusError && !connected ? (
          <p className="text-sm text-muted-foreground">{statusError}</p>
        ) : null}
        {scanError ? (
          <p className="rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {scanError}
          </p>
        ) : null}

        <div className="overflow-x-auto rounded-xl border border-border">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/40 hover:bg-muted/40">
                <TableHead className="min-w-28">Dataset</TableHead>
                <TableHead className="min-w-48">Matched Email Subject</TableHead>
                <TableHead className="min-w-44">Matched Attachment</TableHead>
                <TableHead className="min-w-36">Matched Keywords</TableHead>
                <TableHead className="min-w-36">Received Time</TableHead>
                <TableHead className="min-w-40">Sender</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="min-w-56">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {!connected ? (
                <TableRow>
                  <TableCell
                    colSpan={8}
                    className="h-20 text-center text-sm text-muted-foreground"
                  >
                    Connect Gmail with OAuth2 to scan for Excel attachments.
                  </TableCell>
                </TableRow>
              ) : rows.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={8}
                    className="h-20 text-center text-sm text-muted-foreground"
                  >
                    {scan
                      ? "No keyword-matching Excel attachments found for this date."
                      : "Pick a date and click Scan inbox."}
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((row) => {
                  const isChosen =
                    row.status === "Newest" || row.status === "Selected";
                  return (
                    <TableRow
                      key={row.id}
                      className={cn(
                        isChosen && "bg-emerald-500/5"
                      )}
                    >
                      <TableCell className="font-medium text-foreground">
                        {row.datasetName}
                      </TableCell>
                      <TableCell className="font-medium text-foreground">
                        {row.subject}
                      </TableCell>
                      <TableCell>
                        <span className="block max-w-64 truncate text-sm">
                          {row.attachmentName}
                        </span>
                      </TableCell>
                      <TableCell className="text-sm">
                        {row.matchedKeyword ? (
                          <span>
                            <span className="font-medium text-foreground">
                              {row.matchedKeyword}
                            </span>
                            <span className="mt-0.5 block text-xs text-muted-foreground">
                              {[
                                row.matchedIn,
                                row.matchMode
                                  ? row.matchMode.replace("_", " ")
                                  : null,
                              ]
                                .filter(Boolean)
                                .join(" · ")}
                            </span>
                          </span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground tabular-nums">
                        {formatReceived(row.receivedAt)}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {row.sender}
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
                      <TableCell>
                        <div className="flex flex-wrap gap-1.5">
                          {!isChosen ? (
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              className="rounded-lg gap-1"
                              disabled={rowBusyId === row.id || scanning || syncing}
                              onClick={() => void handleSelect(row)}
                            >
                              <CheckCircle2 className="size-3" />
                              Use this
                            </Button>
                          ) : null}
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="rounded-lg gap-1"
                            disabled={rowBusyId === row.id || scanning || syncing}
                            onClick={() => {
                              setRowBusyId(row.id);
                              void handleSync([row.id]);
                            }}
                          >
                            <Download className="size-3" />
                            Download
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            className="rounded-lg gap-1"
                            disabled={rowBusyId === row.id || scanning || syncing}
                            onClick={() => {
                              setRowBusyId(row.id);
                              void handleSync([row.id]);
                            }}
                          >
                            <Upload className="size-3" />
                            Upload
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>

        {syncResult ? (
          <div className="space-y-2">
            <p className="text-sm font-medium text-foreground">
              Sync downloads · {syncResult.uploadedCount ?? 0} uploaded ·{" "}
              {syncResult.failedCount} failed ·{" "}
              {syncResult.preservedCurrentCount} existing preserved
            </p>
            <div className="overflow-x-auto rounded-xl border border-border">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/40 hover:bg-muted/40">
                    <TableHead>Dataset</TableHead>
                    <TableHead>Renamed file</TableHead>
                    <TableHead>Drive File ID</TableHead>
                    <TableHead>Upload Time</TableHead>
                    <TableHead className="text-right">Size</TableHead>
                    <TableHead className="text-right">Version</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Error</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {syncResult.items.map((item) => (
                    <TableRow
                      key={`${item.messageId}:${item.attachmentId}:${item.status}`}
                    >
                      <TableCell className="font-medium">
                        {item.datasetName ?? "—"}
                      </TableCell>
                      <TableCell>
                        <span className="block max-w-48 truncate text-sm">
                          {item.renamedFile ?? "—"}
                        </span>
                      </TableCell>
                      <TableCell>
                        <span className="block max-w-36 truncate font-mono text-xs text-muted-foreground">
                          {item.driveFileId ?? "—"}
                        </span>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                        {item.driveUploadTime
                          ? formatReceived(item.driveUploadTime)
                          : "—"}
                      </TableCell>
                      <TableCell className="text-right text-xs tabular-nums text-muted-foreground">
                        {item.driveFileSize != null
                          ? `${(item.driveFileSize / 1024).toFixed(1)} KB`
                          : "—"}
                      </TableCell>
                      <TableCell className="text-right text-xs tabular-nums text-muted-foreground">
                        {item.driveVersionNumber != null
                          ? `v${item.driveVersionNumber}`
                          : "—"}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant="secondary"
                          className={cn(
                            "rounded-md font-medium",
                            SYNC_STATUS_STYLES[item.status] ?? "bg-muted"
                          )}
                        >
                          {item.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="max-w-48 truncate text-xs text-destructive">
                        {item.error ?? ""}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        ) : null}

    </div>
  );

  if (embedded) return body;

  return (
    <Card className="mt-4 shadow-sm">
      <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-2 text-base">
            <span className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Inbox className="size-4" />
            </span>
            Gmail Excel attachments
          </CardTitle>
          <CardDescription>
            Scheduled and Run sync search emails received after the last
            successful sync. Keyword libraries assign files to Lateral,
            Executive, or Consulting. Newest match per dataset is selected
            automatically — override anytime.
          </CardDescription>
        </div>
        {headerActions}
      </CardHeader>
      <CardContent>{body}</CardContent>
    </Card>
  );
}
