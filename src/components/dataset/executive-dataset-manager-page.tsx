"use client";

import * as React from "react";
import Link from "next/link";
import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  RefreshCw,
  Zap,
} from "lucide-react";
import { FadeIn } from "@/animations/fade-in";
import { PageHeader } from "@/components/layouts/page-header";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { ExecutiveSchedulerPanel } from "@/components/dataset/executive-scheduler-panel";
import { ROUTES } from "@/constants/routes";
import { cn } from "@/lib/utils";
import type { DatasetSetupConfig } from "@/types/dataset-setup";

function ConfigMetaRow({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="grid gap-1 sm:grid-cols-[9rem_1fr] sm:items-start sm:gap-3">
      <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="break-all text-sm text-foreground">{value}</dd>
    </div>
  );
}

/**
 * Real Executive Dataset Manager page (Phase E8) — replaces the Phase
 * 4A/4B/4C placeholder (`executive-dataset-ingestion-page.tsx`, which called
 * the old XLSM/New-Sheet `/api/dataset/executive` route). Mirrors Lateral's
 * page layout: page-level "Run All" + a scheduler panel with its own Run
 * Now/Pause/Resume/Sync History, plus a read-only Configuration/Drive-folder
 * summary (Executive's row from the same generic `/api/dataset/setup` used
 * by every dataset). No live multi-stage progress panel — see
 * `ExecutiveProcessingStatusView`'s doc comment for why.
 *
 * The old placeholder page/component and the old `/api/dataset/executive`
 * route are left in place, not deleted — cleanup is Phase E7, done only
 * after this swap makes them genuinely unreferenced (traced and confirmed
 * before this phase started).
 */
