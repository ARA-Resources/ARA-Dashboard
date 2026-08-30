"use client";

import * as React from "react";
import Link from "next/link";
import {
  AlertCircle,
  CheckCircle2,
  Database,
  Loader2,
  RefreshCw,
  Sheet,
} from "lucide-react";
import { FadeIn } from "@/animations/fade-in";
import { PageHeader } from "@/components/layouts/page-header";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { ROUTES } from "@/constants/routes";
import { cn } from "@/lib/utils";

type UiPhase =
  | "idle"
  | "finding"
  | "downloading"
  | "reading_base_ds"
  | "validating_columns"
  | "clearing_new_sheet"
  | "writing"
  | "verifying"
  | "complete"
  | "error"
  | "config_incomplete"
  | "fetching"
  | "success"
  | "skipped_duplicate"
  | "reconcile_dry_run";

interface StatusPayload {
  ok: boolean;
  oauthConfigured?: boolean;
  datasetImport?: {
    fetchReady: boolean;
    spreadsheetConfigured: boolean;
    spreadsheetIdMasked: string | null;
    attachmentPattern: string;
    sourceSheet: string;
    destinationSheet: string;
    missing: string[];
    notes: string[];
  };
  claims?: {
    masterSheetProcessed?: boolean;
    masterSheetLiveWriteEnabled?: boolean;
  };
  error?: string;
}

interface ReconcileDryRunResult {
  rowsProcessed?: number;
  newCount?: number;
  reopenCount?: number;
  activeCount?: number;
  closedCount?: number;
  unchangedCount?: number;
  postedYesCount?: number;
  postedDashCount?: number;
  newSheetRows?: number;
  masterSheetRows?: number;
  postedSheetRows?: number;
  blockers?: string[];
  notes?: string[];
  timestamp?: string;
}

const PHASE_LABEL: Record<string, string> = {
  idle: "Idle",
  finding: "Finding latest Exec DS",
  downloading: "Downloading workbook",
  reading_base_ds: "Reading Base DS",
  validating_columns: "Validating columns",
  clearing_new_sheet: "Clearing New Sheet",
  writing: "Writing new data",
  verifying: "Verifying import",
  complete: "Complete",
  error: "Error",
  config_incomplete: "Configuration incomplete",
  reconcile_dry_run: "Master dry-run",
};

