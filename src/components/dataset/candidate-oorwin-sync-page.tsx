"use client";

import * as React from "react";
import Link from "next/link";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Upload,
} from "lucide-react";
import { FadeIn } from "@/animations/fade-in";
import { PageHeader } from "@/components/layouts/page-header";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type CandidateSyncRunResultStatus = "success" | "partial" | "failed";

interface CandidateSyncRunResult {
  ok: boolean;
  result: CandidateSyncRunResultStatus;
  syncId: number | null;
  startedAt: string;
  finishedAt: string;
  sourceFilename: string;
  triggeredBy: string;
  counts: {
    rowsInSheet: number;
    inserted: number;
    updated: number;
    unchanged: number;
    quarantined: number;
    skippedBlankCid: number;
    reviewFlags: number;
  };
  failureReason: string | null;
}

interface UploadErrorResponse {
  ok: false;
  error: string;
}

const ACCEPTED_EXTENSIONS = [".xls", ".xlsx", ".xlsm"];

function isAcceptedFile(filename: string): boolean {
  const lower = filename.toLowerCase();
  return ACCEPTED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * Candidate Master Sheet — Oorwin sync upload UI (C8).
 *
 * The first literal file-upload UI in this app (no existing convention to
 * inherit beyond Card/Button/Input styling) — POSTs multipart/form-data to
 * /api/dataset/candidate/oorwin-sync (C7) and renders its result.
 *
 * Banner has three states, not two like Executive/Lateral's plain
 * success/failure Run All banner: 'partial' (quarantined duplicate-name
 * rows and/or review flags need human attention, but the sync itself
 * completed) gets its own amber "needs attention" treatment, reusing the
 * exact classes from lateral-master-sheet-page.tsx's Last Run All strip
 * (border-amber-500/25 bg-amber-500/5 container, text-amber-600
 * dark:text-amber-400 inline emphasis) rather than being lumped in with
 * either success or failure.
 */
export function CandidateOorwinSyncPage() {
  // Bumped after a successful run to remount (and thereby clear) the
  // uncontrolled file input — Input's props type doesn't expose a ref, so
  // a key-based remount is the reset mechanism here rather than imperative
  // `.value = ""` access.
  const [inputKey, setInputKey] = React.useState(0);
  const [selectedFile, setSelectedFile] = React.useState<File | null>(null);
  const [fileError, setFileError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [result, setResult] = React.useState<CandidateSyncRunResult | null>(null);
  const [requestError, setRequestError] = React.useState<string | null>(null);

  function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    setResult(null);
    setRequestError(null);
    if (file && !isAcceptedFile(file.name)) {
      setSelectedFile(null);
      setFileError("Unsupported file type. Expected .xls, .xlsx, or .xlsm.");
      return;
    }
    setFileError(null);
    setSelectedFile(file);
  }

  async function handleRunSync() {
    if (!selectedFile) return;
    setBusy(true);
    setResult(null);
    setRequestError(null);
    try {
      const formData = new FormData();
      formData.set("file", selectedFile);
      const res = await fetch("/api/dataset/candidate/oorwin-sync", {
        method: "POST",
        body: formData,
      });
      const payload = (await res.json().catch(() => null)) as
        | CandidateSyncRunResult
        | UploadErrorResponse
        | null;
      if (!res.ok || !payload || !("counts" in payload)) {
        throw new Error(
          (payload as UploadErrorResponse | null)?.error ??
            `Upload failed (HTTP ${res.status}).`
        );
      }
      setResult(payload);
      setSelectedFile(null);
      setInputKey((k) => k + 1);
    } catch (err) {
      setRequestError(
        err instanceof Error ? err.message : "Candidate sync failed."
      );
    } finally {
      setBusy(false);
    }
  }

  const bannerTone: "success" | "partial" | "failed" | null = requestError
    ? "failed"
    : result
      ? result.result
      : null;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Candidate Dataset"
        description="Upload an Oorwin Candidate Master Tracker export to sync candidate_master — inserts new candidates, updates changed fields, and flags duplicates/conflicts for review."
        actions={
          <Link
            href="/candidate/master-sheet"
            className={cn(buttonVariants({ variant: "outline" }), "rounded-xl")}
          >
            View Master Sheet
          </Link>
        }
      />

      {bannerTone ? (
        <FadeIn>
          <div
            className={cn(
              "flex items-start gap-2 rounded-xl border p-3 text-sm",
              bannerTone === "success"
                ? "border-primary/30 bg-primary/5 text-foreground"
                : bannerTone === "partial"
                  ? "border-amber-500/25 bg-amber-500/5 text-foreground"
                  : "border-destructive/30 bg-destructive/5 text-destructive"
            )}
            role="status"
          >
            {bannerTone === "success" ? (
              <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
            ) : bannerTone === "partial" ? (
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
            ) : (
              <AlertCircle className="mt-0.5 size-4 shrink-0" />
            )}
            <div className="space-y-1">
              {requestError ? (
                <p>{requestError}</p>
              ) : result ? (
                <>
                  <p className={bannerTone === "partial" ? "font-medium text-amber-600 dark:text-amber-400" : "font-medium"}>
                    {result.result === "success"
                      ? "Sync completed — no issues."
                      : result.result === "partial"
                        ? "Sync completed — some rows need review."
                        : "Sync failed."}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {result.sourceFilename} · {result.counts.rowsInSheet} row(s) in sheet ·{" "}
                    {result.counts.inserted} inserted · {result.counts.updated} updated ·{" "}
                    {result.counts.unchanged} unchanged · {result.counts.quarantined} quarantined ·{" "}
                    {result.counts.skippedBlankCid} skipped (blank CID) ·{" "}
                    {result.counts.reviewFlags} review flag(s)
                  </p>
                  {result.failureReason ? (
                    <p className="text-xs text-destructive/90">{result.failureReason}</p>
                  ) : null}
                </>
              ) : null}
            </div>
          </div>
        </FadeIn>
      ) : null}

      <FadeIn>
        <Card className="rounded-2xl border-border/70">
          <CardHeader className="gap-2 border-b border-border pb-4">
            <p className="text-sm font-semibold text-foreground">
              Upload Oorwin Export
            </p>
            <p className="text-xs text-muted-foreground">
              Accepts .xls, .xlsx, or .xlsm — the raw Oorwin &quot;Candidate
              Master Tracker&quot; export, unmodified.
            </p>
          </CardHeader>
          <CardContent className="space-y-3 pt-4">
            <Input
              key={inputKey}
              type="file"
              accept={ACCEPTED_EXTENSIONS.join(",")}
              onChange={handleFileChange}
              disabled={busy}
              className="h-auto py-1.5"
            />
            {fileError ? (
              <p className="text-xs text-destructive">{fileError}</p>
            ) : null}
            <Button
              type="button"
              className="rounded-xl gap-2"
              onClick={() => void handleRunSync()}
              disabled={busy || !selectedFile}
            >
              {busy ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Upload className="size-4" />
              )}
              {busy ? "Syncing…" : "Run Sync"}
            </Button>
          </CardContent>
        </Card>
      </FadeIn>
    </div>
  );
}