export function ExecutiveDatasetManagerPage() {
  const [setup, setSetup] = React.useState<DatasetSetupConfig | null>(null);
  const [setupError, setSetupError] = React.useState<string | null>(null);
  const [runAllBusy, setRunAllBusy] = React.useState(false);
  const [runAllMessage, setRunAllMessage] = React.useState<string | null>(
    null
  );
  const [runAllOk, setRunAllOk] = React.useState<boolean | null>(null);
  const [refreshKey, setRefreshKey] = React.useState(0);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/dataset/setup", { cache: "no-store" });
        const payload = (await res.json().catch(() => null)) as {
          setup?: DatasetSetupConfig | null;
          error?: string;
        } | null;
        if (cancelled) return;
        if (!res.ok) {
          setSetupError(payload?.error ?? "Failed to load configuration.");
          return;
        }
        setSetup(payload?.setup ?? null);
      } catch (err) {
        if (!cancelled) {
          setSetupError(
            err instanceof Error ? err.message : "Failed to load configuration."
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  async function handleRunAll() {
    setRunAllBusy(true);
    setRunAllMessage(null);
    setRunAllOk(null);
    try {
      const res = await fetch("/api/dataset/executive/scheduler", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "run_now" }),
      });
      const payload = (await res.json().catch(() => null)) as {
        error?: string;
        outcome?: { status?: string; message?: string };
      } | null;
      if (!res.ok) {
        throw new Error(payload?.error ?? "Run All failed.");
      }
      setRunAllOk(payload?.outcome?.status === "success");
      setRunAllMessage(
        payload?.outcome?.message ?? "Executive Run All completed."
      );
    } catch (err) {
      setRunAllOk(false);
      setRunAllMessage(
        err instanceof Error ? err.message : "Executive Run All failed."
      );
    } finally {
      setRunAllBusy(false);
      setRefreshKey((k) => k + 1);
    }
  }

  const executiveConfig = setup?.datasets?.Executive;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Executive Dataset"
        description="Executive automation: Gmail → Download → Validate → Drive → executive_master reconcile → Posted refresh → Dashboard."
        actions={
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              className="rounded-xl gap-2"
              onClick={() => void handleRunAll()}
              disabled={runAllBusy}
            >
              {runAllBusy ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Zap className="size-4" />
              )}
              {runAllBusy ? "Running…" : "Run All"}
            </Button>
            <Button
              type="button"
              variant="outline"
              className="rounded-xl gap-2"
              onClick={() => setRefreshKey((k) => k + 1)}
              disabled={runAllBusy}
            >
              <RefreshCw className="size-4" />
              Refresh
            </Button>
            <Link
              href={ROUTES.datasetConnectionsGmail}
              className={cn(buttonVariants({ variant: "outline" }), "rounded-xl")}
            >
              Shared Gmail / Drive
            </Link>
          </div>
        }
      />

      {runAllMessage ? (
        <FadeIn>
          <div
            className={cn(
              "flex items-start gap-2 rounded-xl border p-3 text-sm",
              runAllOk
                ? "border-primary/30 bg-primary/5 text-foreground"
                : "border-destructive/30 bg-destructive/5 text-destructive"
            )}
          >
            {runAllOk ? (
              <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
            ) : (
              <AlertCircle className="mt-0.5 size-4 shrink-0" />
            )}
            <p>{runAllMessage}</p>
          </div>
        </FadeIn>
      ) : null}

      <FadeIn>
        <Card className="rounded-2xl border-border/70">
          <CardHeader className="gap-2 border-b border-border pb-4">
            <p className="text-sm font-semibold text-foreground">
              Scheduler &amp; Run History
            </p>
            <p className="text-xs text-muted-foreground">
              Executive&apos;s own advisory lock, checkpoint, and cron — fully
              independent of Lateral&apos;s.
            </p>
          </CardHeader>
          <CardContent className="pt-4">
            <ExecutiveSchedulerPanel key={refreshKey} />
          </CardContent>
        </Card>
      </FadeIn>

      <FadeIn>
        <Card className="rounded-2xl border-border/70">
          <CardHeader className="gap-2 border-b border-border pb-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-sm font-semibold text-foreground">
                  Configuration &amp; Drive Folder Mapping
                </p>
                <p className="text-xs text-muted-foreground">
                  Gmail keywords and Drive destination for the demand sheet
                  (shared Dataset setup — same store every dataset uses).
                </p>
              </div>
              <Badge variant="secondary" className="rounded-md">
                {executiveConfig?.enabled === false ? "Disabled" : "Enabled"}
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-3 pt-4">
            {setupError ? (
              <p className="rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {setupError}
              </p>
            ) : !setup ? (
              <p className="text-sm text-muted-foreground">
                Loading configuration…
              </p>
            ) : !executiveConfig ? (
              <p className="text-sm text-muted-foreground">
                Executive dataset is not configured yet. Configure it from
                Dataset setup.
              </p>
            ) : (
              <dl className="space-y-2 rounded-xl border border-border/70 bg-muted/20 px-3 py-3">
                <ConfigMetaRow
                  label="Search Keywords"
                  value={
                    (executiveConfig.keywords ?? []).length
                      ? [...executiveConfig.keywords]
                          .sort((a, b) => a.priority - b.priority)
                          .map(
                            (keyword) =>
                              `${keyword.value} [${keyword.matchMode}${
                                keyword.enabled ? "" : ", off"
                              }]`
                          )
                          .join(", ")
                      : "—"
                  }
                />
                <ConfigMetaRow
                  label="File Types"
                  value={
                    executiveConfig.fileTypes?.length
                      ? executiveConfig.fileTypes.map((t) => `.${t}`).join(", ")
                      : "—"
                  }
                />
                <ConfigMetaRow
                  label="Drive Folder"
                  value={
                    executiveConfig.driveFolder?.folderName ||
                    executiveConfig.driveFolder?.folderId ||
                    executiveConfig.driveFolder?.folderUrl ||
                    "—"
                  }
                />
                <ConfigMetaRow
                  label="Folder ID"
                  value={executiveConfig.driveFolder?.folderId || "—"}
                />
              </dl>
            )}
          </CardContent>
        </Card>
      </FadeIn>
    </div>
  );
}