export function ExecutiveDatasetIngestionPage() {
  const [status, setStatus] = React.useState<StatusPayload | null>(null);
  const [loadingStatus, setLoadingStatus] = React.useState(true);
  const [phase, setPhase] = React.useState<UiPhase>("idle");
  const [message, setMessage] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [lastResult, setLastResult] = React.useState<{
    sourceRowCount?: number;
    destinationRowCount?: number;
    attachmentName?: string;
    existingNewSheetUnchanged?: boolean;
  } | null>(null);
  const [reconcileResult, setReconcileResult] =
    React.useState<ReconcileDryRunResult | null>(null);

  const refreshStatus = React.useCallback(async () => {
    setLoadingStatus(true);
    try {
      const res = await fetch("/api/dataset/executive", {
        method: "GET",
        cache: "no-store",
      });
      const payload = (await res.json()) as StatusPayload;
      setStatus(payload);
      if (!payload.datasetImport?.fetchReady) {
        setPhase("config_incomplete");
      } else {
        setPhase((current) =>
          current === "complete" ||
          current === "error" ||
          current === "reconcile_dry_run"
            ? current
            : "idle"
        );
      }
    } catch (error) {
      setStatus({
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to load Executive dataset status.",
      });
      setPhase("error");
    } finally {
      setLoadingStatus(false);
    }
  }, []);

  React.useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  async function handleImportDataset() {
    setBusy(true);
    setPhase("finding");
    setMessage("Finding latest Exec DS…");
    setLastResult(null);
    try {
      const res = await fetch("/api/dataset/executive", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "import-dataset" }),
      });
      const payload = (await res.json()) as {
        ok?: boolean;
        phase?: UiPhase;
        message?: string;
        error?: string;
        result?: {
          sourceRowCount?: number;
          destinationRowCount?: number;
          attachmentName?: string;
          existingNewSheetUnchanged?: boolean;
        };
      };
      setPhase(payload.phase ?? (payload.ok ? "complete" : "error"));
      setMessage(
        payload.message ??
          payload.error ??
          (payload.ok
            ? "Executive dataset updated successfully."
            : "Executive dataset update did not complete.")
      );
      setLastResult(payload.result ?? null);
      await refreshStatus();
    } catch (error) {
      setPhase("error");
      setMessage(
        error instanceof Error
          ? error.message
          : "Executive dataset update did not complete."
      );
    } finally {
      setBusy(false);
    }
  }

  async function handleProcessMasterSheet() {
    setBusy(true);
    setPhase("reconcile_dry_run");
    setMessage("Running Executive Master Sheet dry-run reconciliation…");
    setReconcileResult(null);
    try {
      const res = await fetch("/api/dataset/executive", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "process-master-sheet" }),
      });
      const payload = (await res.json()) as {
        ok?: boolean;
        message?: string;
        error?: string;
        dryRun?: boolean;
        masterSheetWritePerformed?: boolean;
        result?: ReconcileDryRunResult;
      };
      setPhase(payload.ok ? "reconcile_dry_run" : "error");
      setMessage(
        payload.message ??
          payload.error ??
          "Master Sheet dry-run did not complete."
      );
      setReconcileResult(payload.result ?? null);
      await refreshStatus();
    } catch (error) {
      setPhase("error");
      setMessage(
        error instanceof Error
          ? error.message
          : "Master Sheet dry-run did not complete."
      );
    } finally {
      setBusy(false);
    }
  }

  const fetchReady = Boolean(status?.datasetImport?.fetchReady);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Executive Dataset"
        description="Phase 4B imports New Sheet. Phase 4C dry-runs Master Sheet reconciliation (no live write yet)."
        actions={
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              className="rounded-xl gap-2"
              onClick={() => void refreshStatus()}
              disabled={loadingStatus || busy}
            >
              <RefreshCw
                className={cn(
                  "size-4",
                  (loadingStatus || busy) && "animate-spin"
                )}
              />
              Refresh status
            </Button>
            <Link
              href={ROUTES.datasetConnectionsGmail}
              className={cn(
                buttonVariants({ variant: "outline" }),
                "rounded-xl"
              )}
            >
              Shared Gmail / Drive
            </Link>
          </div>
        }
      />

      <FadeIn>
        <Card className="rounded-2xl border-border/70">
          <CardHeader className="gap-2 border-b border-border pb-4">
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex size-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
                <Database className="size-5" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-foreground">
                  Fetch &amp; Update Executive Dataset
                </p>
                <p className="text-xs text-muted-foreground">
                  Finds the latest{" "}
                  <code className="text-[11px]">ATCI Exec DS_&lt;date&gt;.xlsx</code>
                  , reads <strong>Base DS</strong>, clears previous{" "}
                  <strong>New Sheet</strong> data (header kept), and writes a
                  fresh import.
                </p>
              </div>
              <Badge variant="secondary" className="rounded-md">
                {PHASE_LABEL[phase] ?? phase}
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-4 pt-4">
            <ol className="grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
              {[
                "Finding latest Exec DS",
                "Downloading workbook",
                "Reading Base DS",
                "Validating columns",
                "Clearing New Sheet",
                "Writing new data",
                "Verifying import",
                "Complete",
              ].map((step) => (
                <li key={step} className="rounded-md bg-muted/40 px-2 py-1">
                  {step}
                </li>
              ))}
            </ol>

            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                className="rounded-xl gap-2"
                onClick={() => void handleImportDataset()}
                disabled={!fetchReady || busy || !status?.oauthConfigured}
              >
                {busy && phase !== "reconcile_dry_run" ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Database className="size-4" />
                )}
                {busy && phase !== "reconcile_dry_run"
                  ? "Working…"
                  : "Fetch & Update Executive Dataset"}
              </Button>
              {!status?.oauthConfigured ? (
                <Badge variant="outline" className="rounded-md">
                  Connect Gmail first
                </Badge>
              ) : null}
            </div>

            {message && phase !== "reconcile_dry_run" ? (
              <div
                className={cn(
                  "flex items-start gap-2 rounded-xl border p-3 text-sm",
                  phase === "complete"
                    ? "border-primary/30 bg-primary/5 text-foreground"
                    : phase === "error" || phase === "config_incomplete"
                      ? "border-destructive/30 bg-destructive/5 text-destructive"
                      : "border-border bg-muted/30 text-muted-foreground"
                )}
              >
                {phase === "complete" ? (
                  <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
                ) : phase === "error" || phase === "config_incomplete" ? (
                  <AlertCircle className="mt-0.5 size-4 shrink-0" />
                ) : (
                  <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin" />
                )}
                <div className="space-y-1">
                  <p>{message}</p>
                  {phase === "complete" ? (
                    <p className="text-xs text-muted-foreground">
                      Dataset imported. Master Sheet was not modified — use
                      Process Executive Master Sheet next (dry-run).
                    </p>
                  ) : null}
                  {lastResult?.attachmentName ? (
                    <p className="text-xs text-muted-foreground">
                      File: {lastResult.attachmentName}
                      {typeof lastResult.sourceRowCount === "number"
                        ? ` · ${lastResult.sourceRowCount.toLocaleString()} rows`
                        : ""}
                    </p>
                  ) : null}
                </div>
              </div>
            ) : null}

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-xl border border-border/70 p-3">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Destination
                </p>
                <p className="mt-2 text-sm text-foreground">
                  {status?.datasetImport?.destinationSheet ?? "New Sheet"}
                </p>
                <p className="text-xs text-muted-foreground">
                  Spreadsheet:{" "}
                  {status?.datasetImport?.spreadsheetIdMasked ?? "—"}
                </p>
                <p className="text-xs text-muted-foreground">
                  Source sheet: {status?.datasetImport?.sourceSheet ?? "Base DS"}
                </p>
              </div>
              <div className="rounded-xl border border-border/70 p-3">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Readiness
                </p>
                <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                  <li>
                    Attachment pattern:{" "}
                    {status?.datasetImport?.attachmentPattern ??
                      "ATCI Exec DS_<date>.xlsx"}
                  </li>
                  <li>
                    Shared OAuth:{" "}
                    {status?.oauthConfigured ? "ready" : "not connected"}
                  </li>
                  <li>Import ready: {fetchReady ? "yes" : "no"}</li>
                </ul>
              </div>
            </div>
          </CardContent>
        </Card>
      </FadeIn>

      <FadeIn>
        <Card className="rounded-2xl border-border/70">
          <CardHeader className="gap-2 border-b border-border pb-4">
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex size-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
                <Sheet className="size-5" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-foreground">
                  Process Executive Master Sheet
                </p>
                <p className="text-xs text-muted-foreground">
                  Phase 4C dry-run: New Sheet + Master Sheet + Posted Sheet → Job
                  Status / Posted. Live Master Sheet write is disabled until
                  dry-run review.
                </p>
              </div>
              <Badge variant="outline" className="rounded-md">
                Dry-run only
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-4 pt-4">
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="secondary"
                className="rounded-xl gap-2"
                onClick={() => void handleProcessMasterSheet()}
                disabled={busy || !status?.oauthConfigured}
              >
                {busy && phase === "reconcile_dry_run" ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Sheet className="size-4" />
                )}
                {busy && phase === "reconcile_dry_run"
                  ? "Reconciling…"
                  : "Process Executive Master Sheet"}
              </Button>
              <Badge variant="outline" className="rounded-md">
                Live write:{" "}
                {status?.claims?.masterSheetLiveWriteEnabled ? "enabled" : "off"}
              </Badge>
            </div>

            {phase === "reconcile_dry_run" || reconcileResult ? (
              <div
                className={cn(
                  "rounded-xl border p-3 text-sm",
                  phase === "error"
                    ? "border-destructive/30 bg-destructive/5 text-destructive"
                    : "border-primary/30 bg-primary/5 text-foreground"
                )}
              >
                <p>{message}</p>
                {reconcileResult ? (
                  <ul className="mt-2 grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
                    <li>New Sheet rows: {reconcileResult.newSheetRows ?? "—"}</li>
                    <li>
                      Master Sheet rows: {reconcileResult.masterSheetRows ?? "—"}
                    </li>
                    <li>
                      Posted Sheet rows: {reconcileResult.postedSheetRows ?? "—"}
                    </li>
                    <li>New: {reconcileResult.newCount ?? "—"}</li>
                    <li>Reopen: {reconcileResult.reopenCount ?? "—"}</li>
                    <li>
                      Active (activated): {reconcileResult.activeCount ?? "—"}
                    </li>
                    <li>Closed: {reconcileResult.closedCount ?? "—"}</li>
                    <li>
                      Unchanged (sticky): {reconcileResult.unchangedCount ?? "—"}
                    </li>
                    <li>Posted Yes: {reconcileResult.postedYesCount ?? "—"}</li>
                    <li>Posted -: {reconcileResult.postedDashCount ?? "—"}</li>
                    <li>
                      Master write:{" "}
                      <strong className="text-foreground">NO</strong>
                    </li>
                  </ul>
                ) : null}
                {reconcileResult?.blockers?.length ? (
                  <p className="mt-2 text-xs text-destructive">
                    Blockers: {reconcileResult.blockers.join(" ")}
                  </p>
                ) : null}
              </div>
            ) : null}
          </CardContent>
        </Card>
      </FadeIn>
    </div>
  );
}
