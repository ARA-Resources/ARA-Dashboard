"use client";

import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Download, Loader2, RefreshCw, Search, X } from "lucide-react";
import { PageHeader } from "@/components/layouts/page-header";
import { PageTransition } from "@/animations/page-transition";
import { FadeIn } from "@/animations/fade-in";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
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

/** DD/MM/YYYY , HH:MM:SS am/pm (12h, zero-padded). */
function formatLastRunDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  let hours = d.getHours();
  const minutes = String(d.getMinutes()).padStart(2, "0");
  const seconds = String(d.getSeconds()).padStart(2, "0");
  const ampm = hours >= 12 ? "pm" : "am";
  hours = hours % 12;
  if (hours === 0) hours = 12;
  const hh = String(hours).padStart(2, "0");
  return `${dd}/${mm}/${yyyy} , ${hh}:${minutes}:${seconds} ${ampm}`;
}

function formatLastRunTrigger(trigger: string): "manual" | "auto" {
  return trigger === "scheduler" ? "auto" : "manual";
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
  const [searchInput, setSearchInput] = React.useState("");
  const [refreshing, setRefreshing] = React.useState(false);
  const [downloading, setDownloading] = React.useState(false);
  const [downloadError, setDownloadError] = React.useState<string | null>(null);
  const [searchOpen, setSearchOpen] = React.useState(false);
  const searchInputRef = React.useRef<HTMLInputElement>(null);

  const debouncedTextFilters = useDebouncedValue(textFilters, 450);
  const debouncedDateFilters = useDebouncedValue(dateFilters, 450);
  const debouncedSearch = useDebouncedValue(searchInput, 450);

  const query: LateralMasterSheetClientQuery = React.useMemo(
    () => ({
      page,
      pageSize,
      columnFilters,
      textFilters: debouncedTextFilters,
      dateFilters: debouncedDateFilters,
      search: debouncedSearch.trim() || undefined,
    }),
    [
      page,
      pageSize,
      columnFilters,
      debouncedTextFilters,
      debouncedDateFilters,
      debouncedSearch,
    ]
  );

  const {
    data: schema,
    isLoading: schemaLoading,
    error: schemaError,
  } = useLateralMasterFilterSchema();

  const { data, isLoading, isFetching, error } = useLateralMasterSheet(query);

  React.useEffect(() => {
    setPage(1);
  }, [
    columnFilters,
    debouncedTextFilters,
    debouncedDateFilters,
    debouncedSearch,
    pageSize,
  ]);

  React.useEffect(() => {
    if (searchOpen) {
      window.setTimeout(() => searchInputRef.current?.focus(), 0);
    }
  }, [searchOpen]);

  const activeFilterCount =
    Object.values(columnFilters).filter((v) => v.length > 0).length +
    Object.values(textFilters).filter((v) => v.trim()).length +
    Object.values(dateFilters).filter((v) => v.from || v.to).length;

  const activeFilterSummary = React.useMemo(() => {
    const chips: string[] = [];
    for (const [col, values] of Object.entries(columnFilters)) {
      if (values.length > 0) {
        chips.push(`${col}: ${values.slice(0, 2).join(", ")}${values.length > 2 ? ` +${values.length - 2}` : ""}`);
      }
    }
    for (const [col, value] of Object.entries(textFilters)) {
      if (value.trim()) chips.push(`${col}: “${value.trim()}”`);
    }
    for (const [col, range] of Object.entries(dateFilters)) {
      if (range.from || range.to) {
        chips.push(`${col}: ${range.from ?? "…"} → ${range.to ?? "…"}`);
      }
    }
    return chips;
  }, [columnFilters, textFilters, dateFilters]);

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
        ? current.filter((v) => v !== value)
        : [...current, value];
      if (next.length === 0) {
        const { [column]: _, ...rest } = prev;
        return rest;
      }
      return { ...prev, [column]: next };
    });
  }

  function clearColumn(column: string) {
    setColumnFilters((prev) => {
      const { [column]: _, ...rest } = prev;
      return rest;
    });
  }

  function onTextChange(column: string, value: string) {
    setTextFilters((prev) => {
      if (!value.trim()) {
        const { [column]: _, ...rest } = prev;
        return rest;
      }
      return { ...prev, [column]: value };
    });
  }

  function onDateChange(column: string, next: LateralMasterDateFilter) {
    setDateFilters((prev) => {
      if (!next.from && !next.to) {
        const { [column]: _, ...rest } = prev;
        return rest;
      }
      return { ...prev, [column]: next };
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
              variant={searchOpen || searchInput.trim() ? "default" : "outline"}
              className={cn(
                "rounded-xl gap-2",
                (searchOpen || searchInput.trim()) &&
                  "bg-primary text-primary-foreground"
              )}
              onClick={() => setSearchOpen((open) => !open)}
              aria-expanded={searchOpen}
              aria-controls="lateral-master-search-popup"
            >
              <Search className="size-4" />
              Search
              {searchInput.trim() ? (
                <Badge
                  variant="secondary"
                  className={cn(
                    "rounded-md px-1.5",
                    (searchOpen || searchInput.trim()) &&
                      "bg-background/20 text-primary-foreground"
                  )}
                >
                  1
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
          {data?.sourceFile || schema?.sourceFile ? (
            data?.sourceUrl || schema?.sourceUrl ? (
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

      {schema?.lastRun ? (
        <FadeIn>
          <div
            className={cn(
              "mb-3 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 rounded-lg border px-2.5 py-1 text-[11px] leading-snug text-muted-foreground",
              schema.lastRun.result === "success"
                ? "border-border/60 bg-muted/30"
                : schema.lastRun.result === "partial"
                  ? "border-amber-500/25 bg-amber-500/5"
                  : "border-destructive/25 bg-destructive/5"
            )}
            role="status"
            aria-label="Last Lateral Run All status"
          >
            <span>
              Last Run All:{" "}
              <span
                className={cn(
                  "font-medium",
                  schema.lastRun.result === "failed"
                    ? "text-destructive"
                    : "text-foreground/80"
                )}
              >
                {schema.lastRun.result === "success"
                  ? "Success"
                  : schema.lastRun.result === "partial"
                    ? "Partial"
                    : "Failed"}
              </span>
              {" · "}
              {formatLastRunDateTime(schema.lastRun.ranAt)}
              {" · "}
              {formatLastRunTrigger(schema.lastRun.trigger)}
            </span>
            {schema.lastRun.adhocDsDateLabel ? (
              <span className="opacity-80">{schema.lastRun.adhocDsDateLabel}</span>
            ) : null}
            {schema.lastRun.failureReason ? (
              <span className="w-full text-[10px] text-destructive/90">
                {schema.lastRun.failureReason.slice(0, 180)}
              </span>
            ) : null}
          </div>
        </FadeIn>
      ) : null}

      {searchOpen ? (
        <FadeIn>
          <div
            id="lateral-master-search-popup"
            className="mb-4 rounded-2xl border border-border/70 bg-card px-4 py-3 shadow-sm"
            role="search"
            aria-label="Master Sheet search"
          >
            <div className="mb-2 flex items-center justify-between gap-2">
              <p className="text-sm font-semibold text-foreground">Search</p>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-8 rounded-lg"
                onClick={() => setSearchOpen(false)}
                aria-label="Close search"
              >
                <X className="size-4" />
              </Button>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <Input
                ref={searchInputRef}
                type="search"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                placeholder="JR ID, skills, location, JD…"
                className="rounded-xl"
                aria-label="Search Master Sheet"
              />
              {searchInput.trim() ? (
                <Button
                  type="button"
                  variant="ghost"
                  className="shrink-0 rounded-xl"
                  onClick={() => setSearchInput("")}
                >
                  Clear
                </Button>
              ) : null}
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              Searches Job Requisition ID, skills, description, location, and
              other text columns (server-side).
            </p>
          </div>
        </FadeIn>
      ) : null}

      {activeFilterCount > 0 ? (
        <FadeIn>
          <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-primary/20 bg-primary/5 px-3 py-1.5 text-xs">
            <span className="font-medium text-primary">
              {activeFilterCount} column{activeFilterCount === 1 ? "" : "s"}{" "}
              filtered
            </span>
            {activeFilterSummary.map((chip) => (
              <span key={chip} className="text-muted-foreground">
                {chip}
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

      {errorMessage ? (
        <FadeIn>
          <div className="mb-4 rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {errorMessage}
          </div>
        </FadeIn>
      ) : null}

      <FadeIn>
        <Card className="overflow-hidden border-border/70 shadow-sm">
          <CardHeader className="sr-only">Master Sheet table</CardHeader>
          <CardContent className="p-0">
            <LateralMasterSheetTable
              headers={data?.headers ?? []}
              rows={data?.rows ?? []}
              total={data?.total ?? 0}
              page={page}
              pageSize={pageSize}
              pageCount={data?.pageCount ?? 1}
              isLoading={isLoading || schemaLoading}
              isFetching={isFetching}
              errorMessage={
                error instanceof Error
                  ? error.message
                  : schemaError instanceof Error
                    ? schemaError.message
                    : null
              }
              onPageChange={setPage}
              onPageSizeChange={setPageSize}
              filterSchema={schema}
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
