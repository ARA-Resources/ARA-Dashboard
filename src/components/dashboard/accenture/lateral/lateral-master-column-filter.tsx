"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { ListFilter, Search } from "lucide-react";
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
import type {
  LateralMasterDateFilter,
  LateralMasterFilterField,
} from "@/services/excel/lateral-master-sheet";
import {
  isoDateToDdMmYyyy,
  maskDdMmYyyyInput,
  parseDateInputToIso,
} from "@/utils/excel-display";
import { cn } from "@/lib/utils";

/**
 * Excel-style per-column-header filter.
 *
 * Reuses the three filter shapes the Master Sheet already supports
 * (checkbox multi-select, free-text "contains", date range) but renders them
 * from a compact icon trigger anchored inside the column header, instead of a
 * separate slide-out panel. State still lives in LateralMasterSheetPage.
 */
interface LateralMasterColumnFilterProps {
  field: LateralMasterFilterField;
  selectedValues: string[];
  textValue: string;
  dateValue: LateralMasterDateFilter;
  onToggleValue: (value: string) => void;
  onClearColumn: () => void;
  onTextChange: (value: string) => void;
  onDateChange: (range: LateralMasterDateFilter) => void;
}

function triggerClassName(active: boolean) {
  return cn(
    "relative size-6 shrink-0 rounded-md text-muted-foreground hover:text-foreground",
    active && "bg-primary/10 text-primary hover:text-primary"
  );
}

/**
 * Excel-style: a header filter dropdown closes as soon as the user scrolls the
 * table (so a popup can never drift away from — or get clipped off from — the
 * column header it belongs to).
 *
 * We listen for `wheel` / `touchmove` — genuine user scroll gestures — NOT
 * `scroll`. The browser also fires `scroll` for layout shifts and scroll
 * anchoring, which happens on every filtered re-render; keying off `scroll`
 * would slam the dropdown shut the instant the user ticks a checkbox.
 */
function useCloseOnTableScroll(open: boolean, close: () => void) {
  React.useEffect(() => {
    if (!open) return;
    const onGesture = (e: Event) => {
      const t = e.target as HTMLElement | null;
      if (t && t.closest?.('[data-slot="table-container"]')) close();
    };
    window.addEventListener("wheel", onGesture, true);
    window.addEventListener("touchmove", onGesture, true);
    return () => {
      window.removeEventListener("wheel", onGesture, true);
      window.removeEventListener("touchmove", onGesture, true);
    };
  }, [open, close]);
}

/** Icon + active indicator — used as the children of the trigger button. */
function TriggerContent({ active, count }: { active: boolean; count?: number }) {
  return (
    <>
      <ListFilter className="size-3.5" />
      {active ? (
        count && count > 1 ? (
          <span className="absolute -top-1 -right-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-primary px-0.5 text-[9px] font-semibold text-primary-foreground">
            {count}
          </span>
        ) : (
          <span className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-primary" />
        )
      ) : null}
    </>
  );
}

