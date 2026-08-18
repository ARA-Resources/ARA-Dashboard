"use client";

import * as React from "react";
import { ChevronDown, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { resolveQuickFilters } from "@/constants/quick-filters";
import type { DynamicFilterSchema } from "@/services/excel/discover-filters";
import type { OpeningsFilters } from "@/types/filters";
import { cn } from "@/lib/utils";

interface OpeningsQuickFiltersProps {
  schema: DynamicFilterSchema | undefined;
  filters: OpeningsFilters;
  onToggleColumnValue: (column: string, value: string) => void;
  onClearColumn: (column: string) => void;
  className?: string;
}

function QuickFilterDropdown({
  label,
  column,
  values,
  selected,
  onToggle,
  onClear,
}: {
  label: string;
  column: string;
  values: string[];
  selected: string[];
  onToggle: (value: string) => void;
  onClear: () => void;
}) {
  const [query, setQuery] = React.useState("");
  const filtered = React.useMemo(() => {
    if (!query.trim()) return values;
    const q = query.toLowerCase();
    return values.filter((value) => value.toLowerCase().includes(q));
  }, [values, query]);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="outline"
            className={cn(
              "h-9 max-w-full gap-1.5 rounded-xl px-3",
              selected.length > 0 && "border-primary/40 bg-primary/5",
            )}
          />
        }
      >
        <span className="truncate text-sm">{label}</span>
        {selected.length > 0 ? (
          <Badge variant="secondary" className="rounded-md px-1.5">
            {selected.length}
          </Badge>
        ) : null}
        <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="w-64 max-w-[min(20rem,calc(100vw-2rem))]"
      >
        <DropdownMenuGroup>
          <DropdownMenuLabel className="truncate">{column}</DropdownMenuLabel>
        </DropdownMenuGroup>
        {values.length > 8 ? (
          <div className="relative px-1.5 pb-1.5">
            <Search className="pointer-events-none absolute top-1/2 left-3.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`Search ${label}…`}
              className="h-8 rounded-lg pl-8 text-xs"
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
            />
          </div>
        ) : null}
        <div className="max-h-56 overflow-y-auto">
          {filtered.map((value) => (
            <DropdownMenuCheckboxItem
              key={value}
              checked={selected.includes(value)}
              onCheckedChange={() => onToggle(value)}
              className="items-start whitespace-normal"
            >
              <span className="leading-snug wrap-break-word">{value}</span>
            </DropdownMenuCheckboxItem>
          ))}
          {filtered.length === 0 ? (
            <p className="px-2 py-2 text-xs text-muted-foreground">
              No matching values
            </p>
          ) : null}
        </div>
        {selected.length > 0 ? (
          <>
            <DropdownMenuSeparator />
            <button
              type="button"
              className="flex w-full cursor-pointer rounded-md px-1.5 py-1.5 text-left text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              onClick={onClear}
            >
              Clear {label}
            </button>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function OpeningsQuickFilters({
  schema,
  filters,
  onToggleColumnValue,
  onClearColumn,
  className,
}: OpeningsQuickFiltersProps) {
  const quickFilters = resolveQuickFilters(schema);

  if (quickFilters.length === 0) return null;

  return (
    <div className={cn("flex min-w-0 flex-1 flex-wrap items-center gap-2", className)}>
      {quickFilters.map(({ def, field }) => (
        <QuickFilterDropdown
          key={field.column}
          label={def.label}
          column={field.column}
          values={field.values}
          selected={filters.columnFilters[field.column] ?? []}
          onToggle={(value) => onToggleColumnValue(field.column, value)}
          onClear={() => onClearColumn(field.column)}
        />
      ))}
    </div>
  );
}
