"use client";

import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, RefreshCw, X } from "lucide-react";
import { PageHeader } from "@/components/layouts/page-header";
import { PageTransition } from "@/animations/page-transition";
import { FadeIn } from "@/animations/fade-in";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { CandidateMasterSheetTable } from "@/components/dashboard/accenture/candidate/candidate-master-sheet-table";
import { MasterSheetPaginationBar } from "@/components/dashboard/accenture/master-sheet-pagination-bar";
import {
  DEFAULT_CANDIDATE_MASTER_PAGE_SIZE,
  CANDIDATE_MASTER_PAGE_SIZE_OPTIONS,
  type CandidateMasterDateFilter,
  type CandidateMasterPageSize,
} from "@/services/excel/candidate-master-sheet";
import {
  fetchCandidateMasterFilterSchema,
  fetchCandidateMasterSheet,
  candidateMasterSchemaQueryKey,
  candidateMasterSheetQueryKey,
  useCandidateMasterFilterSchema,
  useCandidateMasterSheet,
  type CandidateMasterSheetClientQuery,
} from "@/hooks/use-candidate-master-sheet";

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = React.useState(value);
  React.useEffect(() => {
    const id = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(id);
  }, [value, delayMs]);
  return debounced;
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
  const [refreshing, setRefreshing] = React.useState(false);

  const debouncedTextFilters = useDebouncedValue(textFilters, 450);
  const debouncedDateFilters = useDebouncedValue(dateFilters, 450);

  const query: CandidateMasterSheetClientQuery = React.useMemo(
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
  } = useCandidateMasterFilterSchema();

  const { data, isLoading, isFetching, error } = useCandidateMasterSheet(query);

  React.useEffect(() => {
    setPage(1);
  }, [columnFilters, debouncedTextFilters, debouncedDateFilters, pageSize]);

  const activeFilterCount =
    Object.values(columnFilters).filter((v) => v.length > 0).length +
    Object.values(textFilters).filter((v) => v.trim()).length +
    Object.values(dateFilters).filter((v) => v.from || v.to).length;

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

  function clearAllFilters() {
    setColumnFilters({});
    setTextFilters({});
    setDateFilters({});
  }

  const errorMessage =
    error instanceof Error
      ? error.message
      : schemaError instanceof Error
        ? schemaError.message
        : null;

  return (
    <PageTransition>
      <PageHeader
        title="Candidates"
        description="Candidate Master Sheet from PostgreSQL (candidate_master)."
        actions={
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
              {activeFilterCount} column{activeFilterCount === 1 ? "" : "s"} filtered
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
              isLoading={(isLoading || schemaLoading) && !data}
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