function MultiSelectHeaderFilter({
  field,
  selected,
  onToggle,
  onClear,
}: {
  field: LateralMasterFilterField;
  selected: string[];
  onToggle: (value: string) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const close = React.useCallback(() => setOpen(false), []);
  useCloseOnTableScroll(open, close);
  const values = React.useMemo(() => {
    if (!query.trim()) return field.values;
    const q = query.toLowerCase();
    return field.values.filter((value) => value.toLowerCase().includes(q));
  }, [field.values, query]);

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        aria-label={`Filter ${field.column}`}
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={triggerClassName(selected.length > 0)}
          />
        }
      >
        <TriggerContent active={selected.length > 0} count={selected.length} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64 rounded-xl p-0">
        <DropdownMenuLabel className="truncate px-3 py-2 text-xs">
          {field.column}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {field.values.length > 6 ? (
          <div className="px-2 pb-2 pt-1">
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
        ) : null}
        <div className="max-h-64 space-y-0.5 overflow-y-auto px-2 pb-2">
          {values.map((value) => {
            const id = `hdr-${field.column}-${value}`;
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

function TextHeaderFilter({
  field,
  value,
  onChange,
}: {
  field: LateralMasterFilterField;
  value: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const rootRef = React.useRef<HTMLSpanElement>(null);
  const panelRef = React.useRef<HTMLDivElement>(null);
  const [pos, setPos] = React.useState<{ top: number; left: number }>({
    top: 0,
    left: 0,
  });

  useCloseOnTableScroll(
    open,
    React.useCallback(() => setOpen(false), [])
  );

  const updatePosition = React.useCallback(() => {
    const el = rootRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const width = 300;
    const left = Math.min(Math.max(8, r.left), window.innerWidth - width - 8);
    setPos({ top: r.bottom + 6, left });
  }, []);

  React.useEffect(() => {
    if (!open) return;
    updatePosition();
    const onPointerDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (rootRef.current?.contains(t) || panelRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    // capture:true so the table's own horizontal scroll repositions the panel
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open, updatePosition]);

  const panel =
    open && typeof document !== "undefined"
      ? createPortal(
          <div
            ref={panelRef}
            style={{ top: pos.top, left: pos.left }}
            className="fixed z-200 w-75 rounded-xl border border-border bg-popover p-3 text-popover-foreground shadow-lg"
          >
            <p className="mb-2 text-xs font-medium text-muted-foreground">
              {field.column}
            </p>
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={value}
                onChange={(e) => onChange(e.target.value)}
                placeholder="Contains text…"
                className="h-8 rounded-lg pl-8 text-xs"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    setOpen(false);
                  }
                }}
              />
            </div>
            <p className="mt-2 text-[10px] leading-snug text-muted-foreground">
              Matches the phrase. For multiple terms use commas — e.g.{" "}
              <span className="font-medium text-secondary">Python, AWS</span>{" "}
              (all must appear).
            </p>
            {value.trim() ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="mt-2 h-7 w-full rounded-lg text-xs"
                onClick={() => onChange("")}
              >
                Clear
              </Button>
            ) : null}
          </div>,
          document.body
        )
      : null;

  return (
    <span ref={rootRef} className="relative inline-flex">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={`Filter ${field.column}`}
        aria-expanded={open}
        className={triggerClassName(value.trim().length > 0)}
        onClick={() => setOpen((p) => !p)}
      >
        <TriggerContent active={value.trim().length > 0} />
      </Button>
      {panel}
    </span>
  );
}

function DateHeaderField({
  id,
  label,
  isoValue,
  onIsoChange,
}: {
  id: string;
  label: string;
  isoValue?: string;
  onIsoChange: (iso: string | undefined) => void;
}) {
  // Seeded from isoValue; the parent remounts this field (via `key`) whenever
  // the external ISO value changes (commit reformat, Clear all), so no
  // prop→state sync effect is needed.
  const [text, setText] = React.useState(() => isoDateToDdMmYyyy(isoValue));
  const [invalid, setInvalid] = React.useState(false);

  function commit(next: string) {
    const trimmed = next.trim();
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
            if (iso) onIsoChange(iso);
            else setInvalid(true);
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

function DateHeaderFilter({
  field,
  value,
  onChange,
}: {
  field: LateralMasterFilterField;
  value: LateralMasterDateFilter;
  onChange: (range: LateralMasterDateFilter) => void;
}) {
  const [open, setOpen] = React.useState(false);
  useCloseOnTableScroll(
    open,
    React.useCallback(() => setOpen(false), [])
  );
  const active = Boolean(value.from || value.to);
  const key = field.column.replace(/\s+/g, "-").toLowerCase();
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        aria-label={`Filter ${field.column}`}
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={triggerClassName(active)}
          />
        }
      >
        <TriggerContent active={active} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64 rounded-xl p-3">
        <p className="mb-2 text-xs font-medium text-muted-foreground">
          {field.column}
        </p>
        <div className="grid grid-cols-2 gap-2">
          <DateHeaderField
            key={value.from ? "from-set" : "from-empty"}
            id={`hdr-${key}-from`}
            label="From"
            isoValue={value.from}
            onIsoChange={(from) => onChange({ ...value, from })}
          />
          <DateHeaderField
            key={value.to ? "to-set" : "to-empty"}
            id={`hdr-${key}-to`}
            label="To"
            isoValue={value.to}
            onIsoChange={(to) => onChange({ ...value, to })}
          />
        </div>
        <p className="mt-2 text-[10px] text-muted-foreground">
          Format: DD-MM-YYYY
        </p>
        {active ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="mt-2 h-7 w-full rounded-lg text-xs"
            onClick={() => onChange({})}
          >
            Clear
          </Button>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function LateralMasterColumnFilter({
  field,
  selectedValues,
  textValue,
  dateValue,
  onToggleValue,
  onClearColumn,
  onTextChange,
  onDateChange,
}: LateralMasterColumnFilterProps) {
  if (field.control === "text") {
    return (
      <TextHeaderFilter
        field={field}
        value={textValue}
        onChange={onTextChange}
      />
    );
  }
  if (field.control === "date") {
    return (
      <DateHeaderFilter
        field={field}
        value={dateValue}
        onChange={onDateChange}
      />
    );
  }
  return (
    <MultiSelectHeaderFilter
      field={field}
      selected={selectedValues}
      onToggle={onToggleValue}
      onClear={onClearColumn}
    />
  );
}
