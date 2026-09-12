"use client";

import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Download, Loader2, RefreshCw, X } from "lucide-react";
import { PageHeader } from "@/components/layouts/page-header";
import { PageTransition } from "@/animations/page-transition";
import { FadeIn } from "@/animations/fade-in";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { ExecutiveMasterSheetTable } from "@/components/dashboard/accenture/executive/executive-master-sheet-table";
import {
  DEFAULT_EXECUTIVE_MASTER_PAGE_SIZE,
  type ExecutiveMasterDateFilter,
  type ExecutiveMasterPageSize,
} from "@/services/excel/executive-master-sheet";
import {
  downloadExecutiveMasterSheetXlsx,
  fetchExecutiveMasterFilterSchema,
  fetchExecutiveMasterSheet,
  executiveMasterSchemaQueryKey,
  executiveMasterSheetQueryKey,
  useExecutiveMasterFilterSchema,
  useExecutiveMasterSheet,
  type ExecutiveMasterSheetClientQuery,
} from "@/hooks/use-executive-master-sheet";

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = React.useState(value);
  React.useEffect(() => {
    const id = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(id);
  }, [value, delayMs]);
  return debounced;
}

export function ExecutiveMasterSheetPage() {
  const queryClient = useQueryClient();
  const [page, setPage] = React.useState(1);
  const [pageSize, setPageSize] = React.useState<ExecutiveMasterPageSize>(
    DEFAULT_EXECUTIVE_MASTER_PAGE_SIZE
  );
  const [columnFilters, setColumnFilters] = React.useState<
    Record<string, string[]>
  >({});
  const [textFilters, setTextFilters] = React.useState<Record<string, string>>(
    {}
  );
  const [dateFilters, setDateFilters] = React.useState<
    Record<string, ExecutiveMasterDateFilter>
  >({});
  const [refreshing, setRefreshing] = React.useState(false);
  const [downloading, setDownloading] = React.useState(false);
  const [downloadError, setDownloadError] = React.useState<string | null>(null);

  const debouncedTextFilters = useDebouncedValue(textFilters, 450);
  const debouncedDateFilters = useDebouncedValue(dateFilters, 450);

  const query: ExecutiveMasterSheetClientQuery = React.useMemo(
    () => ({
      page,
      pageSize,
      columnFilters,
      textFilters: debouncedTextFilters,
      dateFilters: debouncedDateFilters,
    }),
    [page, pageSize, columnFilters, debouncedTextFilters, debouncedDateFilters]
  );

  const {
    data: schema,
    isLoading: schemaLoading,
    error: schemaError,
  } = useExecutiveMasterFilterSchema();

  const { data, isLoading, isFetching, error } = useExecutiveMasterSheet(query);

  React.useEffect(() => {
    setPage(1);
  }, [columnFilters, debouncedTextFilters, debouncedDateFilters, pageSize]);

  const activeFilterCount =
    Object.values(columnFilters).filter((v) => v.length > 0).length +
    Object.values(textFilters).filter((v) => v.trim()).length +
    Object.values(dateFilters).filter((v) => v.from || v.to).length;

  // Each active filter as a removable chip, mirroring the Lateral Master Sheet.
  const activeFilterChips: Array<{
    key: string;
    label: string;
    remove: () => void;
  }> = [];
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

  async function handleRefresh() {
    setRefreshing(true);
    try {
      const nextSchema = await fetchExecutiveMasterFilterSchema({
        refresh: true,
      });
      queryClient.setQueryData(executiveMasterSchemaQueryKey(), nextSchema);
      const nextPage = await fetchExecutiveMasterSheet(query, {
        refresh: true,
      });
      queryClient.setQueryData(executiveMasterSheetQueryKey(query), nextPage);
    } finally {
      setRefreshing(false);
    }
  }

  async function handleDownloadExcel() {
    setDownloading(true);
    setDownloadError(null);
    try {
      await downloadExecutiveMasterSheetXlsx();
    } catch (err) {
      setDownloadError(
        err instanceof Error
          ? err.message
          : "Failed to download Executive Master Sheet Excel."
      );
    } finally {
      setDownloading(false);
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

  function onDateChange(column: string, range: ExecutiveMasterDateFilter) {
    setDateFilters((prev) => {
      const copy = { ...prev };
      if (!range.from && !range.to) delete copy[column];
      else copy[column] = range;
      return copy;
    });
  }

  function clearAllFilters() {
    setColumnFilters({});
    setTextFilters({});
    setDateFilters({});
  }

  const errorMessage =
    downloadError ||
    (error instanceof Error
      ? error.message
      : schemaError instanceof Error
        ? schemaError.message
        : null);

  return (
    <PageTransition>
      <PageHeader
        title="Executive"
        description="Executive Master Sheet from PostgreSQL (executive_master)."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              className="rounded-xl gap-2"
              onClick={() => void handleDownloadExcel()}
              disabled={downloading || schemaLoading}
            >
              {downloading ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Download className="size-4" />
              )}
              {downloading ? "Downloading…" : "Download"}
            </Button>
            <Button
              type="button"
              variant="outline"
              className="rounded-xl gap-2"
              onClick={() => void handleRefresh()}
              disabled={refreshing || isFetching}
            >
              <RefreshCw
                className={`size-4 ${refreshing || isFetching ? "animate-spin" : ""}`}
              />
              Refresh
            </Button>
          </div>
        }
      />

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
              {activeFilterCount} column{activeFilterCount === 1 ? "" : "s"}{" "}
              filtered
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
          <CardHeader className="pb-2">
            <p className="text-sm font-semibold text-foreground">Master Sheet</p>
            <p className="text-xs text-muted-foreground">
              13 columns stored in executive_master. Click the filter icon in a
              column header to filter.
            </p>
          </CardHeader>
          <CardContent>
            <ExecutiveMasterSheetTable
              headers={data?.headers ?? schema?.headers ?? []}
              rows={data?.rows ?? []}
              total={data?.total ?? 0}
              page={data?.page ?? page}
              pageSize={pageSize}
              pageCount={data?.pageCount ?? 0}
              isLoading={isLoading && !data}
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
            />
          </CardContent>
        </Card>
      </FadeIn>
    </PageTransition>
  );
}
