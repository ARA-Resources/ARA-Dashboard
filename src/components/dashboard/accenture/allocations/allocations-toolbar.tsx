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
import { cn } from "@/lib/utils";

export interface AllocationsToolbarProps {
  search: string;
  onSearchChange: (value: string) => void;
  primarySkills: string[];
  onPrimarySkillsChange: (value: string[]) => void;
  recruiters: string[];
  onRecruitersChange: (value: string[]) => void;
  statuses: string[];
  onStatusesChange: (value: string[]) => void;
  priorities: string[];
  onPrioritiesChange: (value: string[]) => void;
  primarySkillOptions: string[];
  recruiterOptions: string[];
  statusOptions: string[];
  priorityOptions: string[];
  className?: string;
}

function toggleValue(selected: string[], value: string) {
  return selected.includes(value)
    ? selected.filter((item) => item !== value)
    : [...selected, value];
}

function MultiFilterDropdown({
  label,
  options,
  selected,
  onChange,
  searchable = false,
}: {
  label: string;
  options: string[];
  selected: string[];
  onChange: (value: string[]) => void;
  searchable?: boolean;
}) {
  const [query, setQuery] = React.useState("");
  const filtered = React.useMemo(() => {
    if (!query.trim()) return options;
    const q = query.toLowerCase();
    return options.filter((option) => option.toLowerCase().includes(q));
  }, [options, query]);

  const summary =
    selected.length === 0
      ? label
      : selected.length === 1
        ? selected[0]
        : `${label} (${selected.length})`;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="outline"
            aria-label={label}
            className={cn(
              "h-9 min-w-[10rem] flex-1 justify-between gap-1.5 rounded-xl px-3 sm:flex-none sm:w-44",
              selected.length > 0 && "border-primary/40 bg-primary/5"
            )}
          />
        }
      >
        <span className="truncate text-sm">{summary}</span>
        <span className="flex shrink-0 items-center gap-1">
          {selected.length > 1 ? (
            <Badge variant="secondary" className="rounded-md px-1.5">
              {selected.length}
            </Badge>
          ) : null}
          <ChevronDown className="size-3.5 text-muted-foreground" />
        </span>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="w-64 max-w-[min(20rem,calc(100vw-2rem))]"
      >
        <DropdownMenuGroup>
          <DropdownMenuLabel>{label}</DropdownMenuLabel>
        </DropdownMenuGroup>
        {searchable && options.length > 8 ? (
          <div className="relative px-1.5 pb-1.5">
            <Search className="pointer-events-none absolute top-1/2 left-3.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={`Search ${label.toLowerCase()}…`}
              className="h-8 rounded-lg pl-8 text-xs"
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => event.stopPropagation()}
            />
          </div>
        ) : null}
        <div className="max-h-56 overflow-y-auto">
          {filtered.map((option) => (
            <DropdownMenuCheckboxItem
              key={option}
              checked={selected.includes(option)}
              onCheckedChange={() => onChange(toggleValue(selected, option))}
              className="items-start whitespace-normal"
            >
              <span className="leading-snug wrap-break-word">{option}</span>
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
              onClick={() => onChange([])}
            >
              Clear {label.toLowerCase()}
            </button>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function AllocationsToolbar({
  search,
  onSearchChange,
  primarySkills,
  onPrimarySkillsChange,
  recruiters,
  onRecruitersChange,
  statuses,
  onStatusesChange,
  priorities,
  onPrioritiesChange,
  primarySkillOptions,
  recruiterOptions,
  statusOptions,
  priorityOptions,
  className,
}: AllocationsToolbarProps) {
  return (
    <div
      className={cn(
        "flex flex-col gap-2 rounded-2xl border border-border bg-card p-3 sm:flex-row sm:flex-wrap sm:items-center",
        className
      )}
    >
      <div className="relative min-w-48 flex-1 sm:max-w-xs">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="Search skills, recruiters…"
          aria-label="Search allocations"
          className="h-9 rounded-xl pl-8"
        />
      </div>

      <MultiFilterDropdown
        label="Primary skills"
        options={primarySkillOptions}
        selected={primarySkills}
        onChange={onPrimarySkillsChange}
        searchable
      />
      <MultiFilterDropdown
        label="Recruiters"
        options={recruiterOptions}
        selected={recruiters}
        onChange={onRecruitersChange}
        searchable
      />
      <MultiFilterDropdown
        label="Status"
        options={statusOptions}
        selected={statuses}
        onChange={onStatusesChange}
      />
      <MultiFilterDropdown
        label="Priorities"
        options={priorityOptions}
        selected={priorities}
        onChange={onPrioritiesChange}
      />
    </div>
  );
}
