"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Search, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import type {
  LateralMasterDateFilter,
  LateralMasterFilterField,
  LateralMasterFilterSchema,
} from "@/services/excel/lateral-master-sheet";
import {
  isoDateToDdMmYyyy,
  maskDdMmYyyyInput,
  parseDateInputToIso,
} from "@/utils/excel-display";
import { cn } from "@/lib/utils";

interface LateralMasterFiltersPanelProps {
  schema: LateralMasterFilterSchema | undefined;
  isLoading?: boolean;
  columnFilters: Record<string, string[]>;
  textFilters: Record<string, string>;
  dateFilters: Record<string, LateralMasterDateFilter>;
  onToggleColumnValue: (column: string, value: string) => void;
  onClearColumn: (column: string) => void;
  onTextChange: (column: string, value: string) => void;
  onDateChange: (column: string, range: LateralMasterDateFilter) => void;
  onClearAll: () => void;
}

function fieldActiveCount(
  field: LateralMasterFilterField,
  columnFilters: Record<string, string[]>,
  textFilters: Record<string, string>,
  dateFilters: Record<string, LateralMasterDateFilter>
) {
  if (field.control === "text") {
    return textFilters[field.column]?.trim() ? 1 : 0;
  }
  if (field.control === "date") {
    const range = dateFilters[field.column];
    return range?.from || range?.to ? 1 : 0;
  }
  return columnFilters[field.column]?.length ?? 0;
}

