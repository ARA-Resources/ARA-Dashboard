"use client";

import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  History,
  Loader2,
  RefreshCw,
  Upload,
  X,
} from "lucide-react";
import { PageHeader } from "@/components/layouts/page-header";
import { PageTransition } from "@/animations/page-transition";
import { FadeIn } from "@/animations/fade-in";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { CandidateMasterSheetTable } from "@/components/dashboard/accenture/candidate/candidate-master-sheet-table";
import { LateralMasterColumnFilter } from "@/components/dashboard/accenture/lateral/lateral-master-column-filter";
import { MasterSheetPaginationBar } from "@/components/dashboard/accenture/master-sheet-pagination-bar";
import {
  CANDIDATE_HIGHLIGHT_FILTER_OPTIONS,
  DEFAULT_CANDIDATE_MASTER_PAGE_SIZE,
  CANDIDATE_MASTER_PAGE_SIZE_OPTIONS,
  type CandidateHighlightFilterValue,
  type CandidateMasterDateFilter,
  type CandidateMasterPageSize,
} from "@/services/excel/candidate-master-sheet";
import type { LateralMasterFilterField } from "@/services/excel/lateral-master-sheet";
import {
  fetchCandidateMasterFilterSchema,
  fetchCandidateMasterSheet,
  candidateMasterSchemaQueryKey,
  candidateMasterSheetQueryKey,
  useCandidateMasterFilterSchema,
  useCandidateMasterSheet,
  useCandidateSyncHistory,
  type CandidateMasterSheetClientQuery,
} from "@/hooks/use-candidate-master-sheet";
import type { CandidateSyncHistoryRow } from "@/services/persistence/read-candidate-sync-history";
import {
  CANDIDATE_OORWIN_ACCEPTED_EXTENSIONS,
  isAcceptedCandidateOorwinFile,
  useCandidateOorwinSync,
} from "@/hooks/use-candidate-oorwin-sync";
import { useCurrentUser } from "@/hooks/use-current-user";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { cn } from "@/lib/utils";

/**
 * "Highlights" isn't a real candidate_master column — it's a synthetic
 * pseudo-column so the existing, already-proven MultiSelectHeaderFilter
 * checkbox panel (lateral-master-column-filter.tsx) can be reused verbatim
 * as a toolbar control instead of building a new filter widget. The widget
 * only speaks in the display label strings it's given, so these lookups
 * translate between that and the CandidateHighlightFilterValue codes the API
 * actually wants.
 */
const HIGHLIGHT_LABEL_BY_VALUE = new Map<string, string>(
  CANDIDATE_HIGHLIGHT_FILTER_OPTIONS.map((option) => [option.value, option.label])
);
const HIGHLIGHT_VALUE_BY_LABEL = new Map<string, CandidateHighlightFilterValue>(
  CANDIDATE_HIGHLIGHT_FILTER_OPTIONS.map((option) => [option.label, option.value])
);
const HIGHLIGHT_FILTER_FIELD: LateralMasterFilterField = {
  column: "Highlights",
  control: "multi-select",
  values: CANDIDATE_HIGHLIGHT_FILTER_OPTIONS.map((option) => option.label),
  valueCount: CANDIDATE_HIGHLIGHT_FILTER_OPTIONS.length,
};

function formatSyncLabel(sync: CandidateSyncHistoryRow): string {
  const date = new Date(sync.startedAt);
  const dateLabel = Number.isNaN(date.getTime())
    ? sync.startedAt
    : date.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
  return sync.sourceFilename ? `${sync.sourceFilename} — ${dateLabel}` : dateLabel;
}

/**
 * Single-select "which sync run" picker — a plain button list inside the
 * dropdown, not the checkbox-based MultiSelectHeaderFilter (LateralMasterColumnFilter),
 * since only one sync can be selected at a time.
 */
