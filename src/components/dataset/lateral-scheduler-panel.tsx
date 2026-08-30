"use client";

import * as React from "react";
import {
  History,
  Pause,
  Play,
  RefreshCw,
  Settings2,
  Zap,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type {
  LateralProcessingStatusView,
  LateralSchedulerStatus,
} from "@/types/lateral-scheduler";
import type { LateralSyncHistoryEntry } from "@/types/lateral-sync-history";
import { apiFetch } from "@/lib/api/client";

type LateralStatusPayload = LateralSchedulerStatus & {
  processing?: LateralProcessingStatusView;
};

function StatusBadge({
  status,
}: {
  status: LateralProcessingStatusView["status"] | LateralSchedulerStatus["statusLabel"];
}) {
  const label = status === "Disabled" ? "Paused" : status;
  return (
    <Badge
      variant="secondary"
      className={cn(
        "rounded-md font-medium",
        label === "Active" &&
          "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
        label === "Paused" &&
          "bg-amber-500/10 text-amber-700 dark:text-amber-300"
      )}
    >
      {label}
    </Badge>
  );
}

function ConnectionBadge({ connected }: { connected: boolean }) {
  return (
    <Badge
      variant="secondary"
      className={cn(
        "rounded-md font-medium",
        connected
          ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
          : "bg-rose-500/10 text-rose-700 dark:text-rose-300"
      )}
    >
      {connected ? "Connected" : "Not Connected"}
    </Badge>
  );
}

function MetaRow({
  label,
  value,
  trailing,
}: {
  label: string;
  value: React.ReactNode;
  trailing?: React.ReactNode;
}) {
  return (
    <div className="grid gap-1 sm:grid-cols-[11rem_1fr] sm:items-start sm:gap-3">
      <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="flex flex-wrap items-center gap-2 break-all text-sm text-foreground">
        <span>{value}</span>
        {trailing}
      </dd>
    </div>
  );
}

function formatWhen(value: string | null | undefined, timeZone?: string) {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleString("en-IN", timeZone ? { timeZone } : undefined);
  } catch {
    return value;
  }
}

function ResultBadge({ result }: { result: string | null }) {
  if (!result) return <span>—</span>;
  const ok = result === "Success";
  return (
    <Badge
      variant="secondary"
      className={cn(
        "rounded-md font-medium",
        ok
          ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
          : "bg-rose-500/10 text-rose-700 dark:text-rose-300"
      )}
    >
      {result === "Partial" ? "Failed" : result}
    </Badge>
  );
}