function MultiSelectDropdown({
  field,
  selected,
  searchable,
  onToggle,
  onClear,
}: {
  field: LateralMasterFilterField;
  selected: string[];
  searchable: boolean;
  onToggle: (value: string) => void;
  onClear: () => void;
}) {
  const [query, setQuery] = React.useState("");
  const values = React.useMemo(() => {
    if (!query.trim()) return field.values;
    const q = query.toLowerCase();
    return field.values.filter((value) => value.toLowerCase().includes(q));
  }, [field.values, query]);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={cn(
              "h-9 max-w-55 shrink-0 gap-1.5 rounded-xl",
              selected.length > 0 && "border-primary/40 bg-primary/5"
            )}
          />
        }
      >
        <span className="truncate">{field.column}</span>
        {selected.length > 0 ? (
          <Badge variant="secondary" className="rounded-md px-1.5">
            {selected.length}
          </Badge>
        ) : null}
        <ChevronDown className="size-3.5 shrink-0 opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72 rounded-xl p-0">
        <DropdownMenuLabel className="truncate px-3 py-2">
          {field.column}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {(searchable || field.values.length > 8) && (
          <div className="px-3 pb-2">
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={`Search ${field.column}…`}
                className="h-8 rounded-lg pl-8 text-xs"
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => e.stopPropagation()}
              />
            </div>
          </div>
        )}
        <div className="max-h-56 space-y-0.5 overflow-y-auto px-2 pb-2">
          {values.map((value) => {
            const id = `${field.column}-${value}`;
            return (
              <label
                key={value}
                htmlFor={id}
                className="flex cursor-pointer items-start gap-2 rounded-lg px-2 py-1.5 hover:bg-muted/50"
                onClick={(e) => e.stopPropagation()}
              >
                <Checkbox
                  id={id}
                  checked={selected.includes(value)}
                  onCheckedChange={() => onToggle(value)}
                  className="mt-0.5"
                />
                <span className="text-sm leading-snug wrap-break-word">
                  {value}
                </span>
              </label>
            );
          })}
          {values.length === 0 ? (
            <p className="px-2 py-3 text-xs text-muted-foreground">
              No matching values
            </p>
          ) : null}
        </div>
        {selected.length > 0 ? (
          <>
            <DropdownMenuSeparator />
            <div className="px-2 py-2">
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

function TextDropdown({
  field,
  value,
  onChange,
}: {
  field: LateralMasterFilterField;
  value: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [draft, setDraft] = React.useState(value);
  const rootRef = React.useRef<HTMLDivElement>(null);
  const panelRef = React.useRef<HTMLDivElement>(null);
  const [panelPos, setPanelPos] = React.useState<{ top: number; left: number }>({
    top: 0,
    left: 0,
  });

  React.useEffect(() => {
    setDraft(value);
  }, [value]);

  const updatePosition = React.useCallback(() => {
    const trigger = rootRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const width = 320;
    const left = Math.min(
      Math.max(8, rect.left),
      window.innerWidth - width - 8
    );
    setPanelPos({ top: rect.bottom + 6, left });
  }, []);

  React.useEffect(() => {
    if (!open) return;
    updatePosition();
    function onPointerDown(event: MouseEvent) {
      const target = event.target as Node;
      if (
        rootRef.current?.contains(target) ||
        panelRef.current?.contains(target)
      ) {
        return;
      }
      setOpen(false);
      onChange(draft);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        onChange(draft);
      }
    }
    function onReposition() {
      updatePosition();
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", onReposition);
    window.addEventListener("scroll", onReposition, true);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onReposition);
      window.removeEventListener("scroll", onReposition, true);
    };
  }, [open, draft, onChange, updatePosition]);

  function commitDraft(next: string) {
    setDraft(next);
    onChange(next);
  }

  const panel =
    open && typeof document !== "undefined"
      ? createPortal(
          <div
            ref={panelRef}
            style={{ top: panelPos.top, left: panelPos.left }}
            className="fixed z-200 w-80 rounded-xl border border-border bg-popover p-3 text-popover-foreground shadow-lg"
          >
            <p className="mb-2 text-xs font-medium text-muted-foreground">
              {field.column}
            </p>
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={draft}
                onChange={(e) => commitDraft(e.target.value)}
                placeholder="Search phrase or skills…"
                className="h-8 rounded-lg pl-8 text-xs"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    onChange(draft);
                    setOpen(false);
                  }
                }}
              />
            </div>
            <p className="mt-2 text-[10px] leading-snug text-muted-foreground">
              Searches the full phrase. For multiple skills use commas — e.g.{" "}
              <span className="font-medium text-secondary">Python, AWS</span>
            </p>
            {draft.trim() ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="mt-2 h-7 w-full rounded-lg text-xs"
                onClick={() => commitDraft("")}
              >
                Clear
              </Button>
            ) : null}
          </div>,
          document.body
        )
      : null;

  return (
    <div ref={rootRef} className="relative shrink-0">
      <Button
        type="button"
        variant="outline"
        size="sm"
        aria-expanded={open}
        className={cn(
          "h-9 max-w-55 shrink-0 gap-1.5 rounded-xl",
          value.trim() && "border-primary/40 bg-primary/5"
        )}
        onClick={() => {
          setDraft(value);
          setOpen((prev) => !prev);
        }}
      >
        <span className="truncate">{field.column}</span>
        {value.trim() ? (
          <Badge variant="secondary" className="rounded-md px-1.5">
            1
          </Badge>
        ) : null}
        <ChevronDown
          className={cn(
            "size-3.5 shrink-0 opacity-60 transition-transform",
            open && "rotate-180"
          )}
        />
      </Button>
      {panel}
    </div>
  );
}

function DateTextField({
  id,
  label,
  isoValue,
  onIsoChange,
}: {
  id: string;
  label: string;
  /** Stored as YYYY-MM-DD for the filter API */
  isoValue?: string;
  onIsoChange: (iso: string | undefined) => void;
}) {
  const [text, setText] = React.useState(() => isoDateToDdMmYyyy(isoValue));
  const [invalid, setInvalid] = React.useState(false);

  React.useEffect(() => {
    setText(isoDateToDdMmYyyy(isoValue));
    setInvalid(false);
  }, [isoValue]);

  function commit(nextText: string) {
    const trimmed = nextText.trim();
    if (!trimmed) {
      setInvalid(false);
      onIsoChange(undefined);
      return;
    }
    const iso = parseDateInputToIso(trimmed);
    if (!iso) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    setText(isoDateToDdMmYyyy(iso));
    onIsoChange(iso);
  }

  return (
    <div>
      <label
        htmlFor={id}
        className="mb-1 block text-[11px] text-muted-foreground"
      >
        {label}
      </label>
      <Input
        id={id}
        type="text"
        inputMode="numeric"
        placeholder="DD-MM-YYYY"
        value={text}
        aria-invalid={invalid || undefined}
        onChange={(e) => {
          const masked = maskDdMmYyyyInput(e.target.value);
          setText(masked);
          setInvalid(false);
          if (!masked) {
            onIsoChange(undefined);
            return;
          }
          if (masked.length === 10) {
            const iso = parseDateInputToIso(masked);
            if (iso) {
              onIsoChange(iso);
              setInvalid(false);
            } else {
              setInvalid(true);
            }
          }
        }}
        onBlur={() => commit(text)}
        className={cn(
          "h-8 rounded-lg text-xs tabular-nums",
          invalid && "border-destructive focus-visible:ring-destructive/30"
        )}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") {
            e.preventDefault();
            commit(text);
          }
        }}
      />
    </div>
  );
}