function SyncFilterMenu({
  syncs,
  selectedSyncId,
  onSelect,
  onClear,
}: {
  syncs: CandidateSyncHistoryRow[];
  selectedSyncId: number | null;
  onSelect: (syncId: number) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  const selected = syncs.find((sync) => sync.id === selectedSyncId) ?? null;

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="outline"
            className={cn(
              "max-w-64 rounded-xl gap-2",
              selectedSyncId != null && "border-primary/40 text-primary"
            )}
          />
        }
      >
        <History className="size-4 shrink-0" />
        <span className="truncate">
          {selected ? `Sync: ${formatSyncLabel(selected)}` : "Filter by Sync"}
        </span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80 p-0">
        <DropdownMenuLabel className="px-3 py-2 text-xs">Filter by Sync Run</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <div className="max-h-72 space-y-0.5 overflow-y-auto p-2">
          {syncs.length === 0 ? (
            <p className="px-2 py-3 text-xs text-muted-foreground">No sync runs yet.</p>
          ) : (
            syncs.map((sync) => (
              <button
                key={sync.id}
                type="button"
                onClick={() => {
                  onSelect(sync.id);
                  setOpen(false);
                }}
                className={cn(
                  "flex w-full flex-col items-start gap-0.5 rounded-lg px-2 py-1.5 text-left hover:bg-muted/50",
                  sync.id === selectedSyncId && "bg-primary/10"
                )}
              >
                <span className="w-full truncate text-xs font-medium">
                  {formatSyncLabel(sync)}
                </span>
                <span className="text-[11px] text-muted-foreground">
                  {sync.counts.inserted} inserted · {sync.counts.updated} updated ·{" "}
                  {sync.counts.reviewFlags} flagged
                </span>
              </button>
            ))
          )}
        </div>
        {selectedSyncId != null ? (
          <>
            <DropdownMenuSeparator />
            <div className="p-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 w-full rounded-lg text-xs"
                onClick={onClear}
              >
                Clear
              </Button>
            </div>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function CandidateMasterSheetPage() {
  const queryClient = useQueryClient();
  const [page, setPage] = React.useState(1);
  const [pageSize, setPageSize] = React.useState<CandidateMasterPageSize>(
    DEFAULT_CANDIDATE_MASTER_PAGE_SIZE
  );
  const [columnFilters, setColumnFilters] = React.useState<Record<string, string[]>>({});
  const [textFilters, setTextFilters] = React.useState<Record<string, string>>({});
  const [dateFilters, setDateFilters] = React.useState<
    Record<string, CandidateMasterDateFilter>
  >({});
  const [highlightFilters, setHighlightFilters] = React.useState<CandidateHighlightFilterValue[]>(
    []
  );
  const [syncFilter, setSyncFilter] = React.useState<number | null>(null);
  const [refreshing, setRefreshing] = React.useState(false);

  const { data: syncHistory } = useCandidateSyncHistory();

  const { isAtLeast } = useCurrentUser();
  const canUploadOorwin = isAtLeast("editor");
  const oorwinSync = useCandidateOorwinSync();
  const [uploadOpen, setUploadOpen] = React.useState(false);
  const [uploadInputKey, setUploadInputKey] = React.useState(0);
  const [selectedOorwinFile, setSelectedOorwinFile] = React.useState<File | null>(null);
  const [oorwinFileError, setOorwinFileError] = React.useState<string | null>(null);

  const debouncedTextFilters = useDebouncedValue(textFilters, 450);
  const debouncedDateFilters = useDebouncedValue(dateFilters, 450);

  const query: CandidateMasterSheetClientQuery = React.useMemo(
    () => ({
      page,
      pageSize,
      columnFilters,
      textFilters: debouncedTextFilters,
      dateFilters: debouncedDateFilters,
      highlightFilters,
      syncFilter,
    }),
    [
      page,
      pageSize,
      columnFilters,
      debouncedTextFilters,
      debouncedDateFilters,
      highlightFilters,
      syncFilter,
    ]
  );

  const {
    data: schema,
    isLoading: schemaLoading,
    error: schemaError,
  } = useCandidateMasterFilterSchema();

  const { data, isLoading, isFetching, error } = useCandidateMasterSheet(query);

  React.useEffect(() => {
    setPage(1);
  }, [
    columnFilters,
    debouncedTextFilters,
    debouncedDateFilters,
    highlightFilters,
    syncFilter,
    pageSize,
  ]);

  const activeFilterCount =
    Object.values(columnFilters).filter((v) => v.length > 0).length +
    Object.values(textFilters).filter((v) => v.trim()).length +
    Object.values(dateFilters).filter((v) => v.from || v.to).length +
    (highlightFilters.length > 0 ? 1 : 0) +
    (syncFilter != null ? 1 : 0);

  const activeFilterChips: Array<{ key: string; label: string; remove: () => void }> = [];
  for (const [col, values] of Object.entries(columnFilters)) {
    if (values.length === 0) continue;
    const more = values.length > 2 ? ` +${values.length - 2}` : "";
    activeFilterChips.push({
      key: `col:${col}`,
      label: `${col}: ${values.slice(0, 2).join(", ")}${more}`,
      remove: () => clearColumn(col),
    });
  }
  for (const [col, value] of Object.entries(textFilters)) {
    if (!value.trim()) continue;
    activeFilterChips.push({
      key: `text:${col}`,
      label: `${col}: "${value.trim()}"`,
      remove: () => onTextChange(col, ""),
    });
  }
  for (const [col, range] of Object.entries(dateFilters)) {
    if (!range.from && !range.to) continue;
    activeFilterChips.push({
      key: `date:${col}`,
      label: `${col}: ${range.from ?? "…"} → ${range.to ?? "…"}`,
      remove: () => onDateChange(col, {}),
    });
  }
  if (highlightFilters.length > 0) {
    const labels = highlightFilters.map((value) => HIGHLIGHT_LABEL_BY_VALUE.get(value) ?? value);
    const more = labels.length > 2 ? ` +${labels.length - 2}` : "";
    activeFilterChips.push({
      key: "highlights",
      label: `Highlights: ${labels.slice(0, 2).join(", ")}${more}`,
      remove: () => setHighlightFilters([]),
    });
  }
  if (syncFilter != null) {
    const sync = syncHistory?.find((s) => s.id === syncFilter);
    activeFilterChips.push({
      key: "sync",
      label: `Sync: ${sync ? formatSyncLabel(sync) : `#${syncFilter}`}`,
      remove: () => setSyncFilter(null),
    });
  }

  async function handleRefresh() {
    setRefreshing(true);
    try {
      const nextSchema = await fetchCandidateMasterFilterSchema();
      queryClient.setQueryData(candidateMasterSchemaQueryKey(), nextSchema);
      const nextPage = await fetchCandidateMasterSheet(query);
      queryClient.setQueryData(candidateMasterSheetQueryKey(query), nextPage);
    } finally {
      setRefreshing(false);
    }
  }

  function handleOorwinFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    if (file && !isAcceptedCandidateOorwinFile(file.name)) {
      setSelectedOorwinFile(null);
      setOorwinFileError("Unsupported file type. Expected .xls, .xlsx, or .xlsm.");
      return;
    }
    setOorwinFileError(null);
    setSelectedOorwinFile(file);
  }

  async function handleRunOorwinSync() {
    if (!selectedOorwinFile) return;
    try {
      await oorwinSync.mutateAsync(selectedOorwinFile);
      setSelectedOorwinFile(null);
      setUploadInputKey((k) => k + 1);
      setUploadOpen(false);
    } catch {
      // surfaced via oorwinSync.error in the result banner below
    }
  }

  function toggleColumnValue(column: string, value: string) {
    setColumnFilters((prev) => {
      const current = prev[column] ?? [];
      const next = current.includes(value)
        ? current.filter((item) => item !== value)
        : [...current, value];
      const copy = { ...prev };
      if (next.length === 0) delete copy[column];
      else copy[column] = next;
      return copy;
    });
  }

  function clearColumn(column: string) {
    setColumnFilters((prev) => {
      const copy = { ...prev };
      delete copy[column];
      return copy;
    });
  }

  function onTextChange(column: string, value: string) {
    setTextFilters((prev) => {
      const copy = { ...prev };
      if (!value.trim()) delete copy[column];
      else copy[column] = value;
      return copy;
    });
  }

  function onDateChange(column: string, range: CandidateMasterDateFilter) {
    setDateFilters((prev) => {
      const copy = { ...prev };
      if (!range.from && !range.to) delete copy[column];
      else copy[column] = range;
      return copy;
    });
  }

  function toggleHighlightFilterLabel(label: string) {
    const value = HIGHLIGHT_VALUE_BY_LABEL.get(label);
    if (!value) return;
    setHighlightFilters((prev) =>
      prev.includes(value) ? prev.filter((item) => item !== value) : [...prev, value]
    );
  }

  function clearHighlightFilters() {
    setHighlightFilters([]);
  }

  function clearAllFilters() {
    setColumnFilters({});
    setTextFilters({});
    setDateFilters({});
    setHighlightFilters([]);
    setSyncFilter(null);
  }

  const errorMessage =
    error instanceof Error
      ? error.message
      : schemaError instanceof Error
        ? schemaError.message
        : null;

  const oorwinError = oorwinSync.error instanceof Error ? oorwinSync.error.message : null;
  const oorwinResult = oorwinSync.data ?? null;
  const oorwinBannerTone: "success" | "partial" | "failed" | null = oorwinError
    ? "failed"
    : oorwinResult
      ? oorwinResult.result
      : null;

  return (
    <PageTransition>
      <PageHeader
        title="Candidates"
        description="Candidate Master Sheet from PostgreSQL (candidate_master)."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1.5 rounded-xl border border-border bg-background px-2.5 h-8">
              <span className="text-xs font-medium text-muted-foreground">Highlights</span>
              <LateralMasterColumnFilter
                field={HIGHLIGHT_FILTER_FIELD}
                selectedValues={highlightFilters.map(
                  (value) => HIGHLIGHT_LABEL_BY_VALUE.get(value) ?? value
                )}
                textValue=""
                dateValue={{}}
                onToggleValue={toggleHighlightFilterLabel}
                onClearColumn={clearHighlightFilters}
                onTextChange={() => {}}
                onDateChange={() => {}}
              />
            </div>
            <SyncFilterMenu
              syncs={syncHistory ?? []}
              selectedSyncId={syncFilter}
              onSelect={setSyncFilter}
              onClear={() => setSyncFilter(null)}
            />
            {canUploadOorwin ? (
              <DropdownMenu open={uploadOpen} onOpenChange={setUploadOpen}>
                <DropdownMenuTrigger
                  render={
                    <Button type="button" variant="outline" className="rounded-xl gap-2" />
                  }
                >
                  <Upload className="size-4" />
                  Upload
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-80 p-3">
                  <DropdownMenuLabel className="px-0 pb-2 text-xs">
                    Upload Oorwin Export
                  </DropdownMenuLabel>
                  <div className="space-y-2" onClick={(e) => e.stopPropagation()}>
                    <p className="text-xs text-muted-foreground">
                      Accepts .xls, .xlsx, or .xlsm — the raw Oorwin &quot;Candidate
                      Master Tracker&quot; export, unmodified.
                    </p>
                    <Input
                      key={uploadInputKey}
                      type="file"
                      accept={CANDIDATE_OORWIN_ACCEPTED_EXTENSIONS.join(",")}
                      onChange={handleOorwinFileChange}
                      disabled={oorwinSync.isPending}
                      className="h-auto py-1.5 text-xs"
                      onKeyDown={(e) => e.stopPropagation()}
                    />
                    {oorwinFileError ? (
                      <p className="text-xs text-destructive">{oorwinFileError}</p>
                    ) : null}
                    <Button
                      type="button"
                      className="w-full rounded-xl gap-2"
                      onClick={() => void handleRunOorwinSync()}
                      disabled={oorwinSync.isPending || !selectedOorwinFile}
                    >
                      {oorwinSync.isPending ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <Upload className="size-4" />
                      )}
                      {oorwinSync.isPending ? "Syncing…" : "Run Sync"}
                    </Button>
                  </div>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
            <Button
              type="button"
              variant="outline"
              className="rounded-xl gap-2"
              onClick={() => void handleRefresh()}
              disabled={refreshing || isFetching}
            >
              {refreshing || isFetching ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <RefreshCw className="size-4" />
              )}
              Refresh
            </Button>
          </div>
        }
      />

      {oorwinBannerTone ? (
        <FadeIn>
          <div
            className={cn(
              "mb-3 flex items-start gap-2 rounded-xl border p-3 text-sm",
              oorwinBannerTone === "success"
                ? "border-primary/30 bg-primary/5 text-foreground"
                : oorwinBannerTone === "partial"
                  ? "border-amber-500/25 bg-amber-500/5 text-foreground"
                  : "border-destructive/30 bg-destructive/5 text-destructive"
            )}
            role="status"
          >
            {oorwinBannerTone === "success" ? (
              <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
            ) : oorwinBannerTone === "partial" ? (
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
            ) : (
              <AlertCircle className="mt-0.5 size-4 shrink-0" />
            )}
            <div className="min-w-0 flex-1 space-y-1">
              {oorwinError ? (
                <p>{oorwinError}</p>
              ) : oorwinResult ? (
                <>
                  <p
                    className={
                      oorwinBannerTone === "partial"
                        ? "font-medium text-amber-600 dark:text-amber-400"
                        : "font-medium"
                    }
                  >
                    {oorwinResult.result === "success"
                      ? "Sync completed — no issues."
                      : oorwinResult.result === "partial"
                        ? "Sync completed — some rows need review."
                        : "Sync failed."}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {oorwinResult.sourceFilename} · {oorwinResult.counts.rowsInSheet} row(s) in
                    sheet · {oorwinResult.counts.inserted} inserted ·{" "}
                    {oorwinResult.counts.updated} updated · {oorwinResult.counts.unchanged}{" "}
                    unchanged · {oorwinResult.counts.quarantined} quarantined ·{" "}
                    {oorwinResult.counts.skippedBlankCid} skipped (blank CID) ·{" "}
                    {oorwinResult.counts.reviewFlags} review flag(s)
                  </p>
                  {oorwinResult.failureReason ? (
                    <p className="text-xs text-destructive/90">{oorwinResult.failureReason}</p>
                  ) : null}
                  {oorwinResult.syncId != null &&
                  oorwinResult.counts.inserted + oorwinResult.counts.updated > 0 ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="mt-1 h-7 rounded-lg text-xs"
                      onClick={() => setSyncFilter(oorwinResult.syncId)}
                    >
                      View these {oorwinResult.counts.inserted + oorwinResult.counts.updated}{" "}
                      candidates
                    </Button>
                  ) : null}
                </>
              ) : null}
            </div>
            <button
              type="button"
              onClick={() => oorwinSync.reset()}
              aria-label="Dismiss sync result"
              className="-mr-0.5 -mt-0.5 shrink-0 rounded-sm p-0.5 hover:bg-foreground/10"
            >
              <X className="size-3.5" />
            </button>
          </div>
        </FadeIn>
      ) : null}

      <FadeIn>
        <div className="mb-4 flex flex-wrap items-center gap-2">
          {data?.sheetName ? (
            <Badge variant="secondary" className="rounded-md">
              Sheet: {data.sheetName}
            </Badge>
          ) : null}
          {data?.sourceFile || schema?.sourceFile ? (
            <Badge variant="outline" className="max-w-full truncate rounded-md">
              Source: {data?.sourceFile || schema?.sourceFile}
            </Badge>
          ) : null}
          {typeof data?.total === "number" ? (
            <Badge variant="secondary" className="rounded-md">
              {data.total.toLocaleString()} rows
            </Badge>
          ) : null}
        </div>
      </FadeIn>

      {activeFilterCount > 0 ? (
        <FadeIn>
          <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-primary/20 bg-primary/5 px-3 py-1.5 text-xs">
            <span className="font-medium text-primary">
              {activeFilterCount} filter{activeFilterCount === 1 ? "" : "s"} applied
            </span>
            {activeFilterChips.map((chip) => (
              <span
                key={chip.key}
                className="inline-flex items-center gap-1 rounded-md border border-primary/15 bg-background/60 px-1.5 py-0.5 text-muted-foreground"
              >
                {chip.label}
                <button
                  type="button"
                  onClick={chip.remove}
                  aria-label={`Remove ${chip.label} filter`}
                  className="-mr-0.5 rounded-sm p-0.5 hover:bg-primary/10 hover:text-primary"
                >
                  <X className="size-3" />
                </button>
              </span>
            ))}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="ml-auto h-6 gap-1 rounded-md px-2 text-xs"
              onClick={clearAllFilters}
            >
              <X className="size-3.5" />
              Clear all
            </Button>
          </div>
        </FadeIn>
      ) : null}

      <FadeIn>
        <Card className="rounded-2xl border-border/70">
          <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3 pb-2">
            <div>
              <p className="text-sm font-semibold text-foreground">Master Sheet</p>
              <p className="text-xs text-muted-foreground">
                14 columns stored in candidate_master. Click the filter icon in a
                column header to filter.
              </p>
            </div>
            {data && data.total > 0 ? (
              <MasterSheetPaginationBar
                variant="compact"
                total={data.total}
                page={data.page ?? page}
                pageSize={pageSize}
                pageCount={data.pageCount ?? 0}
                pageSizeOptions={CANDIDATE_MASTER_PAGE_SIZE_OPTIONS}
                defaultPageSize={DEFAULT_CANDIDATE_MASTER_PAGE_SIZE}
                onPageChange={setPage}
                onPageSizeChange={(size) => setPageSize(size as CandidateMasterPageSize)}
              />
            ) : null}
          </CardHeader>
          <CardContent>
            <CandidateMasterSheetTable
              headers={data?.headers ?? schema?.headers ?? []}
              rows={data?.rows ?? []}
              total={data?.total ?? 0}
              page={data?.page ?? page}
              pageSize={pageSize}
              pageCount={data?.pageCount ?? 0}
              isLoading={isLoading || schemaLoading}
              isFetching={isFetching}
              errorMessage={errorMessage}
              onPageChange={setPage}
              onPageSizeChange={setPageSize}
              filterFields={schema?.fields}
              columnFilters={columnFilters}
              textFilters={textFilters}
              dateFilters={dateFilters}
              onToggleColumnValue={toggleColumnValue}
              onClearColumn={clearColumn}
              onTextChange={onTextChange}
              onDateChange={onDateChange}
              highlights={data?.highlights}
            />
          </CardContent>
        </Card>
      </FadeIn>
    </PageTransition>
  );
}
