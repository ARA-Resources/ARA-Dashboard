"use client";

import * as React from "react";
import {
  CalendarClock,
  Pause,
  Pencil,
  Play,
  Plus,
  Trash2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import {
  SCHEDULE_FREQUENCY_LABELS,
  WEEKDAY_LABELS,
  WEEKDAY_SHORT_LABELS,
  DEFAULT_CUSTOM_DAYS,
  DEFAULT_CUSTOM_TIMES,
  type DatasetAutomationScheduleView,
  type MultiSchedulerStatus,
  type ScheduleFrequency,
} from "@/types/dataset-schedule";
import { DATASET_SYNC_NAMES, type DatasetSyncName } from "@/types/dataset-sync";
import {
  EXECUTABLE_DATASET_TYPES,
  isExecutableDatasetType,
} from "@/types/dataset-execution";

interface SchedulesPanelProps {
  scheduler: MultiSchedulerStatus | null;
  onSchedulerChange: (next: MultiSchedulerStatus | null) => void;
  busy?: boolean;
  embedded?: boolean;
}

type ScheduleDraft = {
  id?: string;
  name: string;
  frequency: ScheduleFrequency;
  syncTime: string;
  dayOfWeek: number;
  customDays: number[];
  customTimes: string[];
  datasetNames: DatasetSyncName[];
  enabled: boolean;
};

const EMPTY_DRAFT: ScheduleDraft = {
  name: "",
  frequency: "daily",
  syncTime: "07:00",
  dayOfWeek: 1,
  customDays: [...DEFAULT_CUSTOM_DAYS],
  customTimes: [...DEFAULT_CUSTOM_TIMES],
  datasetNames: [...EXECUTABLE_DATASET_TYPES],
  enabled: true,
};

function formatDuration(ms: number | null | undefined) {
  if (ms == null || ms < 0) return "—";
  if (ms < 1000) return `${ms} ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rem = seconds % 60;
  return `${minutes}m ${rem}s`;
}

export function SchedulesPanel({
  scheduler,
  onSchedulerChange,
  busy = false,
  embedded = false,
}: SchedulesPanelProps) {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState<ScheduleDraft>(EMPTY_DRAFT);
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

  const schedules = scheduler?.schedules ?? [];

  async function postAction(body: Record<string, unknown>) {
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/dataset/scheduler", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = (await response.json().catch(() => null)) as {
        error?: string;
        scheduler?: MultiSchedulerStatus;
      } | null;
      if (!response.ok) {
        throw new Error(payload?.error ?? "Schedule action failed.");
      }
      onSchedulerChange(payload?.scheduler ?? null);
      return payload;
    } finally {
      setSaving(false);
    }
  }

  function startCreate() {
    setDraft({ ...EMPTY_DRAFT, name: "New schedule" });
    setEditing(true);
    setError(null);
  }

  function startEdit(row: DatasetAutomationScheduleView) {
    setDraft({
      id: row.id,
      name: row.name,
      frequency: row.frequency === ("custom_cron" as ScheduleFrequency)
        ? "custom"
        : row.frequency,
      syncTime: row.syncTime,
      dayOfWeek: row.dayOfWeek,
      customDays: row.customDays?.length
        ? [...row.customDays]
        : [...DEFAULT_CUSTOM_DAYS],
      customTimes: row.customTimes?.length
        ? [...row.customTimes]
        : [row.syncTime || "07:00"],
      datasetNames: [...row.datasetNames],
      enabled: row.enabled,
    });
    setEditing(true);
    setError(null);
  }

  function toggleDataset(name: DatasetSyncName) {
    if (!isExecutableDatasetType(name)) return;
    setDraft((prev) => {
      const has = prev.datasetNames.includes(name);
      const datasetNames = has
        ? prev.datasetNames.filter((item) => item !== name)
        : [...prev.datasetNames, name];
      return {
        ...prev,
        datasetNames:
          datasetNames.length > 0
            ? datasetNames
            : [...EXECUTABLE_DATASET_TYPES],
      };
    });
  }

  function toggleCustomDay(day: number) {
    setDraft((prev) => {
      const has = prev.customDays.includes(day);
      const customDays = has
        ? prev.customDays.filter((item) => item !== day)
        : [...prev.customDays, day].sort((a, b) => a - b);
      return { ...prev, customDays };
    });
  }

  function updateCustomTime(index: number, value: string) {
    setDraft((prev) => {
      const customTimes = [...prev.customTimes];
      customTimes[index] = value;
      return { ...prev, customTimes };
    });
  }

  function addCustomTime() {
    setDraft((prev) => ({
      ...prev,
      customTimes: [...prev.customTimes, "14:00"],
    }));
  }

  function removeCustomTime(index: number) {
    setDraft((prev) => ({
      ...prev,
      customTimes:
        prev.customTimes.length <= 1
          ? prev.customTimes
          : prev.customTimes.filter((_, i) => i !== index),
    }));
  }

  async function saveDraft() {
    if (!draft.name.trim()) {
      setError("Enter a schedule name.");
      return;
    }
    if (draft.datasetNames.length === 0) {
      setError("Select at least one dataset.");
      return;
    }
    if (draft.frequency === "custom") {
      if (draft.customDays.length === 0) {
        setError("Select at least one day.");
        return;
      }
      if (draft.customTimes.length === 0) {
        setError("Add at least one time.");
        return;
      }
    }
    await postAction({
      action: draft.id ? "update" : "create",
      schedule: {
        ...draft,
        syncTime: draft.customTimes[0] ?? draft.syncTime,
      },
    });
    setEditing(false);
    setDraft(EMPTY_DRAFT);
  }

  const createButton = (
    <Button
      type="button"
      className="rounded-xl gap-1.5"
      onClick={startCreate}
      disabled={busy || saving}
    >
      <Plus className="size-4" />
      Create Schedule
    </Button>
  );

  const body = (
    <div className="space-y-4">
        {embedded ? (
          <div className="flex justify-end">{createButton}</div>
        ) : null}

        {editing ? (
          <div className="space-y-3 rounded-xl border border-border bg-muted/15 px-3 py-3">
            <p className="text-sm font-medium">
              {draft.id ? "Edit schedule" : "Create schedule"}
            </p>
            <label className="block space-y-1 text-sm">
              <span className="font-medium">Name</span>
              <Input
                value={draft.name}
                onChange={(event) =>
                  setDraft((prev) => ({ ...prev, name: event.target.value }))
                }
                placeholder="Lateral morning"
                className="h-10 rounded-xl"
              />
            </label>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              {(
                Object.keys(SCHEDULE_FREQUENCY_LABELS) as ScheduleFrequency[]
              ).map((frequency) => (
                <button
                  key={frequency}
                  type="button"
                  onClick={() => setDraft((prev) => ({ ...prev, frequency }))}
                  className={cn(
                    "rounded-xl border px-3 py-2 text-left text-sm",
                    draft.frequency === frequency
                      ? "border-primary/50 bg-primary/10"
                      : "border-border bg-background"
                  )}
                >
                  {SCHEDULE_FREQUENCY_LABELS[frequency]}
                </button>
              ))}
            </div>
            {draft.frequency === "daily" ||
            draft.frequency === "weekdays" ||
            draft.frequency === "weekly" ? (
              <label className="block max-w-xs space-y-1 text-sm">
                <span className="font-medium">Time</span>
                <Input
                  type="time"
                  value={draft.syncTime}
                  onChange={(event) =>
                    setDraft((prev) => ({
                      ...prev,
                      syncTime: event.target.value,
                    }))
                  }
                  className="h-10 rounded-xl"
                />
              </label>
            ) : null}
            {draft.frequency === "weekly" ? (
              <label className="block max-w-xs space-y-1 text-sm">
                <span className="font-medium">Day</span>
                <select
                  value={draft.dayOfWeek}
                  onChange={(event) =>
                    setDraft((prev) => ({
                      ...prev,
                      dayOfWeek: Number(event.target.value),
                    }))
                  }
                  className="h-10 w-full rounded-xl border border-input bg-background px-3 text-sm"
                >
                  {WEEKDAY_LABELS.map((label, index) => (
                    <option key={label} value={index}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {draft.frequency === "custom" ? (
              <div className="space-y-3">
                <div className="space-y-2">
                  <p className="text-sm font-medium">Days</p>
                  <div className="flex flex-wrap gap-2">
                    {WEEKDAY_SHORT_LABELS.map((label, day) => {
                      const selected = draft.customDays.includes(day);
                      return (
                        <button
                          key={label}
                          type="button"
                          onClick={() => toggleCustomDay(day)}
                          className={cn(
                            "min-w-12 rounded-xl border px-3 py-2 text-sm font-medium",
                            selected
                              ? "border-primary/50 bg-primary/10 text-primary"
                              : "border-border bg-background text-muted-foreground"
                          )}
                        >
                          {label}
                        </button>
                      );
                    })}
                  </div>
                </div>
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-medium">Times</p>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="rounded-lg gap-1"
                      onClick={addCustomTime}
                    >
                      <Plus className="size-3.5" />
                      Add time
                    </Button>
                  </div>
                  <div className="space-y-2">
                    {draft.customTimes.map((time, index) => (
                      <div key={`${time}-${index}`} className="flex max-w-sm items-center gap-2">
                        <Input
                          type="time"
                          value={time}
                          onChange={(event) =>
                            updateCustomTime(index, event.target.value)
                          }
                          className="h-10 rounded-xl"
                        />
                        <Button
                          type="button"
                          size="icon-sm"
                          variant="ghost"
                          className="rounded-lg text-destructive"
                          disabled={draft.customTimes.length <= 1}
                          onClick={() => removeCustomTime(index)}
                          aria-label="Remove time"
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      </div>
                    ))}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Example: Mon–Fri at 07:00 and 14:00.
                  </p>
                </div>
              </div>
            ) : null}
            <div className="space-y-2">
              <p className="text-sm font-medium">Datasets included</p>
              <p className="text-xs text-muted-foreground">
                Only Lateral executes currently. Executive and Consulting keep
                shared Gmail/Drive config for a later independent release.
              </p>
              <div className="flex flex-wrap gap-2">
                {DATASET_SYNC_NAMES.map((name) => {
                  const executable = isExecutableDatasetType(name);
                  return (
                    <label
                      key={name}
                      className={cn(
                        "inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-sm",
                        !executable && "opacity-60",
                        draft.datasetNames.includes(name)
                          ? "border-primary/40 bg-primary/10 text-primary"
                          : "border-border bg-background"
                      )}
                    >
                      <input
                        type="checkbox"
                        checked={
                          executable
                            ? draft.datasetNames.includes(name)
                            : false
                        }
                        disabled={!executable}
                        onChange={() => {
                          if (executable) toggleDataset(name);
                        }}
                      />
                      {name}
                      {!executable ? (
                        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                          Coming soon
                        </span>
                      ) : null}
                    </label>
                  );
                })}
              </div>
            </div>
            {error ? (
              <p className="text-sm text-destructive">{error}</p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                className="rounded-xl"
                disabled={saving}
                onClick={() => void saveDraft()}
              >
                {saving ? "Saving…" : draft.id ? "Save changes" : "Create"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="rounded-xl"
                disabled={saving}
                onClick={() => {
                  setEditing(false);
                  setDraft(EMPTY_DRAFT);
                  setError(null);
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : null}

        {schedules.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No schedules yet. Create one for 7:00 AM, 2:00 PM, Mondays, hourly,
            or a custom cron — each with its own dataset list.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-border">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/40 hover:bg-muted/40">
                  <TableHead>Name</TableHead>
                  <TableHead>Time</TableHead>
                  <TableHead>Datasets Included</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Last Run</TableHead>
                  <TableHead>Next Run</TableHead>
                  <TableHead>Duration</TableHead>
                  <TableHead>Result</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {schedules.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="font-medium">{row.name}</TableCell>
                    <TableCell className="text-sm">{row.timeLabel}</TableCell>
                    <TableCell className="text-sm">
                      {row.datasetsLabel}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant="secondary"
                        className={cn(
                          "rounded-md font-medium",
                          row.statusLabel === "Active" &&
                            "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
                          row.statusLabel === "Paused" &&
                            "bg-amber-500/10 text-amber-700 dark:text-amber-300",
                          row.statusLabel === "Disabled" &&
                            "bg-muted text-muted-foreground"
                        )}
                      >
                        {row.statusLabel}
                      </Badge>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-sm text-muted-foreground tabular-nums">
                      {row.lastRunAt
                        ? new Date(row.lastRunAt).toLocaleString("en-IN")
                        : "—"}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-sm text-muted-foreground tabular-nums">
                      {row.nextRunAt
                        ? new Date(row.nextRunAt).toLocaleString("en-IN")
                        : "—"}
                    </TableCell>
                    <TableCell className="tabular-nums text-sm">
                      {formatDuration(row.lastDurationMs)}
                    </TableCell>
                    <TableCell className="max-w-48 truncate text-sm text-muted-foreground">
                      {row.lastRunStatus
                        ? `${row.lastRunStatus}${
                            row.lastRunMessage
                              ? ` · ${row.lastRunMessage}`
                              : ""
                          }`
                        : "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex flex-wrap justify-end gap-1">
                        <Button
                          type="button"
                          size="icon-sm"
                          variant="ghost"
                          className="rounded-lg"
                          disabled={busy || saving}
                          onClick={() => startEdit(row)}
                          aria-label="Edit"
                        >
                          <Pencil className="size-3.5" />
                        </Button>
                        <Button
                          type="button"
                          size="icon-sm"
                          variant="ghost"
                          className="rounded-lg"
                          disabled={busy || saving}
                          onClick={() =>
                            void postAction({
                              action: row.paused ? "resume_one" : "pause_one",
                              id: row.id,
                            })
                          }
                          aria-label={row.paused ? "Resume" : "Pause"}
                        >
                          {row.paused ? (
                            <Play className="size-3.5" />
                          ) : (
                            <Pause className="size-3.5" />
                          )}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="rounded-lg"
                          disabled={busy || saving}
                          onClick={() =>
                            void postAction({
                              action: row.enabled ? "disable" : "enable",
                              id: row.id,
                            })
                          }
                        >
                          {row.enabled ? "Disable" : "Enable"}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="rounded-lg"
                          disabled={busy || saving || Boolean(scheduler?.running)}
                          onClick={() =>
                            void postAction({ action: "run_one", id: row.id })
                          }
                        >
                          Run
                        </Button>
                        <Button
                          type="button"
                          size="icon-sm"
                          variant="ghost"
                          className="rounded-lg text-destructive"
                          disabled={busy || saving}
                          onClick={() => {
                            if (
                              window.confirm(
                                `Delete schedule "${row.name}"?`
                              )
                            ) {
                              void postAction({
                                action: "delete",
                                id: row.id,
                              });
                            }
                          }}
                          aria-label="Delete"
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

    </div>
  );

  if (embedded) return body;

  return (
    <Card className="mb-4 shadow-sm">
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-2 text-base">
            <span className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <CalendarClock className="size-4" />
            </span>
            Automation schedules
          </CardTitle>
          <CardDescription>
            Unlimited schedules. Assign different times to Lateral, Executive,
            and Consulting. TZ {scheduler?.timezone ?? "Asia/Kolkata"}
            {scheduler?.globalPaused ? " · globally paused" : ""}
          </CardDescription>
        </div>
        {createButton}
      </CardHeader>
      <CardContent>{body}</CardContent>
    </Card>
  );
}
