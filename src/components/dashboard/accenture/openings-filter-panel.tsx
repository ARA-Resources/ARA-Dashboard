"use client";

import * as React from "react";
import { ChevronDown, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import type { DynamicFilterField, DynamicFilterSchema } from "@/services/excel/discover-filters";
import type { OpeningsFilters } from "@/types/filters";
import { TOP_N_OPTIONS } from "@/types/filters";
import { cn } from "@/lib/utils";

interface ColumnFilterSectionProps {
  field: DynamicFilterField;
  selected: string[];
  onToggle: (value: string) => void;
  onClear: () => void;
}

function ColumnFilterSection({
  field,
  selected,
  onToggle,
  onClear,
}: ColumnFilterSectionProps) {
  const [open, setOpen] = React.useState(selected.length > 0);
  const [query, setQuery] = React.useState("");

  const filteredValues = React.useMemo(() => {
    if (!query.trim()) return field.values;
    const q = query.toLowerCase();
    return field.values.filter((value) => value.toLowerCase().includes(q));
  }, [field.values, query]);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="rounded-xl border border-border bg-card">
        <CollapsibleTrigger className="flex w-full items-center gap-2 px-3 py-2.5 text-left">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-primary">
              {field.column}
            </p>
            <p className="text-[11px] text-muted-foreground">
              {field.valueCount} values
              {selected.length > 0 ? ` · ${selected.length} selected` : ""}
            </p>
          </div>
          {selected.length > 0 ? (
            <Badge variant="secondary" className="rounded-md">
              {selected.length}
            </Badge>
          ) : null}
          <ChevronDown
            className={cn(
              "size-4 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-180"
            )}
          />
        </CollapsibleTrigger>

        <CollapsibleContent>
          <div className="space-y-2 border-t border-border px-3 py-3">
            {field.values.length > 8 ? (
              <div className="relative">
                <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={`Search ${field.column}…`}
                  className="h-8 rounded-lg pl-8 text-xs"
                />
              </div>
            ) : null}

            <div className="max-h-48 space-y-1 overflow-y-auto pr-1">
              {filteredValues.map((value) => {
                const checked = selected.includes(value);
                const id = `${field.column}-${value}`;
                return (
                  <label
                    key={value}
                    htmlFor={id}
                    className="flex cursor-pointer items-start gap-2 rounded-lg px-1.5 py-1.5 hover:bg-muted/50"
                  >
                    <Checkbox
                      id={id}
                      checked={checked}
                      onCheckedChange={() => onToggle(value)}
                      className="mt-0.5"
                    />
                    <span className="text-sm leading-snug break-words">
                      {value}
                    </span>
                  </label>
                );
              })}
              {filteredValues.length === 0 ? (
                <p className="px-1 py-2 text-xs text-muted-foreground">
                  No matching values
                </p>
              ) : null}
            </div>

            {selected.length > 0 ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 rounded-lg px-2 text-xs"
                onClick={onClear}
              >
                Clear {field.column}
              </Button>
            ) : null}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

interface OpeningsFilterPanelProps {
  schema: DynamicFilterSchema | undefined;
  schemaLoading?: boolean;
  schemaError?: string | null;
  filters: OpeningsFilters;
  defaultFilters: OpeningsFilters;
  usingDefaults: boolean;
  availableSortColumns: string[];
  /** Columns already shown as quick filters — omit from this panel */
  excludeColumns?: Set<string>;
  onToggleColumnValue: (column: string, value: string) => void;
  onClearColumn: (column: string) => void;
  onSortByChange: (sortBy: string | null) => void;
  onSortDirectionChange: (direction: "asc" | "desc") => void;
  onTopNChange: (topN: number | null) => void;
  onResetDefaults: () => void;
  onClearFilters: () => void;
}

export function OpeningsFilterPanel({
  schema,
  schemaLoading = false,
  schemaError = null,
  filters,
  defaultFilters,
  usingDefaults,
  availableSortColumns,
  excludeColumns,
  onToggleColumnValue,
  onClearColumn,
  onSortByChange,
  onSortDirectionChange,
  onTopNChange,
  onResetDefaults,
  onClearFilters,
}: OpeningsFilterPanelProps) {
  const panelFields = React.useMemo(() => {
    if (!schema) return [];
    if (!excludeColumns || excludeColumns.size === 0) return schema.fields;
    return schema.fields.filter((field) => !excludeColumns.has(field.column));
  }, [schema, excludeColumns]);

  const sortColumns = Array.from(
    new Set(
      [...availableSortColumns, filters.sortBy, defaultFilters.sortBy].filter(
        (value): value is string => Boolean(value)
      )
    )
  );

  const defaultChips = Object.entries(defaultFilters.columnFilters).flatMap(
    ([column, values]) => values.map((value) => `${column}: ${value}`)
  );

  return (
    <ScrollArea className="h-[calc(100vh-8rem)]">
      <div className="space-y-4 px-4 pb-6">
        <div className="rounded-xl border border-border bg-muted/30 p-3">
          <p className="mb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Defaults (reference)
          </p>
          <div className="flex flex-wrap gap-1.5">
            {defaultChips.length > 0 ? (
              defaultChips.map((chip) => (
                <Badge key={chip} variant="secondary" className="rounded-lg">
                  {chip}
                </Badge>
              ))
            ) : (
              <Badge variant="outline" className="rounded-lg">
                No column defaults
              </Badge>
            )}
            {defaultFilters.sortBy ? (
              <Badge variant="outline" className="rounded-lg">
                Sort: {defaultFilters.sortBy} {defaultFilters.sortDirection}
              </Badge>
            ) : null}
            <Badge variant="outline" className="rounded-lg">
              Top {defaultFilters.topN ?? "All"}
            </Badge>
          </div>
          {schema ? (
            <p className="mt-2 text-[11px] text-muted-foreground">
              Source: {schema.sheetName} · {panelFields.length} additional
              filterable columns
            </p>
          ) : null}
        </div>

        {schemaLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 5 }).map((_, index) => (
              <Skeleton key={index} className="h-14 w-full rounded-xl" />
            ))}
          </div>
        ) : null}

        {schemaError ? (
          <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
            {schemaError}
          </div>
        ) : null}

        {schema && !schemaLoading
          ? panelFields.map((field) => (
              <ColumnFilterSection
                key={field.column}
                field={field}
                selected={filters.columnFilters[field.column] ?? []}
                onToggle={(value) => onToggleColumnValue(field.column, value)}
                onClear={() => onClearColumn(field.column)}
              />
            ))
          : null}

        {schema && panelFields.length === 0 && !schemaLoading ? (
          <p className="text-sm text-muted-foreground">
            No additional filterable columns — use the toolbar quick filters.
          </p>
        ) : null}

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-xl border border-border bg-card p-3">
            <p className="mb-2 text-sm font-medium text-primary">Sort by</p>
            <Select
              value={filters.sortBy ?? "__none__"}
              onValueChange={(value) =>
                onSortByChange(!value || value === "__none__" ? null : value)
              }
            >
              <SelectTrigger className="h-9 w-full rounded-xl">
                <SelectValue placeholder="No sort" />
              </SelectTrigger>
              <SelectContent className="rounded-xl">
                <SelectItem value="__none__">No sort</SelectItem>
                {sortColumns.map((column) => (
                  <SelectItem key={column} value={column}>
                    {column}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="mt-2 flex gap-2">
              <Button
                type="button"
                size="sm"
                variant={
                  filters.sortDirection === "desc" ? "secondary" : "outline"
                }
                className="rounded-xl"
                onClick={() => onSortDirectionChange("desc")}
              >
                Desc
              </Button>
              <Button
                type="button"
                size="sm"
                variant={
                  filters.sortDirection === "asc" ? "secondary" : "outline"
                }
                className="rounded-xl"
                onClick={() => onSortDirectionChange("asc")}
              >
                Asc
              </Button>
            </div>
          </div>

          <div className="rounded-xl border border-border bg-card p-3">
            <p className="mb-2 text-sm font-medium text-primary">Show</p>
            <Select
              value={filters.topN === null ? "all" : String(filters.topN)}
              onValueChange={(value) => {
                if (!value || value === "all") onTopNChange(null);
                else onTopNChange(Number(value));
              }}
            >
              <SelectTrigger className="h-9 w-full rounded-xl">
                <SelectValue placeholder="Top N" />
              </SelectTrigger>
              <SelectContent className="rounded-xl">
                {TOP_N_OPTIONS.map((option) => (
                  <SelectItem key={option} value={String(option)}>
                    Top {option}
                  </SelectItem>
                ))}
                <SelectItem value="all">All rows</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="secondary"
            className="rounded-xl"
            onClick={onResetDefaults}
            disabled={usingDefaults}
          >
            Reset to defaults
          </Button>
          <Button
            type="button"
            variant="outline"
            className="rounded-xl"
            onClick={onClearFilters}
          >
            Clear filters
          </Button>
        </div>
      </div>
    </ScrollArea>
  );
}
