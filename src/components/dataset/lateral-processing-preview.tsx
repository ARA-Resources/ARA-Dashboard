"use client";

import * as React from "react";
import { AlertTriangle, CheckCircle2, Play, RefreshCw, RotateCcw, Save, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type {
  ColumnMapping,
  DataReadPreview,
  DataReadResult,
} from "@/services/lateral-processing/data-reader";
import type {
  ReconciliationDetailRow,
  ReconciliationReport,
} from "@/services/lateral-processing/master-reconcile";
import type { MacroExecutionResult } from "@/services/lateral-processing/run-vba-macro";
import type {
  LateralPipelineFailure,
  LateralPipelineSuccess,
} from "@/services/lateral-processing/pipeline";

// ─── types ───────────────────────────────────────────────────────────────────

interface ApiPayload {
  ok?: boolean;
  error?: string;
  result?: DataReadResult;
}

type PipelineApiResult = LateralPipelineSuccess | LateralPipelineFailure;

interface ExecuteResult {
  ok: boolean;
  phase?: string;
  error?: string;
  rolledBack?: boolean;
  message?: string;
  pendingSave?: boolean;
  stagingId?: string;
  report?: ReconciliationReport;
  missingDestinationHeaders?: string[];
  availableSourceHeaders?: string[];
  backupFileId?: string;
  backupFileName?: string;
  sourceRowsRead?: number;
  rowsWritten?: number;
  masterFileId?: string;
  masterFileName?: string;
  updatedAt?: string;
  columnMappings?: { destinationHeader: string; sourceHeader: string }[];
  unmatchedSourceHeaders?: string[];
  validationPassed?: boolean;
  newSheet?: {
    ok: boolean;
    backupFileName?: string;
    sourceRowsRead?: number;
    rowsWritten?: number;
    masterFileName?: string;
    validationPassed?: boolean;
    columnMappings?: { destinationHeader: string; sourceHeader: string }[];
    unmatchedSourceHeaders?: string[];
  };
  reconciliation?: {
    ok: boolean;
    pendingSave?: boolean;
    stagingId?: string;
    report?: ReconciliationReport;
    backupFileName?: string | null;
  };
}

// ─── small display helpers ────────────────────────────────────────────────────

function MetaRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="grid gap-1 sm:grid-cols-[11rem_1fr] sm:items-start sm:gap-2">
      <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="break-all text-sm text-foreground">{value}</dd>
    </div>
  );
}

function StatusBadge({ ok }: { ok: boolean }) {
  return ok ? (
    <Badge
      variant="secondary"
      className="rounded-md bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
    >
      <CheckCircle2 className="mr-1 size-3" />
      Mapped
    </Badge>
  ) : (
    <Badge
      variant="secondary"
      className="rounded-md bg-rose-500/10 text-rose-700 dark:text-rose-300"
    >
      <XCircle className="mr-1 size-3" />
      Missing
    </Badge>
  );
}

// ─── mapping failure view ─────────────────────────────────────────────────────

function MappingFailureView({
  missing,
  available,
}: {
  missing: string[];
  available: string[];
}) {
  return (
    <div className="space-y-4 rounded-xl border border-destructive/40 bg-destructive/5 p-4">
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 size-5 shrink-0 text-destructive" />
        <div>
          <p className="font-semibold text-destructive">Column mapping failed</p>
          <p className="mt-1 text-sm text-muted-foreground">
            The following New Sheet column
            {missing.length === 1 ? "" : "s"} could not be matched to any
            column in the source worksheet. New Sheet has not been modified.
          </p>
        </div>
      </div>

      <div className="space-y-1">
        <p className="text-sm font-medium text-destructive">
          Missing destination column{missing.length === 1 ? "" : "s"}:
        </p>
        <ul className="ml-4 list-disc space-y-0.5 text-sm text-destructive">
          {missing.map((col) => (
            <li key={col}>{col}</li>
          ))}
        </ul>
      </div>

      <div className="space-y-1">
        <p className="text-sm font-medium text-muted-foreground">
          Available source columns ({available.length}):
        </p>
        <p className="text-xs text-muted-foreground">{available.join(" · ")}</p>
      </div>
    </div>
  );
}

// ─── full preview view ────────────────────────────────────────────────────────