export function LateralSchedulerPanel({
  onEditSetup,
}: {
  onEditSetup?: () => void;
}) {
  const [status, setStatus] = React.useState<LateralStatusPayload | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [info, setInfo] = React.useState<string | null>(null);
  const [showHistory, setShowHistory] = React.useState(false);
  const [history, setHistory] = React.useState<LateralSyncHistoryEntry[]>([]);
  const [historyBusy, setHistoryBusy] = React.useState(false);
  const [historyError, setHistoryError] = React.useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    const response = await fetch("/api/dataset/lateral/scheduler");
    const payload = (await response.json().catch(() => null)) as
      | LateralStatusPayload
      | { error?: string }
      | null;
    if (!response.ok) {
      throw new Error(
        (payload as { error?: string } | null)?.error ??
          "Failed to load Lateral status."
      );
    }
    setStatus(payload as LateralStatusPayload);
  }, []);

  const loadHistory = React.useCallback(async () => {
    setHistoryBusy(true);
    setHistoryError(null);
    try {
      // Stage 7: Node when NEXT_PUBLIC_ARA_API_BASE_URL is set; else Next.
      const response = await apiFetch(
        "/api/dataset/lateral/sync-history?limit=100"
      );
      const payload = (await response.json().catch(() => null)) as {
        entries?: LateralSyncHistoryEntry[];
        error?: string;
      } | null;
      if (!response.ok) {
        throw new Error(payload?.error ?? "Failed to load sync history.");
      }
      setHistory(payload?.entries ?? []);
    } catch (err) {
      setHistoryError(
        err instanceof Error ? err.message : "Failed to load sync history."
      );
    } finally {
      setHistoryBusy(false);
    }
  }, []);

  React.useEffect(() => {
    void refresh().catch((err) =>
      setError(err instanceof Error ? err.message : "Failed to load status.")
    );
  }, [refresh]);

  React.useEffect(() => {
    if (showHistory) {
      void loadHistory();
    }
  }, [showHistory, loadHistory]);

  async function runAction(
    action: "run_now" | "pause" | "resume" | "reload"
  ) {
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      const response = await fetch("/api/dataset/lateral/scheduler", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const payload = (await response.json().catch(() => null)) as {
        error?: string;
        status?: LateralStatusPayload;
        outcome?: { message?: string; status?: string };
      } | null;
      if (!response.ok) {
        throw new Error(payload?.error ?? `Action ${action} failed.`);
      }
      if (payload?.status) {
        setStatus(payload.status);
      } else {
        await refresh();
      }
      if (action === "run_now") {
        setInfo(payload?.outcome?.message ?? "Lateral job finished.");
        if (showHistory) void loadHistory();
      } else if (action === "pause") {
        setInfo("Lateral schedule paused.");
      } else if (action === "resume") {
        setInfo("Lateral schedule resumed.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Scheduler action failed.");
    } finally {
      setBusy(false);
    }
  }

  if (!status) {
    return (
      <div className="rounded-xl border border-border/70 bg-muted/20 px-3 py-3 text-sm text-muted-foreground">
        {error ?? "Loading Lateral processing status…"}
      </div>
    );
  }

  const processing = status.processing;
  const displayStatus =
    processing?.status ??
    (status.statusLabel === "Disabled" ? "Paused" : status.statusLabel);
  const gmailConnected = processing?.gmail.connected ?? false;
  const driveConnected = processing?.drive.connected ?? false;
  const syncTime = processing?.schedule.syncTime ?? status.syncTime;
  const timezone = processing?.schedule.timezone ?? status.timezone;
  const scheduleLabel =
    processing?.schedule.timeLabel ||
    status.timeLabel ||
    `Daily at ${syncTime}`;

  const lastResult =
    processing?.lastResult === "Partial"
      ? "Failed"
      : processing?.lastResult ??
        (status.lastRunStatus === "success"
          ? "Success"
          : status.lastRunStatus
            ? "Failed"
            : null);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-base font-semibold text-foreground">Lateral</p>
          <p className="text-xs text-muted-foreground">
            Processing status for Lateral Dataset automation.
          </p>
        </div>
        <StatusBadge status={displayStatus} />
      </div>

      <dl className="space-y-3 rounded-xl border border-border/70 bg-muted/20 px-3 py-3">
        <MetaRow
          label="Gmail"
          value={gmailConnected ? "Connected" : "Not Connected"}
          trailing={
            <>
              <ConnectionBadge connected={gmailConnected} />
              {processing?.gmail.email ? (
                <span className="text-xs text-muted-foreground">
                  {processing.gmail.email}
                </span>
              ) : null}
            </>
          }
        />
        <MetaRow
          label="Google Drive"
          value={driveConnected ? "Connected" : "Not Connected"}
          trailing={<ConnectionBadge connected={driveConnected} />}
        />
        <MetaRow label="Schedule" value={scheduleLabel} />
        <MetaRow
          label="Status"
          value={displayStatus === "Disabled" ? "Paused" : displayStatus}
          trailing={<StatusBadge status={displayStatus} />}
        />
        <MetaRow
          label="Last Successful Sync"
          value={formatWhen(processing?.lastSuccessfulSync, timezone)}
        />
        <MetaRow
          label="Last Processed File"
          value={processing?.lastProcessedFile || "—"}
        />
        <MetaRow
          label="Last Processed Email"
          value={processing?.lastProcessedEmail || "—"}
        />
        <MetaRow
          label="Last Result"
          value={<ResultBadge result={lastResult} />}
        />
        <MetaRow
          label="Next Scheduled Run"
          value={formatWhen(
            processing?.nextScheduledRun ?? status.nextRunAt,
            timezone
          )}
        />
        <MetaRow label="Time zone" value={timezone} />
      </dl>

      {status.lastRunMessage || processing?.lastRunMessage ? (
        <p className="text-xs text-muted-foreground">
          {processing?.lastRunMessage || status.lastRunMessage}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          className="rounded-xl gap-2"
          disabled={busy || status.running}
          onClick={() => void runAction("run_now")}
        >
          <Zap className="size-4" />
          {status.running ? "Running…" : "Run Now"}
        </Button>
        <Button
          type="button"
          variant="outline"
          className="rounded-xl gap-2"
          disabled={busy || !onEditSetup}
          onClick={() => onEditSetup?.()}
        >
          <Settings2 className="size-4" />
          Edit Setup
        </Button>
        <Button
          type="button"
          variant="outline"
          className="rounded-xl gap-2"
          disabled={busy}
          onClick={() => setShowHistory((open) => !open)}
        >
          <History className="size-4" />
          {showHistory ? "Hide Sync History" : "View Sync History"}
        </Button>
        <Button
          type="button"
          variant="outline"
          className="rounded-xl gap-2"
          disabled={busy}
          onClick={() =>
            void runAction(
              status.paused || !status.enabled ? "resume" : "pause"
            )
          }
        >
          {status.paused || !status.enabled ? (
            <>
              <Play className="size-4" />
              Resume
            </>
          ) : (
            <>
              <Pause className="size-4" />
              Pause
            </>
          )}
        </Button>
        <Button
          type="button"
          variant="ghost"
          className="rounded-xl gap-2"
          disabled={busy}
          onClick={() => void runAction("reload")}
        >
          <RefreshCw className="size-4" />
          Refresh
        </Button>
      </div>

      {showHistory ? (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-medium text-foreground">Sync History</p>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="rounded-lg"
              disabled={historyBusy}
              onClick={() => void loadHistory()}
            >
              Refresh history
            </Button>
          </div>
          {historyError ? (
            <p className="rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {historyError}
            </p>
          ) : null}
          <div className="overflow-x-auto rounded-xl border border-border/70">
            <table className="min-w-[64rem] w-full text-left text-xs">
              <thead className="bg-muted/40 text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Date/Time</th>
                  <th className="px-3 py-2 font-medium">Source Email</th>
                  <th className="px-3 py-2 font-medium">Original Filename</th>
                  <th className="px-3 py-2 font-medium">Google Drive File</th>
                  <th className="px-3 py-2 font-medium">Rows Imported</th>
                  <th className="px-3 py-2 font-medium">New</th>
                  <th className="px-3 py-2 font-medium">Active</th>
                  <th className="px-3 py-2 font-medium">Reopen</th>
                  <th className="px-3 py-2 font-medium">Closed</th>
                  <th className="px-3 py-2 font-medium">Result</th>
                  <th className="px-3 py-2 font-medium">Error</th>
                </tr>
              </thead>
              <tbody>
                {historyBusy && history.length === 0 ? (
                  <tr>
                    <td
                      colSpan={11}
                      className="px-3 py-4 text-muted-foreground"
                    >
                      Loading history…
                    </td>
                  </tr>
                ) : history.length === 0 ? (
                  <tr>
                    <td
                      colSpan={11}
                      className="px-3 py-4 text-muted-foreground"
                    >
                      No Lateral sync runs recorded yet.
                    </td>
                  </tr>
                ) : (
                  history.map((entry) => (
                    <tr
                      key={entry.id}
                      className="border-t border-border/60 align-top"
                    >
                      <td className="px-3 py-2 whitespace-nowrap">
                        {formatWhen(entry.syncTime, timezone)}
                      </td>
                      <td className="px-3 py-2 max-w-[14rem] break-words">
                        {entry.sourceEmail}
                      </td>
                      <td className="px-3 py-2 max-w-[12rem] break-words">
                        {entry.originalFilename}
                      </td>
                      <td className="px-3 py-2 max-w-[12rem] break-all font-mono text-[11px]">
                        {entry.googleDriveFileId}
                      </td>
                      <td className="px-3 py-2">{entry.rowsImported}</td>
                      <td className="px-3 py-2">{entry.newCount}</td>
                      <td className="px-3 py-2">{entry.activeCount}</td>
                      <td className="px-3 py-2">{entry.reopenCount}</td>
                      <td className="px-3 py-2">{entry.closedCount}</td>
                      <td className="px-3 py-2">
                        <ResultBadge result={entry.result} />
                      </td>
                      <td className="px-3 py-2 max-w-[16rem] break-words text-muted-foreground">
                        {entry.error || "—"}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {error ? (
        <p className="rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {info ? (
        <p className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300">
          {info}
        </p>
      ) : null}
    </div>
  );
}
