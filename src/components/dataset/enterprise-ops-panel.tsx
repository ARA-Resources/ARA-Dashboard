"use client";

import * as React from "react";
import {
  Activity,
  AlertTriangle,
  Fingerprint,
  HardDrive,
  History,
  Filter,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
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
import type { DatasetSchedulerStatus } from "@/types/dataset-scheduler";
import { cn } from "@/lib/utils";

interface HealthPayload {
  ok?: boolean;
  live?: boolean;
  healthy?: boolean;
  checks?: Array<{ id: string; label: string; ok: boolean; detail: string }>;
  driveQuota?: {
    available: boolean;
    percentUsed: number | null;
    usageBytes: number | null;
    limitBytes: number | null;
    error?: string;
  };
  emailFiltering?: {
    independentSearches?: boolean;
    datasets?: Array<{
      datasetName: string;
      enabled?: boolean;
      searchKeywords?: string[];
      keywords?: Array<{
        value: string;
        enabled: boolean;
        priority: number;
        matchMode: string;
      }>;
      fileTypes?: string[];
      query?: string;
    }>;
    query: string;
  } | null;
  duplicateDetection?: {
    seenMessageCount: number;
    fingerprintCount: number;
  };
  checksumValidation?: { enabled: boolean; algorithm: string };
  failureEmailAlerts?: { configured: boolean };
  recentFailureCount?: number;
}

interface VersionRow {
  datasetName: string;
  fileName: string;
  size: number;
  updatedAt: string;
  checksumSha256: string | null;
}

interface EnterpriseOpsPanelProps {
  scheduler: DatasetSchedulerStatus | null;
  onSchedulerChange: (next: DatasetSchedulerStatus | null) => void;
  onDatasetsChanged?: () => void;
  /** When true, skip outer card chrome (used inside ManagerSection). */
  embedded?: boolean;
}

function formatBytes(bytes: number | null | undefined) {
  if (bytes == null || !Number.isFinite(bytes)) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export function EnterpriseOpsPanel({
  scheduler,
  onSchedulerChange,
  onDatasetsChanged,
  embedded = false,
}: EnterpriseOpsPanelProps) {
  const [health, setHealth] = React.useState<HealthPayload | null>(null);
  const [versions, setVersions] = React.useState<VersionRow[]>([]);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [message, setMessage] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    const [healthRes, opsRes] = await Promise.all([
      fetch("/api/health"),
      fetch("/api/dataset/ops"),
    ]);
    const healthPayload = (await healthRes.json().catch(() => null)) as
      | HealthPayload
      | null;
    const opsPayload = (await opsRes.json().catch(() => null)) as {
      versions?: VersionRow[];
    } | null;
    setHealth(healthPayload);
    setVersions(opsPayload?.versions ?? []);
  }, []);

  React.useEffect(() => {
    void load();
    const id = window.setInterval(() => {
      void load();
    }, 60_000);
    return () => window.clearInterval(id);
  }, [load]);

  async function runSchedulerAction(action: string) {
    setBusy(action);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch("/api/dataset/scheduler", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const payload = (await response.json()) as {
        scheduler?: DatasetSchedulerStatus;
        error?: string;
        outcome?: { message?: string };
      };
      if (!response.ok) throw new Error(payload.error ?? "Action failed.");
      onSchedulerChange(payload.scheduler ?? null);
      setMessage(
        payload.outcome?.message ??
          (action === "pause"
            ? "Scheduler paused."
            : action === "resume"
              ? "Scheduler resumed."
              : action === "run_now"
                ? "Manual sync completed."
                : "Scheduler updated.")
      );
      await load();
      onDatasetsChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed.");
    } finally {
      setBusy(null);
    }
  }

  async function retryAllFailed() {
    setBusy("retry_all");
    setError(null);
    setMessage(null);
    try {
      const response = await fetch("/api/dataset/ops", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "retry_all_failed" }),
      });
      const payload = (await response.json()) as {
        error?: string;
        retriedCount?: number;
      };
      if (!response.ok) throw new Error(payload.error ?? "Retry failed.");
      setMessage(`Retried ${payload.retriedCount ?? 0} failed upload(s).`);
      await load();
      onDatasetsChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Retry failed.");
    } finally {
      setBusy(null);
    }
  }

  async function rollback(version: VersionRow) {
    setBusy(`rollback:${version.fileName}`);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch("/api/dataset/ops", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "rollback",
          datasetName: version.datasetName,
          fileName: version.fileName,
        }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Rollback failed.");
      setMessage(`Rolled back ${version.datasetName} to ${version.fileName}.`);
      await load();
      onDatasetsChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Rollback failed.");
    } finally {
      setBusy(null);
    }
  }

  const quotaPct = health?.driveQuota?.percentUsed ?? null;

  const body = (
        <div className="space-y-5">
        {!embedded ? null : (
          <div className="flex justify-end">
            <Badge
              variant="secondary"
              className={cn(
                "rounded-md",
                health?.healthy
                  ? "bg-emerald-500/10 text-emerald-700"
                  : "bg-amber-500/10 text-amber-700"
              )}
            >
              {health?.healthy ? "Healthy" : "Needs attention"}
            </Badge>
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            className="rounded-xl gap-2"
            disabled={Boolean(busy) || Boolean(scheduler?.running)}
            onClick={() => {
              void runSchedulerAction("run_now");
            }}
          >
            <RefreshCw className="size-4" />
            Manual Sync
          </Button>
          {scheduler?.paused ? (
            <Button
              type="button"
              variant="outline"
              className="rounded-xl gap-2"
              disabled={Boolean(busy)}
              onClick={() => {
                void runSchedulerAction("resume");
              }}
            >
              <Play className="size-4" />
              Resume Scheduler
            </Button>
          ) : (
            <Button
              type="button"
              variant="outline"
              className="rounded-xl gap-2"
              disabled={Boolean(busy)}
              onClick={() => {
                void runSchedulerAction("pause");
              }}
            >
              <Pause className="size-4" />
              Pause Scheduler
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            className="rounded-xl gap-2"
            disabled={Boolean(busy)}
            onClick={() => {
              void retryAllFailed();
            }}
          >
            <RotateCcw className="size-4" />
            Retry failed uploads
          </Button>
        </div>

        {message ? (
          <p className="text-sm text-primary">{message}</p>
        ) : null}
        {error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : null}

        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <OpsMetric
            icon={<Activity className="size-4" />}
            label="Health checks"
            value={
              health?.checks?.length
                ? `${health.checks.filter((c) => c.ok).length}/${health.checks.length} ok`
                : health?.live || health?.ok
                  ? "Live"
                  : "—"
            }
          />
          <OpsMetric
            icon={<HardDrive className="size-4" />}
            label="Drive quota"
            value={
              quotaPct != null
                ? `${quotaPct.toFixed(1)}% used`
                : health?.driveQuota?.error ?? "—"
            }
            hint={
              health?.driveQuota?.available
                ? `${formatBytes(health.driveQuota.usageBytes)} / ${formatBytes(health.driveQuota.limitBytes)}`
                : undefined
            }
          />
          <OpsMetric
            icon={<Fingerprint className="size-4" />}
            label="Duplicate detection"
            value={
              health?.duplicateDetection
                ? `${health.duplicateDetection.fingerprintCount} fingerprints`
                : "Active"
            }
            hint={
              health?.duplicateDetection
                ? `${health.duplicateDetection.seenMessageCount} seen emails`
                : undefined
            }
          />
          <OpsMetric
            icon={<AlertTriangle className="size-4" />}
            label="Failure email"
            value={
              health?.failureEmailAlerts?.configured
                ? "SMTP configured"
                : "Not configured"
            }
            hint="Set ARA_ALERT_SMTP_* env vars"
          />
        </div>

        <div className="grid gap-3 lg:grid-cols-2">
          <div className="rounded-xl border border-border/70 bg-muted/20 px-3 py-3">
            <div className="mb-2 flex items-center gap-2 text-sm font-medium">
              <Filter className="size-4 text-primary" />
              Email filtering
            </div>
            <p className="text-xs text-muted-foreground">
              Date-scoped inbox scan; datasets assigned by keyword libraries
            </p>
            {health?.emailFiltering?.datasets?.length ? (
              <ul className="mt-2 space-y-2">
                {health.emailFiltering.datasets.map((item) => (
                  <li key={item.datasetName} className="text-xs">
                    <span className="font-medium text-foreground">
                      {item.datasetName}
                      {item.enabled === false ? " (off)" : ""}
                    </span>
                    <p className="mt-0.5 break-all font-mono text-[11px] text-muted-foreground">
                      {item.query ??
                        ((item.keywords ?? [])
                          .filter((k) => k.enabled)
                          .map((k) => k.value)
                          .join(" OR ") ||
                          item.searchKeywords?.join(" OR ") ||
                          "no keywords")}
                    </p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">
                {health?.emailFiltering?.query ??
                  "Configure per-dataset keywords in setup."}
              </p>
            )}
            <p className="mt-2 text-xs text-muted-foreground">
              Checksum validation:{" "}
              {health?.checksumValidation?.algorithm ?? "SHA-256"} on every
              download
            </p>
          </div>

          <div className="rounded-xl border border-border/70 bg-muted/20 px-3 py-3">
            <div className="mb-2 flex items-center gap-2 text-sm font-medium">
              <Activity className="size-4 text-primary" />
              Dashboard health monitor
            </div>
            <ul className="space-y-1.5">
              {(health?.checks ?? []).map((check) => (
                <li
                  key={check.id}
                  className="flex items-start justify-between gap-2 text-xs"
                >
                  <span className="text-muted-foreground">{check.label}</span>
                  <span
                    className={cn(
                      "text-right font-medium",
                      check.ok ? "text-emerald-700" : "text-amber-700"
                    )}
                  >
                    {check.detail}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div>
          <div className="mb-2 flex items-center gap-2 text-sm font-medium">
            <History className="size-4 text-primary" />
            Version history
          </div>
          {versions.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No versioned files yet. Enable “Keep version history” in Dataset
              setup, then sync.
            </p>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-border">
              <table className="w-full min-w-[40rem] text-left text-sm">
                <thead className="bg-muted/40 text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">Dataset</th>
                    <th className="px-3 py-2 font-medium">File</th>
                    <th className="px-3 py-2 font-medium">Updated</th>
                    <th className="px-3 py-2 font-medium">Checksum</th>
                    <th className="px-3 py-2 text-right font-medium">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {versions.slice(0, 12).map((version) => (
                    <tr
                      key={`${version.datasetName}:${version.fileName}`}
                      className="border-t border-border/70"
                    >
                      <td className="px-3 py-2 font-medium">
                        {version.datasetName}
                      </td>
                      <td className="px-3 py-2">
                        <span className="block max-w-56 truncate">
                          {version.fileName}
                        </span>
                      </td>
                      <td className="px-3 py-2 tabular-nums text-muted-foreground">
                        {new Date(version.updatedAt).toLocaleString("en-IN")}
                      </td>
                      <td className="px-3 py-2 font-mono text-[10px] text-muted-foreground">
                        {version.checksumSha256
                          ? `${version.checksumSha256.slice(0, 12)}…`
                          : "—"}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="rounded-lg gap-1.5"
                          disabled={Boolean(busy)}
                          onClick={() => {
                            void rollback(version);
                          }}
                        >
                          <RotateCcw className="size-3.5" />
                          Rollback
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        </div>
  );

  if (embedded) return body;

  return (
    <Card className="mb-4 shadow-sm">
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-2 text-base">
            <span className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <ShieldCheck className="size-4" />
            </span>
            Enterprise Ops
          </CardTitle>
          <CardDescription>
            Retry, checksums, dedupe, email filters, Drive quota, pause/resume,
            version rollback, failure email, and health.
          </CardDescription>
        </div>
        <Badge
          variant="secondary"
          className={cn(
            "rounded-md",
            health?.ok || health?.healthy
              ? "bg-emerald-500/10 text-emerald-700"
              : "bg-amber-500/10 text-amber-700"
          )}
        >
          {health?.ok || health?.healthy ? "Healthy" : "Needs attention"}
        </Badge>
      </CardHeader>
      <CardContent>{body}</CardContent>
    </Card>
  );
}

function OpsMetric({
  icon,
  label,
  value,
  hint,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="rounded-xl border border-border/70 bg-muted/20 px-3 py-3">
      <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        <span className="text-primary">{icon}</span>
        {label}
      </div>
      <p className="mt-1 text-sm font-semibold text-foreground">{value}</p>
      {hint ? (
        <p className="mt-0.5 text-[11px] text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}