function PreviewView({ data }: { data: DataReadPreview }) {
  const [showAllMappings, setShowAllMappings] = React.useState(false);
  const visibleMappings: ColumnMapping[] = showAllMappings
    ? data.columnMappings
    : data.columnMappings.slice(0, 15);

  return (
    <div className="space-y-5">
      {/* ── Summary ─────────────────────────────────────────── */}
      <section className="space-y-2 rounded-xl border border-border/70 bg-muted/20 p-4">
        <p className="text-sm font-semibold text-foreground">Summary</p>
        <dl className="grid gap-2 sm:grid-cols-2">
          <MetaRow label="Source Workbook" value={data.sourceWorkbookName} />
          <MetaRow label="Source Worksheet" value={data.sourceWorksheetName} />
          <MetaRow
            label="Source Rows"
            value={
              <span className="tabular-nums">{data.source.rowCount.toLocaleString()}</span>
            }
          />
          <MetaRow
            label="Source Columns"
            value={
              <span className="tabular-nums">{data.source.colCount.toLocaleString()}</span>
            }
          />
          <MetaRow label="Destination Workbook" value={data.masterWorkbookName} />
          <MetaRow label="Destination Worksheet" value={data.masterNewSheetName} />
          <MetaRow
            label="Mapped Columns"
            value={
              <span className="tabular-nums font-medium text-emerald-700 dark:text-emerald-300">
                {data.columnMappings.length}
              </span>
            }
          />
          <MetaRow
            label="Unmatched Source Cols"
            value={
              data.unmatchedSourceHeaders.length === 0 ? (
                <span className="text-muted-foreground">None — all source columns mapped</span>
              ) : (
                <span className="text-amber-700 dark:text-amber-300">
                  {data.unmatchedSourceHeaders.length} ignored (not in New Sheet)
                </span>
              )
            }
          />
        </dl>
      </section>

      {/* ── Unmatched source columns (informational) ────────── */}
      {data.unmatchedSourceHeaders.length > 0 && (
        <section className="rounded-xl border border-amber-400/30 bg-amber-400/5 p-4">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
            <div>
              <p className="text-sm font-medium text-amber-800 dark:text-amber-200">
                Extra source columns — ignored
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                These columns exist in{" "}
                <span className="font-medium">{data.sourceWorksheetName}</span> but
                have no matching column in{" "}
                <span className="font-medium">{data.masterNewSheetName}</span>. They
                will not be copied.
              </p>
              <p className="mt-2 text-xs text-amber-800 dark:text-amber-200">
                {data.unmatchedSourceHeaders.join(" · ")}
              </p>
            </div>
          </div>
        </section>
      )}

      {/* ── Column mapping table ─────────────────────────────── */}
      <section className="space-y-2">
        <p className="text-sm font-semibold text-foreground">
          Column mapping ({data.columnMappings.length} columns)
        </p>
        <div className="overflow-x-auto rounded-xl border border-border">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/40 hover:bg-muted/40">
                <TableHead className="w-8">#</TableHead>
                <TableHead>New Sheet column (destination)</TableHead>
                <TableHead>ATCI DS column (source)</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibleMappings.map((m, i) => (
                <TableRow key={m.destinationHeader}>
                  <TableCell className="tabular-nums text-muted-foreground">
                    {i + 1}
                  </TableCell>
                  <TableCell className="font-medium">{m.destinationHeader}</TableCell>
                  <TableCell
                    className={cn(
                      m.generated || m.sourceHeader === m.destinationHeader
                        ? "text-muted-foreground"
                        : "text-amber-700 dark:text-amber-300"
                    )}
                  >
                    {m.sourceHeader}
                    {m.generated ? (
                      <span className="ml-1.5 text-[10px] text-muted-foreground">
                        (inserted on write)
                      </span>
                    ) : m.sourceHeader !== m.destinationHeader ? (
                      <span className="ml-1.5 text-[10px] text-muted-foreground">
                        (name differs)
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <StatusBadge ok />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        {data.columnMappings.length > 15 && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="rounded-lg"
            onClick={() => setShowAllMappings((s) => !s)}
          >
            {showAllMappings
              ? "Show fewer"
              : `Show all ${data.columnMappings.length} mappings`}
          </Button>
        )}
      </section>

      {/* ── Preview rows ─────────────────────────────────────── */}
      <section className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-semibold text-foreground">
            Data preview — first {data.previewMappedRows.length} row
            {data.previewMappedRows.length === 1 ? "" : "s"} after mapping
          </p>
          <Badge variant="secondary" className="rounded-md text-[10px]">
            Read-only · No data written
          </Badge>
        </div>
        {data.previewMappedRows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No data rows found in source worksheet.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-border">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/40 hover:bg-muted/40">
                  <TableHead className="w-8">#</TableHead>
                  {data.columnMappings.slice(0, 8).map((m) => (
                    <TableHead key={m.destinationHeader} className="min-w-32 max-w-48 truncate">
                      {m.destinationHeader}
                    </TableHead>
                  ))}
                  {data.columnMappings.length > 8 && (
                    <TableHead className="text-muted-foreground">
                      +{data.columnMappings.length - 8} more…
                    </TableHead>
                  )}
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.previewMappedRows.map((row, rowIdx) => (
                  <TableRow key={rowIdx}>
                    <TableCell className="tabular-nums text-muted-foreground">
                      {rowIdx + 1}
                    </TableCell>
                    {data.columnMappings.slice(0, 8).map((m) => (
                      <TableCell
                        key={m.destinationHeader}
                        className="max-w-48 truncate text-sm"
                        title={row[m.destinationHeader]}
                      >
                        {row[m.destinationHeader] || (
                          <span className="text-muted-foreground/50">—</span>
                        )}
                      </TableCell>
                    ))}
                    {data.columnMappings.length > 8 && <TableCell />}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          Showing first {data.previewMappedRows.length} of{" "}
          {data.source.rowCount.toLocaleString()} data rows. Columns displayed:{" "}
          {Math.min(8, data.columnMappings.length)} of {data.columnMappings.length}.
          No data has been written to any workbook.
        </p>
      </section>
    </div>
  );
}

// ─── reconciliation report ───────────────────────────────────────────────────

function ReconciliationReportView({
  report,
  backupFileName,
  pending,
  saving,
  cancelling,
  onConfirm,
  onCancel,
  decisionMessage,
  macroResult,
}: {
  report: ReconciliationReport;
  backupFileName?: string | null;
  pending: boolean;
  saving: boolean;
  cancelling: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  decisionMessage?: string | null;
  macroResult?: MacroExecutionResult | null;
}) {
  const { summary, details } = report;
  const changeDetails = details.filter(
    (row: ReconciliationDetailRow) => row.action !== "Unchanged"
  );
  const busy = saving || cancelling;

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-amber-400/40 bg-amber-400/5 p-4">
        <p className="text-sm font-semibold text-amber-900 dark:text-amber-100">
          Reconciliation report — Master Sheet not saved yet
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          Review the summary and detail table below. Choose{" "}
          <span className="font-medium">Confirm &amp; Save</span> to write
          Master Sheet Column K statuses (Active / Closed / Reopen / New) are applied by the
          Dataset backend. The old VBA status merger{" "}
          <span className="font-medium">UpdateJobRequisitionsStatusLateral</span>{" "}
          is not run after reconcile (it would overwrite Reopen and re-append New rows).
          Unrelated VBA (Teams / Skills / Aging / Posted) stays in the XLSM project.
          . Or choose{" "}
          <span className="font-medium">Cancel &amp; Rollback</span> to restore
          the previous Master Workbook version.
        </p>
      </div>

      <section className="space-y-3 rounded-xl border border-border/70 bg-muted/20 p-4">
        <p className="text-sm font-semibold tracking-wide text-foreground">
          RECONCILIATION SUMMARY
        </p>
        <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 text-sm">
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              New Requisitions
            </dt>
            <dd className="text-lg font-semibold tabular-nums">
              {summary.newRequisitions}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Reopened Requisitions
            </dt>
            <dd className="text-lg font-semibold tabular-nums">
              {summary.reopenedRequisitions}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Closed Requisitions
            </dt>
            <dd className="text-lg font-semibold tabular-nums">
              {summary.closedRequisitions}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Active (Column K)
            </dt>
            <dd className="text-lg font-semibold tabular-nums">
              {summary.activeUnchanged}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Total New Sheet Requisitions
            </dt>
            <dd className="text-lg font-semibold tabular-nums">
              {summary.totalNewSheetRequisitions}
            </dd>
          </div>
        </dl>
        {backupFileName ? (
          <p className="text-xs text-muted-foreground">
            Backup available: {backupFileName}
          </p>
        ) : null}
      </section>

      <section className="space-y-2">
        <p className="text-sm font-semibold tracking-wide text-foreground">
          DETAIL TABLE
        </p>
        <div className="overflow-x-auto rounded-xl border border-border">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/40 hover:bg-muted/40">
                <TableHead>Job Requisition ID</TableHead>
                <TableHead>Previous Status</TableHead>
                <TableHead>New Status</TableHead>
                <TableHead>Previous Date</TableHead>
                <TableHead>New Date</TableHead>
                <TableHead>Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {changeDetails.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={6}
                    className="text-center text-sm text-muted-foreground"
                  >
                    No status changes required.
                  </TableCell>
                </TableRow>
              ) : (
                changeDetails.map((row: ReconciliationDetailRow) => (
                  <TableRow key={`${row.jobRequisitionId}-${row.action}`}>
                    <TableCell className="font-medium font-mono text-xs">
                      {row.jobRequisitionId}
                    </TableCell>
                    <TableCell>{row.previousStatus}</TableCell>
                    <TableCell>{row.newStatus}</TableCell>
                    <TableCell className="tabular-nums text-muted-foreground">
                      {row.previousDate}
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {row.newDate}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant="secondary"
                        className={cn(
                          "rounded-md",
                          row.action === "Added" &&
                            "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
                          row.action === "Activated" &&
                            "bg-sky-500/10 text-sky-700 dark:text-sky-300",
                          row.action === "Reopened" &&
                            "bg-amber-500/10 text-amber-700 dark:text-amber-300",
                          row.action === "Closed" &&
                            "bg-rose-500/10 text-rose-700 dark:text-rose-300",
                          row.action === "Unchanged" &&
                            "bg-muted text-muted-foreground"
                        )}
                      >
                        {row.action}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
        <p className="text-xs text-muted-foreground">
          {changeDetails.length.toLocaleString()} change
          {changeDetails.length === 1 ? "" : "s"} listed.
        </p>
      </section>

      {pending ? (
        <div className="flex flex-wrap gap-2 rounded-xl border border-border/70 bg-background px-4 py-3">
          <Button
            type="button"
            className="rounded-xl gap-2"
            disabled={busy}
            onClick={onConfirm}
          >
            {saving ? (
              <RefreshCw className="size-4 animate-spin" />
            ) : (
              <Save className="size-4" />
            )}
            {saving ? "Saving (status-safe)…" : "Confirm & Save"}
          </Button>
          <Button
            type="button"
            variant="outline"
            className="rounded-xl gap-2 text-destructive hover:text-destructive"
            disabled={busy}
            onClick={onCancel}
          >
            {cancelling ? (
              <RefreshCw className="size-4 animate-spin" />
            ) : (
              <RotateCcw className="size-4" />
            )}
            {cancelling ? "Rolling back…" : "Cancel & Rollback"}
          </Button>
        </div>
      ) : null}

      {decisionMessage ? (
        <p className="rounded-xl border border-border/70 bg-muted/20 px-3 py-2 text-sm">
          {decisionMessage}
        </p>
      ) : null}

      {macroResult ? <MacroExecutionView macro={macroResult} /> : null}
    </div>
  );
}

function MacroExecutionView({ macro }: { macro: MacroExecutionResult }) {
  const ok = macro.ok;
  const superseded = macro.result === "skipped_superseded";
  return (
    <div
      className={cn(
        "space-y-2 rounded-xl border p-4",
        ok
          ? "border-emerald-400/40 bg-emerald-400/5"
          : "border-destructive/40 bg-destructive/5"
      )}
    >
      <p
        className={cn(
          "text-sm font-semibold",
          ok
            ? "text-emerald-800 dark:text-emerald-200"
            : "text-destructive"
        )}
      >
        {superseded
          ? `Status VBA gated: ${macro.macroName}`
          : `VBA Macro: ${macro.macroName}`}
      </p>
      <dl className="grid gap-2 sm:grid-cols-2 text-sm">
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Result
          </dt>
          <dd className="font-medium capitalize">
            {superseded ? "skipped (Dataset owns status)" : macro.result}
          </dd>
        </div>
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Duration
          </dt>
          <dd className="tabular-nums">{macro.durationMs} ms</dd>
        </div>
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Start Time
          </dt>
          <dd className="text-xs">
            {new Date(macro.startTime).toLocaleString("en-IN")}
          </dd>
        </div>
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            End Time
          </dt>
          <dd className="text-xs">
            {new Date(macro.endTime).toLocaleString("en-IN")}
          </dd>
        </div>
        {macro.excelVersion ? (
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Excel Version
            </dt>
            <dd>{macro.excelVersion}</dd>
          </div>
        ) : null}
        {macro.statusLogicOwner ? (
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Status owner
            </dt>
            <dd>{macro.statusLogicOwner}</dd>
          </div>
        ) : null}
      </dl>
      {macro.neutralizationNote ? (
        <p className="text-xs text-muted-foreground">{macro.neutralizationNote}</p>
      ) : null}
      {macro.errorMessage ? (
        <p className="text-sm text-destructive">{macro.errorMessage}</p>
      ) : null}
      {!ok ? (
        <p className="text-xs text-destructive">
          Synchronization is not successful because status-safe finalize did not complete.
        </p>
      ) : null}
    </div>
  );
}

// ─── execute result view ─────────────────────────────────────────────────────

function ExecuteResultView({
  result,
  pending,
  saving,
  cancelling,
  onConfirm,
  onCancel,
  decisionMessage,
  macroResult,
}: {
  result: ExecuteResult;
  pending: boolean;
  saving: boolean;
  cancelling: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  decisionMessage?: string | null;
  macroResult?: MacroExecutionResult | null;
}) {
  const newSheet = result.newSheet;
  const report =
    result.report ?? result.reconciliation?.report ?? null;
  const backupFileName =
    result.reconciliation?.backupFileName ?? result.backupFileName;

  if (!result.ok) {
    const isReconcileFail = result.phase === "reconciliation";
    return (
      <div className="space-y-3">
        {newSheet?.ok ? (
          <div className="rounded-xl border border-emerald-400/30 bg-emerald-400/5 px-4 py-3 text-sm">
            <p className="font-medium text-emerald-800 dark:text-emerald-200">
              New Sheet was updated successfully ({newSheet.rowsWritten ?? 0}{" "}
              rows) before reconciliation stopped.
            </p>
          </div>
        ) : null}

        <div className="space-y-3 rounded-xl border border-destructive/40 bg-destructive/5 p-4">
          <div className="flex items-start gap-3">
            <XCircle className="mt-0.5 size-5 shrink-0 text-destructive" />
            <div className="space-y-1">
              <p className="font-semibold text-destructive">
                {isReconcileFail
                  ? "Master Sheet reconciliation failed"
                  : "New Sheet update failed"}
                {result.rolledBack ? " — no Master changes saved" : ""}
              </p>
              <p className="text-sm text-muted-foreground">
                Phase:{" "}
                <span className="font-medium text-foreground">
                  {result.phase ?? "unknown"}
                </span>
              </p>
              <p className="text-sm text-destructive">{result.error}</p>
            </div>
          </div>

          {result.missingDestinationHeaders &&
            result.missingDestinationHeaders.length > 0 && (
              <div className="space-y-1">
                <p className="text-sm font-medium text-destructive">
                  Missing New Sheet columns:
                </p>
                <ul className="ml-4 list-disc text-sm text-destructive">
                  {result.missingDestinationHeaders.map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                </ul>
              </div>
            )}
        </div>
      </div>
    );
  }

  const rowsWritten = newSheet?.rowsWritten ?? result.rowsWritten;
  const sourceRows = newSheet?.sourceRowsRead ?? result.sourceRowsRead;
  const masterName = result.masterFileName ?? newSheet?.masterFileName;
  const newSheetBackup = newSheet?.backupFileName ?? result.backupFileName;

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3 rounded-xl border border-emerald-400/40 bg-emerald-400/5 p-4">
        <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-emerald-600 dark:text-emerald-400" />
        <div>
          <p className="font-semibold text-emerald-800 dark:text-emerald-200">
            {pending
              ? "New Sheet updated — review reconciliation before saving"
              : "Processing complete"}
          </p>
          {result.message ? (
            <p className="mt-1 text-sm text-muted-foreground">{result.message}</p>
          ) : null}
        </div>
      </div>

      <div className="space-y-2 rounded-xl border border-border/70 bg-muted/20 p-4">
        <p className="text-sm font-semibold">New Sheet write</p>
        <dl className="grid gap-2 sm:grid-cols-2 text-sm">
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Source rows read
            </dt>
            <dd className="tabular-nums">{sourceRows?.toLocaleString() ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Rows written to New Sheet
            </dt>
            <dd className="tabular-nums font-medium text-emerald-700 dark:text-emerald-300">
              {rowsWritten?.toLocaleString() ?? "—"}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Master workbook
            </dt>
            <dd className="break-all">{masterName ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              New Sheet backup
            </dt>
            <dd className="break-all text-xs">{newSheetBackup ?? "—"}</dd>
          </div>
        </dl>
      </div>

      {report ? (
        <ReconciliationReportView
          report={report}
          backupFileName={backupFileName}
          pending={pending}
          saving={saving}
          cancelling={cancelling}
          onConfirm={onConfirm}
          onCancel={onCancel}
          decisionMessage={decisionMessage}
          macroResult={macroResult}
        />
      ) : null}
    </div>
  );
}

// ─── main exported component ──────────────────────────────────────────────────

function PipelineSuccessView({ result }: { result: LateralPipelineSuccess }) {
  const rows: Array<{ label: string; value: string | number }> = [
    { label: "Source File", value: result.sourceFile },
    { label: "Source Sheet", value: result.sourceSheet },
    { label: "Rows Imported", value: result.rowsImported },
    { label: "New Requisitions", value: result.newRequisitions },
    { label: "Reopened Requisitions", value: result.reopenedRequisitions },
    { label: "Closed Requisitions", value: result.closedRequisitions },
    { label: "Active (Column K)", value: result.activeUnchanged },
    { label: "Macro Status", value: result.macroStatus },
    { label: "Final Master Sheet", value: result.finalMasterSheet },
    { label: "Last Updated", value: result.lastUpdated },
  ];
  return (
    <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-4 space-y-3">
      <div className="flex items-start gap-2">
        <CheckCircle2 className="size-5 shrink-0 text-emerald-600 dark:text-emerald-400" />
        <div>
          <p className="text-sm font-semibold text-emerald-800 dark:text-emerald-200">
            {result.message}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            All 23 pipeline steps completed successfully.
          </p>
        </div>
      </div>
      <dl className="grid gap-2 sm:grid-cols-2">
        {rows.map((row) => (
          <div
            key={row.label}
            className="rounded-lg border border-border/50 bg-background/60 px-3 py-2"
          >
            <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">
              {row.label}
            </dt>
            <dd className="mt-0.5 text-sm font-medium text-foreground break-all">
              {row.value}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function PipelineFailureView({ result }: { result: LateralPipelineFailure }) {
  return (
    <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 space-y-3">
      <div className="flex items-start gap-2">
        <XCircle className="size-5 shrink-0 text-destructive" />
        <div>
          <p className="text-sm font-semibold text-destructive">
            Lateral Dataset Sync Failed
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Pipeline stopped. Previous working Master Workbook was preserved.
          </p>
        </div>
      </div>
      <dl className="space-y-2 text-sm">
        <div>
          <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">
            Failed Step
          </dt>
          <dd className="font-medium text-foreground">
            Step {result.failedStep}: {result.failedStepName}
          </dd>
        </div>
        <div>
          <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">
            Reason
          </dt>
          <dd className="text-destructive">{result.reason}</dd>
        </div>
        <div>
          <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">
            Timestamp
          </dt>
          <dd className="text-foreground">{result.timestamp}</dd>
        </div>
        <div>
          <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">
            Suggested Action
          </dt>
          <dd className="text-foreground">{result.suggestedAction}</dd>
        </div>
        {result.errorLogPath ? (
          <div>
            <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">
              Error Log
            </dt>
            <dd className="text-xs text-muted-foreground break-all">
              {result.errorLogPath}
            </dd>
          </div>
        ) : null}
      </dl>
    </div>
  );
}

export function LateralProcessingPreview() {
  const [previewStatus, setPreviewStatus] = React.useState<
    "idle" | "loading" | "success" | "error"
  >("idle");
  const [previewResult, setPreviewResult] = React.useState<DataReadResult | null>(null);
  const [previewError, setPreviewError] = React.useState<string | null>(null);

  const [pipelineStatus, setPipelineStatus] = React.useState<
    "idle" | "running" | "success" | "error"
  >("idle");
  const [pipelineResult, setPipelineResult] =
    React.useState<PipelineApiResult | null>(null);
  const [pipelineConfirm, setPipelineConfirm] = React.useState(false);

  const [execStatus, setExecStatus] = React.useState<
    "idle" | "running" | "pending_save" | "done" | "error"
  >("idle");
  const [execResult, setExecResult] = React.useState<ExecuteResult | null>(null);
  const [execError, setExecError] = React.useState<string | null>(null);
  const [confirmPending, setConfirmPending] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [cancelling, setCancelling] = React.useState(false);
  const [decisionMessage, setDecisionMessage] = React.useState<string | null>(
    null
  );
  const [macroResult, setMacroResult] =
    React.useState<MacroExecutionResult | null>(null);

  const loadPreview = React.useCallback(async () => {
    setPreviewStatus("loading");
    setPreviewResult(null);
    setPreviewError(null);
    setPipelineStatus("idle");
    setPipelineResult(null);
    setPipelineConfirm(false);
    setExecStatus("idle");
    setExecResult(null);
    setExecError(null);
    setConfirmPending(false);
    setSaving(false);
    setCancelling(false);
    setDecisionMessage(null);
    setMacroResult(null);
    try {
      const res = await fetch("/api/dataset/lateral-processing/preview");
      const payload = (await res.json().catch(() => null)) as ApiPayload | null;
      if (!res.ok || !payload?.result) {
        throw new Error(payload?.error ?? "Failed to load preview data.");
      }
      setPreviewResult(payload.result);
      setPreviewStatus("success");
    } catch (err) {
      setPreviewError(
        err instanceof Error ? err.message : "Failed to load preview data."
      );
      setPreviewStatus("error");
    }
  }, []);

  const runPipeline = React.useCallback(async () => {
    setPipelineConfirm(false);
    setPipelineStatus("running");
    setPipelineResult(null);
    setExecStatus("idle");
    setExecResult(null);
    setExecError(null);
    setDecisionMessage(null);
    setMacroResult(null);
    try {
      const res = await fetch("/api/dataset/lateral-processing/pipeline", {
        method: "POST",
      });
      const payload = (await res.json().catch(() => null)) as PipelineApiResult | null;
      if (!payload) throw new Error("No response from pipeline.");
      setPipelineResult(payload);
      setPipelineStatus(payload.ok ? "success" : "error");
    } catch (err) {
      const timestamp = new Date().toISOString();
      setPipelineResult({
        ok: false,
        failedStep: 0,
        failedStepName: "Pipeline",
        reason:
          err instanceof Error ? err.message : "Failed to run Lateral pipeline.",
        timestamp,
        suggestedAction: "Check server connectivity and re-run the pipeline.",
        errorLogPath: "",
        steps: [],
        previousMasterPreserved: true,
        failureCode: "UNKNOWN_FAILURE",
        failureStage: "pipeline",
        checkpointAdvanced: false,
        reportedSuccess: false,
        retryable: true,
      });
      setPipelineStatus("error");
    }
  }, []);

  const executeUpdate = React.useCallback(async () => {
    setConfirmPending(false);
    setExecStatus("running");
    setExecResult(null);
    setExecError(null);
    setDecisionMessage(null);
    setMacroResult(null);
    try {
      const res = await fetch("/api/dataset/lateral-processing/execute", {
        method: "POST",
      });
      const payload = (await res.json().catch(() => null)) as ExecuteResult | null;
      if (!payload) throw new Error("No response from server.");
      setExecResult(payload);
      if (!payload.ok) {
        setExecStatus("error");
      } else if (payload.pendingSave || payload.report) {
        setExecStatus("pending_save");
      } else {
        setExecStatus("done");
      }
    } catch (err) {
      setExecError(
        err instanceof Error ? err.message : "Failed to execute New Sheet update."
      );
      setExecStatus("error");
    }
  }, []);

  const confirmSave = React.useCallback(async () => {
    setSaving(true);
    setDecisionMessage(null);
    setMacroResult(null);
    try {
      const res = await fetch(
        "/api/dataset/lateral-processing/reconcile/confirm",
        { method: "POST" }
      );
      const payload = (await res.json().catch(() => null)) as {
        ok?: boolean;
        error?: string;
        message?: string;
        phase?: string;
        macro?: MacroExecutionResult;
      } | null;

      if (payload?.macro) {
        setMacroResult(payload.macro);
      }

      if (!res.ok || !payload?.ok) {
        setExecStatus("error");
        throw new Error(
          payload?.message ||
            payload?.error ||
            "Failed to save reconciled Master Sheet / status-safe VBA finalize."
        );
      }
      setDecisionMessage(
        payload.message ??
          "Reconciled Master Workbook saved. Dataset owns Job Status (Column K); conflicting VBA status logic was not run."
      );
      setExecStatus("done");
    } catch (err) {
      setDecisionMessage(
        err instanceof Error ? err.message : "Failed to confirm save."
      );
      setExecStatus("error");
    } finally {
      setSaving(false);
    }
  }, []);

  const cancelRollback = React.useCallback(async () => {
    setCancelling(true);
    setDecisionMessage(null);
    try {
      const res = await fetch(
        "/api/dataset/lateral-processing/reconcile/cancel",
        { method: "POST" }
      );
      const payload = (await res.json().catch(() => null)) as {
        ok?: boolean;
        error?: string;
        message?: string;
      } | null;
      if (!res.ok || !payload?.ok) {
        throw new Error(payload?.error ?? "Failed to cancel and rollback.");
      }
      setDecisionMessage(
        payload.message ??
          "Cancelled. Previous Master Workbook version restored."
      );
      setExecStatus("done");
    } catch (err) {
      setDecisionMessage(
        err instanceof Error ? err.message : "Failed to cancel and rollback."
      );
    } finally {
      setCancelling(false);
    }
  }, []);

  // Can only execute if preview loaded successfully and mapping passed
  const previewOk =
    previewStatus === "success" && previewResult?.ok === true;
  const busy =
    pipelineStatus === "running" ||
    execStatus === "running" ||
    execStatus === "pending_save" ||
    saving ||
    cancelling;

  return (
    <div className="space-y-4">
      {/* ── Full pipeline ──────────────────────────────────────────── */}
      <div className="rounded-xl border border-primary/25 bg-primary/5 p-4 space-y-3">
        <div>
          <p className="text-sm font-semibold text-foreground">
            Lateral Dataset Processing Pipeline
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Runs all 23 steps in order: latest source Excel → New Sheet → Job
            Req reconciliation (Dataset Column K status) → status-safe VBA
            finalize → Drive destination → Dataset Manager. Stops on first
            failure and preserves the previous Master.
          </p>
        </div>

        {pipelineStatus === "idle" && !pipelineConfirm && (
          <Button
            type="button"
            className="rounded-xl gap-2"
            onClick={() => setPipelineConfirm(true)}
            disabled={busy}
          >
            <Play className="size-4" />
            Run Lateral Dataset Sync
          </Button>
        )}

        {pipelineConfirm && pipelineStatus === "idle" && (
          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-400/40 bg-amber-400/5 px-4 py-3">
            <AlertTriangle className="size-4 shrink-0 text-amber-600 dark:text-amber-400" />
            <p className="flex-1 text-sm text-amber-800 dark:text-amber-200">
              This will process the latest source Excel from Drive, update New
              Sheet, reconcile Master Sheet Job Status in Column K (Dataset
              engine), skip the conflicting{" "}
              <span className="font-medium">UpdateJobRequisitionsStatusLateral</span>{" "}
              status body, keep the XLSM VBA project, upload to the destination
              folder, and update Dataset Manager.
            </p>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="rounded-lg"
                onClick={() => setPipelineConfirm(false)}
              >
                Cancel
              </Button>
              <Button
                type="button"
                size="sm"
                className="rounded-lg gap-1.5"
                onClick={() => void runPipeline()}
              >
                <Play className="size-3.5" />
                Confirm &amp; Run Pipeline
              </Button>
            </div>
          </div>
        )}

        {pipelineStatus === "running" && (
          <div className="flex items-center gap-3 rounded-lg border border-primary/20 bg-background/50 px-4 py-3">
            <RefreshCw className="size-4 animate-spin text-primary" />
            <div>
              <p className="text-sm font-medium text-foreground">
                Running Lateral Dataset Processing Pipeline…
              </p>
              <p className="text-xs text-muted-foreground">
                Steps 1–25. This may take several minutes (includes Excel VBA).
              </p>
            </div>
          </div>
        )}

        {pipelineStatus === "success" &&
          pipelineResult &&
          pipelineResult.ok && (
            <PipelineSuccessView result={pipelineResult} />
          )}

        {pipelineStatus === "error" &&
          pipelineResult &&
          !pipelineResult.ok && (
            <PipelineFailureView result={pipelineResult} />
          )}

        {(pipelineStatus === "success" || pipelineStatus === "error") && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="rounded-xl gap-1.5"
            onClick={() => {
              setPipelineStatus("idle");
              setPipelineResult(null);
              setPipelineConfirm(false);
            }}
            disabled={busy}
          >
            <RefreshCw className="size-3.5" />
            Run again
          </Button>
        )}
      </div>

      {/* ── Preview header ─────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/60 bg-muted/10 px-4 py-3">
        <div>
          <p className="text-sm font-medium text-foreground">
            Data Reading Preview
          </p>
          <p className="text-xs text-muted-foreground">
            Optional read-only check of headers and mapping before a pipeline
            run. No data is modified during preview.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          className="rounded-xl gap-2"
          onClick={() => void loadPreview()}
          disabled={previewStatus === "loading" || busy}
        >
          <RefreshCw
            className={cn("size-4", previewStatus === "loading" && "animate-spin")}
          />
          {previewStatus === "loading"
            ? "Reading workbooks…"
            : previewStatus === "idle"
              ? "Read & Preview"
              : "Refresh Preview"}
        </Button>
      </div>

      {previewStatus === "idle" && (
        <p className="text-sm text-muted-foreground">
          Click <span className="font-medium">Read &amp; Preview</span> to read
          the configured source worksheet and build the column mapping. No files
          will be modified.
        </p>
      )}

      {previewStatus === "loading" && (
        <div className="space-y-2 py-6 text-center">
          <RefreshCw className="mx-auto size-6 animate-spin text-primary" />
          <p className="text-sm text-muted-foreground">
            Downloading workbooks from Google Drive and reading headers…
          </p>
          <p className="text-xs text-muted-foreground">This may take 15–30 seconds.</p>
        </div>
      )}

      {previewStatus === "error" && previewError && (
        <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4">
          <p className="text-sm font-medium text-destructive">Preview error</p>
          <p className="mt-1 text-sm text-destructive">{previewError}</p>
        </div>
      )}

      {previewStatus === "success" && previewResult !== null && (
        <>
          {!previewResult.ok ? (
            <MappingFailureView
              missing={previewResult.missingDestinationHeaders}
              available={previewResult.availableSourceHeaders}
            />
          ) : (
            <PreviewView data={previewResult} />
          )}
        </>
      )}

      {/* ── Advanced: staged execute + confirm (optional) ─────────── */}
      {previewOk && execStatus === "idle" && pipelineStatus !== "running" && (
        <div className="rounded-xl border border-border/60 bg-muted/10 p-4 space-y-3">
          <div>
            <p className="text-sm font-semibold text-foreground">
              Advanced: Update New Sheet + Reconcile (review before save)
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Prefer <span className="font-medium">Run Lateral Dataset Sync</span>{" "}
              above for the full safe pipeline. This path stages a report and
              waits for Confirm &amp; Save.
            </p>
          </div>

          {!confirmPending ? (
            <Button
              type="button"
              variant="outline"
              className="rounded-xl gap-2"
              onClick={() => setConfirmPending(true)}
              disabled={busy}
            >
              <Play className="size-4" />
              Update New Sheet &amp; Reconcile
            </Button>
          ) : (
            <div className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-400/40 bg-amber-400/5 px-4 py-3">
              <AlertTriangle className="size-4 shrink-0 text-amber-600 dark:text-amber-400" />
              <p className="flex-1 text-sm text-amber-800 dark:text-amber-200">
                Are you sure? New Sheet data rows will be replaced, then a
                reconciliation report will be prepared. Master Sheet status
                changes will not be saved until you confirm.
              </p>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="rounded-lg"
                  onClick={() => setConfirmPending(false)}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  size="sm"
                  className="rounded-lg gap-1.5"
                  onClick={() => void executeUpdate()}
                >
                  <Play className="size-3.5" />
                  Confirm &amp; Execute
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {execStatus === "running" && (
        <div className="flex items-center gap-3 rounded-lg border border-primary/20 bg-primary/5 px-4 py-3">
          <RefreshCw className="size-4 animate-spin text-primary" />
          <div>
            <p className="text-sm font-medium text-foreground">
              Updating New Sheet, then preparing reconciliation report…
            </p>
            <p className="text-xs text-muted-foreground">
              Master Sheet changes will not be saved until you Confirm &amp;
              Save. This may take a few minutes.
            </p>
          </div>
        </div>
      )}

      {execStatus === "error" && execError && (
        <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4">
          <p className="text-sm font-medium text-destructive">
            Execution error
          </p>
          <p className="mt-1 text-sm text-destructive">{execError}</p>
        </div>
      )}

      {/* ── Execute / report result ─────────────────────────────────── */}
      {execResult !== null && (
        <div className="space-y-2">
          <ExecuteResultView
            result={execResult}
            pending={execStatus === "pending_save"}
            saving={saving}
            cancelling={cancelling}
            onConfirm={() => void confirmSave()}
            onCancel={() => void cancelRollback()}
            decisionMessage={decisionMessage}
            macroResult={macroResult}
          />
          {(execStatus === "done" || execStatus === "error") && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="rounded-xl gap-1.5"
              onClick={() => void loadPreview()}
            >
              <RefreshCw className="size-3.5" />
              Refresh Preview
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