function DateDropdown({
  field,
  value,
  onChange,
}: {
  field: LateralMasterFilterField;
  value: LateralMasterDateFilter;
  onChange: (range: LateralMasterDateFilter) => void;
}) {
  const active = Boolean(value.from || value.to);
  const fieldKey = field.column.replace(/\s+/g, "-").toLowerCase();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={cn(
              "h-9 max-w-55 shrink-0 gap-1.5 rounded-xl",
              active && "border-primary/40 bg-primary/5"
            )}
          />
        }
      >
        <span className="truncate">{field.column}</span>
        {active ? (
          <Badge variant="secondary" className="rounded-md px-1.5">
            1
          </Badge>
        ) : null}
        <ChevronDown className="size-3.5 shrink-0 opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72 rounded-xl p-3">
        <p className="mb-2 text-xs font-medium text-muted-foreground">
          {field.column}
        </p>
        <div className="grid grid-cols-2 gap-2">
          <DateTextField
            id={`${fieldKey}-from`}
            label="From"
            isoValue={value.from}
            onIsoChange={(from) => onChange({ ...value, from })}
          />
          <DateTextField
            id={`${fieldKey}-to`}
            label="To"
            isoValue={value.to}
            onIsoChange={(to) => onChange({ ...value, to })}
          />
        </div>
        <p className="mt-2 text-[10px] text-muted-foreground">
          Format: DD-MM-YYYY
        </p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Horizontal filter chips for the top popup bar. */
export function LateralMasterFiltersPanel({
  schema,
  isLoading,
  columnFilters,
  textFilters,
  dateFilters,
  onToggleColumnValue,
  onClearColumn,
  onTextChange,
  onDateChange,
  onClearAll,
}: LateralMasterFiltersPanelProps) {
  const activeCount = React.useMemo(() => {
    if (!schema) return 0;
    return schema.fields.reduce(
      (sum, field) =>
        sum +
        (fieldActiveCount(field, columnFilters, textFilters, dateFilters) > 0
          ? 1
          : 0),
      0
    );
  }, [schema, columnFilters, textFilters, dateFilters]);

  if (isLoading) {
    return (
      <div className="flex gap-2 overflow-x-auto pb-1">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-9 w-28 shrink-0 rounded-xl" />
        ))}
      </div>
    );
  }

  if (!schema?.fields.length) {
    return (
      <p className="text-sm text-muted-foreground">
        No filterable Master Sheet columns found.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          Filters from Master Sheet headers
          {activeCount > 0 ? ` · ${activeCount} active` : ""}
        </p>
        {activeCount > 0 ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 gap-1 rounded-lg px-2 text-xs"
            onClick={onClearAll}
          >
            <X className="size-3.5" />
            Clear all
          </Button>
        ) : null}
      </div>

      <div className="flex items-center gap-2 overflow-x-auto pb-1">
        {schema.fields.map((field) => {
          if (field.control === "text") {
            return (
              <TextDropdown
                key={field.column}
                field={field}
                value={textFilters[field.column] ?? ""}
                onChange={(value) => onTextChange(field.column, value)}
              />
            );
          }
          if (field.control === "date") {
            return (
              <DateDropdown
                key={field.column}
                field={field}
                value={dateFilters[field.column] ?? {}}
                onChange={(range) => onDateChange(field.column, range)}
              />
            );
          }
          return (
            <MultiSelectDropdown
              key={field.column}
              field={field}
              selected={columnFilters[field.column] ?? []}
              searchable={field.control === "searchable-multi-select"}
              onToggle={(value) => onToggleColumnValue(field.column, value)}
              onClear={() => onClearColumn(field.column)}
            />
          );
        })}
      </div>
    </div>
  );
}
