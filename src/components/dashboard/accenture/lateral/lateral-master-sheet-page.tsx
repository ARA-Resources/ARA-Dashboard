"use client";

import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Download, Filter, Loader2, RefreshCw, X } from "lucide-react";
import { PageHeader } from "@/components/layouts/page-header";
import { PageTransition } from "@/animations/page-transition";
import { FadeIn } from "@/animations/fade-in";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { LateralMasterFiltersPanel } from "@/components/dashboard/accenture/lateral/lateral-master-filters-panel";
import { LateralMasterSheetTable } from "@/components/dashboard/accenture/lateral/lateral-master-sheet-table";
import {
  DEFAULT_LATERAL_MASTER_PAGE_SIZE,
  type LateralMasterDateFilter,
  type LateralMasterPageSize,
} from "@/services/excel/lateral-master-sheet";
import {
  downloadLateralMasterSheetXlsx,
  fetchLateralMasterFilterSchema,
  fetchLateralMasterSheet,
  lateralMasterSchemaQueryKey,
  lateralMasterSheetQueryKey,
  useLateralMasterFilterSchema,
  useLateralMasterSheet,
  type LateralMasterSheetClientQuery,
} from "@/hooks/use-lateral-master-sheet";
import { cn } from "@/lib/utils";

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = React.useState(value);
  React.useEffect(() => {
    const id = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(id);
  }, [value, delayMs]);
  return debounced;
}

export function LateralMasterSheetPage() {
  const queryClient = useQueryClient();
  const [page, setPage] = React.useState(1);
  const [pageSize, setPageSize] = React.useState<LateralMasterPageSize>(
    DEFAULT_LATERAL_MASTER_PAGE_SIZE
  );
  const [columnFilters, setColumnFilters] = React.useState<
    Record<string, string[]>
  >({});
  const [textFilters, setTextFilters] = React.useState<Record<string, string>>(
    {}
  );
  const [dateFilters, setDateFilters] = React.useState<
    Record<string, LateralMasterDateFilter>
  >({});
  const [refreshing, setRefreshing] = React.useState(false);
  const [downloading, setDownloading] = React.useState(false);
  const [downloadError, setDownloadError] = React.useState<string | null>(null);
  const [filtersOpen, setFiltersOpen] = React.useState(false);

  const debouncedTextFilters = useDebouncedValue(textFilters, 450);

  const query: LateralMasterSheetClientQuery = React.useMemo(
    () => ({
      page,
      pageSize,
      columnFilters,
      textFilters: debouncedTextFilters,
      dateFilters,
    }),
    [page, pageSize, columnFilters, debouncedTextFilters, dateFilters]
  );

  const {
    data: schema,
    isLoading: schemaLoading,
    error: schemaError,
  } = useLateralMasterFilterSchema();

  const { data, isLoading, isFetching, error } = useLateralMasterSheet(query);

  React.useEffect(() => {
    setPage(1);
  }, [columnFilters, debouncedTextFilters, dateFilters, pageSize]);

  const activeFilterCount =
    Object.values(columnFilters).filter((v) => v.length > 0).length +
    Object.values(textFilters).filter((v) => v.trim()).length +
    Object.values(dateFilters).filter((v) => v.from || v.to).length;

  async function handleRefresh() {
    setRefreshing(true);
    try {
      const nextSchema = await fetchLateralMasterFilterSchema({
        refresh: true,
      });
      queryClient.setQueryData(lateralMasterSchemaQueryKey(), nextSchema);
      const nextPage = await fetchLateralMasterSheet(query, { refresh: true });
      queryClient.setQueryData(lateralMasterSheetQueryKey(query), nextPage);
    } finally {
      setRefreshing(false);
    }
  }

  async function handleDownloadExcel() {
    setDownloading(true);
    setDownloadError(null);
    try {
      await downloadLateralMasterSheetXlsx();
    } catch (err) {
      setDownloadError(
        err instanceof Error
          ? err.message
          : "Failed to download Master Sheet Excel."
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

  function onDateChange(column: string, range: LateralMasterDateFilter) {
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
        title="Lateral"
        description="Lateral Master Sheet from PostgreSQL (lateral_master)."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant={filtersOpen ? "default" : "outline"}
              className={cn(
                "rounded-xl gap-2",
                filtersOpen && "bg-primary text-primary-foreground"
              )}
              onClick={() => setFiltersOpen((open) => !open)}
              aria-expanded={filtersOpen}
              aria-controls="lateral-master-filters-popup"
            >
              <Filter className="size-4" />
              Filters
              {activeFilterCount > 0 ? (
                <Badge
                  variant="secondary"
                  className={cn(
                    "rounded-md px-1.5",
                    filtersOpen && "bg-background/20 text-primary-foreground"
                  )}
                >
                  {activeFilterCount}
                </Badge>
              ) : null}
            </Button>
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
          {(data?.sourceFile || schema?.sourceFile) ? (
            (data?.sourceUrl || schema?.sourceUrl) ? (
              <a
                href={data?.sourceUrl || schema?.sourceUrl}
                target="_blank"
                rel="noreferrer"
                className="max-w-full"
              >
                <Badge
                  variant="outline"
                  className="rounded-md max-w-full truncate hover:bg-muted"
                >
                  Source: {data?.sourceFile || schema?.sourceFile}
                </Badge>
              </a>
            ) : (
              <Badge variant="outline" className="rounded-md max-w-full truncate">
                Source: {data?.sourceFile || schema?.sourceFile}
              </Badge>
            )
          ) : null}
          {typeof data?.total === "number" ? (
            <Badge variant="secondary" className="rounded-md">
              {data.total.toLocaleString()} rows
            </Badge>
          ) : null}
        </div>
      </FadeIn>

      {filtersOpen ? (
        <FadeIn>
          <div
            id="lateral-master-filters-popup"
            className="mb-4 rounded-2xl border border-border/70 bg-card px-4 py-3 shadow-sm"
            role="dialog"
            aria-label="Master Sheet filters"
          >
            <div className="mb-2 flex items-center justify-between gap-2">
              <p className="text-sm font-semibold text-foreground">
                Master Sheet filters
              </p>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-8 rounded-lg"
                onClick={() => setFiltersOpen(false)}
                aria-label="Close filters"
              >
                <X className="size-4" />
              </Button>
            </div>
            <LateralMasterFiltersPanel
              schema={schema}
              isLoading={schemaLoading}
              columnFilters={columnFilters}
              textFilters={textFilters}
              dateFilters={dateFilters}
              onToggleColumnValue={toggleColumnValue}
              onClearColumn={clearColumn}
              onTextChange={onTextChange}
              onDateChange={onDateChange}
              onClearAll={clearAllFilters}
            />
          </div>
        </FadeIn>
      ) : null}

      <FadeIn>
        <Card className="rounded-2xl border-border/70">
          <CardHeader className="pb-2">
            <p className="text-sm font-semibold text-foreground">Master Sheet</p>
            <p className="text-xs text-muted-foreground">
              Columns preserve exact Master Sheet names and order.
            </p>
          </CardHeader>
          <CardContent>
            <LateralMasterSheetTable
              headers={data?.headers ?? schema?.headers ?? []}
              rows={data?.rows ?? []}
              total={data?.total ?? 0}
              page={data?.page ?? page}
              pageSize={pageSize}
              pageCount={data?.pageCount ?? 0}
              isLoading={isLoading && !data}
              errorMessage={errorMessage}
              onPageChange={setPage}
              onPageSizeChange={setPageSize}
            />
          </CardContent>
        </Card>
      </FadeIn>
    </PageTransition>
  );
}
