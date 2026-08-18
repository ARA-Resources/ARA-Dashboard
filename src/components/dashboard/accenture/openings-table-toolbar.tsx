"use client";

import { Filter, RefreshCw, Search, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { OpeningsFilterPanel } from "@/components/dashboard/accenture/openings-filter-panel";
import { OpeningsQuickFilters } from "@/components/dashboard/accenture/openings-quick-filters";
import { getQuickFilterColumns } from "@/constants/quick-filters";
import type { DynamicFilterSchema } from "@/services/excel/discover-filters";
import type { OpeningsFilters } from "@/types/filters";
import { countActiveColumnFilters } from "@/services/excel/apply-filters";
import { cn } from "@/lib/utils";

interface OpeningsTableToolbarProps {
  title: string;
  search: string;
  onSearchChange: (value: string) => void;
  onRefresh: () => void;
  onExport: () => void;
  refreshing?: boolean;
  schema: DynamicFilterSchema | undefined;
  schemaLoading?: boolean;
  schemaError?: string | null;
  filters: OpeningsFilters;
  defaultFilters: OpeningsFilters;
  usingDefaults: boolean;
  availableSortColumns: string[];
  onToggleColumnValue: (column: string, value: string) => void;
  onClearColumn: (column: string) => void;
  onSortByChange: (sortBy: string | null) => void;
  onSortDirectionChange: (direction: "asc" | "desc") => void;
  onTopNChange: (topN: number | null) => void;
  onResetDefaults: () => void;
  onClearFilters: () => void;
}

export function OpeningsTableToolbar({
  title,
  search,
  onSearchChange,
  onRefresh,
  onExport,
  refreshing = false,
  schema,
  schemaLoading = false,
  schemaError = null,
  filters,
  defaultFilters,
  usingDefaults,
  availableSortColumns,
  onToggleColumnValue,
  onClearColumn,
  onSortByChange,
  onSortDirectionChange,
  onTopNChange,
  onResetDefaults,
  onClearFilters,
}: OpeningsTableToolbarProps) {
  const quickColumns = getQuickFilterColumns(schema);
  const allFiltersActiveCount = countSheetFilters(filters, quickColumns);

  return (
    <div className="flex w-full flex-col gap-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="shrink-0 text-lg font-semibold text-primary md:text-xl">
          {title}
        </h2>

        <div className="flex flex-wrap items-center gap-2 sm:justify-end">
          <div className="relative min-w-48 flex-1 sm:w-64 sm:flex-none">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => onSearchChange(e.target.value)}
              placeholder="Search openings…"
              aria-label="Search openings"
              className="h-9 rounded-xl pl-8"
            />
          </div>

          <Button
            variant="outline"
            size="icon"
            className="rounded-xl"
            aria-label="Refresh Excel data"
            title="Reload openings from Excel"
            onClick={onRefresh}
            disabled={refreshing}
          >
            <RefreshCw className={cn("size-4", refreshing && "animate-spin")} />
          </Button>

          <Button
            variant="secondary"
            className="rounded-xl gap-2"
            onClick={onExport}
          >
            <Download className="size-4" />
            Export
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <OpeningsQuickFilters
          schema={schema}
          filters={filters}
          onToggleColumnValue={onToggleColumnValue}
          onClearColumn={onClearColumn}
        />

        <Sheet>
          <SheetTrigger
            render={
              <Button variant="outline" className="rounded-xl gap-2" />
            }
          >
            <Filter className="size-4 text-primary" />
            All filters
            {allFiltersActiveCount > 0 ? (
              <Badge variant="secondary" className="rounded-md px-1.5">
                {allFiltersActiveCount}
              </Badge>
            ) : null}
          </SheetTrigger>
          <SheetContent
            side="right"
            className="w-full border-l border-border p-0 sm:max-w-md"
          >
            <SheetHeader className="border-b border-border px-4 py-4">
              <SheetTitle className="text-primary">All filters</SheetTitle>
              <SheetDescription>
                Additional filters from the active source sheet
                {schema ? ` (${schema.sheetName})` : ""}. Priority, Skill
                Categorization, Market Map, Job Status, and Posted are on the
                toolbar when present in the sheet.
                {usingDefaults
                  ? " Currently using defaults."
                  : " Custom filters active."}
              </SheetDescription>
            </SheetHeader>
            <OpeningsFilterPanel
              schema={schema}
              schemaLoading={schemaLoading}
              schemaError={schemaError}
              filters={filters}
              defaultFilters={defaultFilters}
              usingDefaults={usingDefaults}
              availableSortColumns={availableSortColumns}
              excludeColumns={quickColumns}
              onToggleColumnValue={onToggleColumnValue}
              onClearColumn={onClearColumn}
              onSortByChange={onSortByChange}
              onSortDirectionChange={onSortDirectionChange}
              onTopNChange={onTopNChange}
              onResetDefaults={onResetDefaults}
              onClearFilters={onClearFilters}
            />
          </SheetContent>
        </Sheet>
      </div>
    </div>
  );
}

function countSheetFilters(
  filters: OpeningsFilters,
  quickColumns: Set<string>,
) {
  const remaining: Record<string, string[]> = {};
  for (const [column, values] of Object.entries(filters.columnFilters)) {
    if (quickColumns.has(column)) continue;
    remaining[column] = values;
  }

  return (
    countActiveColumnFilters(remaining) +
    (filters.sortBy ? 1 : 0) +
    (filters.topN !== null ? 1 : 0)
  );
}
