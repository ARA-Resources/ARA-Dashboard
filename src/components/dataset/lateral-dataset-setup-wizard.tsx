"use client";

import * as React from "react";
import {
  ArrowDown,
  ArrowUp,
  ChevronLeft,
  ChevronRight,
  FolderOpen,
  Plus,
  Save,
  Search,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  DEFAULT_CUSTOM_DAYS,
  DEFAULT_CUSTOM_TIMES,
  SCHEDULE_FREQUENCY_LABELS,
  WEEKDAY_LABELS,
  WEEKDAY_SHORT_LABELS,
  formatScheduleTimeLabel,
  type ScheduleFrequency,
} from "@/types/dataset-schedule";
import {
  createKeywordConfig,
  KEYWORD_MATCH_MODE_LABELS,
  KEYWORD_MATCH_MODES,
  type DatasetKeywordConfig,
  type DriveFolderInputMode,
  type KeywordMatchMode,
} from "@/types/dataset-setup";
import {
  DEFAULT_LATERAL_MASTER_SHEET,
  DEFAULT_LATERAL_MASTER_WORKBOOK_NAME,
  DEFAULT_LATERAL_NEW_SHEET,
  DEFAULT_LATERAL_SOURCE_WORKSHEET,
  DEFAULT_LATERAL_TIMEZONE,
  withLateralDataProcessingDefaults,
  type DriveFolderOption,
  type LateralDataProcessingSetup,
  type LateralDataProcessingValidationResult,
  type ProcessingDriveFolderConfig,
  type WorkbookOption,
} from "@/types/lateral-processing-setup";

type Draft = Omit<LateralDataProcessingSetup, "updatedAt">;

const STEPS = [
  "Gmail search keywords",
  "Google Drive destination folder",
  "Source Excel identification",
  "Source worksheet name",
  "Lateral Master Workbook",
  "Master Sheet name",
  "New Sheet name",
  "Schedule",
  "Time zone",
] as const;

const COMMON_TIMEZONES = [
  "Asia/Kolkata",
  "Asia/Dubai",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Europe/London",
  "Europe/Berlin",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "UTC",
] as const;

interface Props {
  initial?: LateralDataProcessingSetup | null;
  onSaved: (setup: LateralDataProcessingSetup) => void;
  onCancel?: () => void;
}

function resolveFolderIdFromConfig(folder: ProcessingDriveFolderConfig): string {
  const fromId = folder.folderId.trim();
  if (fromId) return fromId;
  return (
    folder.folderUrl.trim().match(/folders\/([a-zA-Z0-9_-]+)/)?.[1] ?? ""
  );
}

function DriveFolderBrowser({
  value,
  onChange,
  label,
  hint,
}: {
  value: ProcessingDriveFolderConfig;
  onChange: (next: ProcessingDriveFolderConfig) => void;
  label: string;
  hint?: string;
}) {
  const [query, setQuery] = React.useState("");
  const [folders, setFolders] = React.useState<DriveFolderOption[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [browseError, setBrowseError] = React.useState<string | null>(null);
  const [parentId, setParentId] = React.useState("root");

  const patch = (partial: Partial<ProcessingDriveFolderConfig>) =>
    onChange({ ...value, ...partial });

  const browse = async (opts?: { parentId?: string; query?: string }) => {
    setLoading(true);
    setBrowseError(null);
    try {
      const params = new URLSearchParams();
      const q = (opts?.query ?? query).trim();
      if (q) {
        params.set("query", q);
      } else {
        params.set("parentId", opts?.parentId ?? parentId ?? "root");
      }
      const response = await fetch(
        `/api/dataset/drive/browse?${params.toString()}`
      );
      const payload = (await response.json().catch(() => null)) as
        | { error?: string; folders?: DriveFolderOption[] }
        | null;
      if (!response.ok) {
        throw new Error(payload?.error ?? "Failed to browse Drive folders.");
      }
      setFolders(payload?.folders ?? []);
      if (opts?.parentId) setParentId(opts.parentId);
    } catch (err) {
      setBrowseError(
        err instanceof Error ? err.message : "Failed to browse Drive folders."
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-3 rounded-xl border border-border/70 bg-muted/20 p-3">
      <div>
        <p className="text-sm font-semibold">{label}</p>
        {hint ? (
          <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>
        ) : null}
      </div>
      <div className="grid gap-2 sm:grid-cols-3">
        {(
          [
            { value: "picker" as DriveFolderInputMode, title: "Folder picker" },
            { value: "folder_id" as DriveFolderInputMode, title: "Folder ID" },
            { value: "folder_url" as DriveFolderInputMode, title: "Folder URL" },
          ] as const
        ).map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => patch({ mode: option.value })}
            className={cn(
              "rounded-lg border px-3 py-2 text-sm",
              value.mode === option.value
                ? "border-primary/50 bg-primary/10 text-primary"
                : "border-border bg-background"
            )}
          >
            {option.title}
          </button>
        ))}
      </div>

      <Input
        value={value.folderName}
        onChange={(event) => patch({ folderName: event.target.value })}
        placeholder="Folder name (optional label)"
        className="h-10 rounded-xl"
      />

      {value.mode === "folder_id" || value.mode === "picker" ? (
        <Input
          value={value.folderId}
          onChange={(event) => patch({ folderId: event.target.value })}
          placeholder="Google Drive folder ID"
          className="h-10 rounded-xl"
        />
      ) : null}

      {value.mode === "folder_url" ? (
        <Input
          value={value.folderUrl}
          onChange={(event) => patch({ folderUrl: event.target.value })}
          placeholder="https://drive.google.com/drive/folders/..."
          className="h-10 rounded-xl"
        />
      ) : null}

      {value.mode === "picker" ? (
        <div className="space-y-2 rounded-xl border border-border/60 bg-background p-3">
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void browse({ query });
                }
              }}
              placeholder="Search folders by name"
              className="h-10 rounded-xl"
            />
            <Button
              type="button"
              variant="outline"
              className="rounded-xl gap-1.5"
              onClick={() => void browse({ query })}
              disabled={loading}
            >
              <Search className="size-4" />
              {loading ? "Searching..." : "Search"}
            </Button>
            <Button
              type="button"
              variant="outline"
              className="rounded-xl gap-1.5"
              onClick={() => void browse({ parentId: "root", query: "" })}
              disabled={loading}
            >
              <FolderOpen className="size-4" />
              {loading ? "Loading..." : "Browse root"}
            </Button>
          </div>
          {browseError ? (
            <p className="text-xs text-destructive">{browseError}</p>
          ) : null}
          {folders.length > 0 ? (
            <ul className="max-h-48 space-y-1 overflow-y-auto">
              {folders.map((folder) => (
                <li key={folder.id}>
                  <button
                    type="button"
                    className={cn(
                      "flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left text-sm",
                      value.folderId === folder.id
                        ? "border-primary/50 bg-primary/10 text-primary"
                        : "border-border bg-background hover:bg-muted/40"
                    )}
                    onClick={() =>
                      patch({
                        mode: "picker",
                        folderId: folder.id,
                        folderName: folder.name,
                        folderUrl: folder.webViewLink ?? value.folderUrl,
                      })
                    }
                  >
                    <span className="truncate font-medium">{folder.name}</span>
                    <span className="ml-2 shrink-0 text-xs text-muted-foreground">
                      Select
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">
              Search by name or browse from My Drive root to select a folder.
            </p>
          )}
        </div>
      ) : null}
    </div>
  );
}

export function LateralDatasetSetupWizard({
  initial,
  onSaved,
  onCancel,
}: Props) {
  const [step, setStep] = React.useState(0);
  const [draft, setDraft] = React.useState<Draft>(() =>
    withLateralDataProcessingDefaults(initial)
  );
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [validation, setValidation] =
    React.useState<LateralDataProcessingValidationResult | null>(null);

  const [keywordDraft, setKeywordDraft] = React.useState("");
  const [keywordMode, setKeywordMode] =
    React.useState<KeywordMatchMode>("contains");

  const [sourceWorkbooks, setSourceWorkbooks] = React.useState<WorkbookOption[]>(
    []
  );
  const [masterWorkbooks, setMasterWorkbooks] = React.useState<WorkbookOption[]>(
    []
  );
  const [sourceSheets, setSourceSheets] = React.useState<string[]>([]);
  const [masterSheets, setMasterSheets] = React.useState<string[]>([]);
  const [loadingSourceWorkbooks, setLoadingSourceWorkbooks] =
    React.useState(false);
  const [loadingMasterWorkbooks, setLoadingMasterWorkbooks] =
    React.useState(false);
  const [loadingSheets, setLoadingSheets] = React.useState(false);
  const [masterSearch, setMasterSearch] = React.useState(
    DEFAULT_LATERAL_MASTER_WORKBOOK_NAME.replace(/\.xlsm$/i, "")
  );

  const timezoneOptions = React.useMemo(() => {
    const supported =
      typeof Intl !== "undefined" &&
      "supportedValuesOf" in Intl &&
      typeof Intl.supportedValuesOf === "function"
        ? Intl.supportedValuesOf("timeZone")
        : [...COMMON_TIMEZONES];
    const preferred = new Set<string>([
      ...COMMON_TIMEZONES,
      DEFAULT_LATERAL_TIMEZONE,
      draft.timezone,
    ]);
    return [
      ...[...preferred].filter(Boolean),
      ...supported.filter((zone) => !preferred.has(zone)),
    ];
  }, [draft.timezone]);

  React.useEffect(() => {
    const next = withLateralDataProcessingDefaults(initial);
    setDraft(next);
    setStep(0);
    setError(null);
    setValidation(null);
    setMasterSearch(
      (next.masterWorkbook.fileName || DEFAULT_LATERAL_MASTER_WORKBOOK_NAME).replace(
        /\.xlsm$/i,
        ""
      )
    );
  }, [initial?.updatedAt]);

  const patch = (partial: Partial<Draft>) => {
    setDraft((prev) => ({ ...prev, ...partial }));
    setError(null);
  };

  const addKeyword = () => {
    const value = keywordDraft.trim();
    if (!value) return;
    if (keywordMode === "regex") {
      try {
        void new RegExp(value, "i");
      } catch {
        setError(`Invalid regex: ${value}`);
        return;
      }
    }
    const duplicate = draft.keywords.some(
      (keyword) =>
        keyword.value.toLowerCase() === value.toLowerCase() &&
        keyword.matchMode === keywordMode
    );
    if (duplicate) {
      setError("That keyword is already listed.");
      return;
    }
    const nextPriority =
      draft.keywords.reduce((max, keyword) => Math.max(max, keyword.priority), 0) +
      1;
    patch({
      keywords: [
        ...draft.keywords,
        createKeywordConfig(value, nextPriority, keywordMode, true),
      ],
    });
    setKeywordDraft("");
  };

  const updateKeyword = (
    key: string,
    partial: Partial<DatasetKeywordConfig>
  ) => {
    patch({
      keywords: draft.keywords.map((keyword) => {
        const id = `${keyword.matchMode}::${keyword.value}`;
        return id === key ? { ...keyword, ...partial } : keyword;
      }),
    });
  };

  const removeKeyword = (key: string) => {
    const remaining = draft.keywords
      .filter((keyword) => `${keyword.matchMode}::${keyword.value}` !== key)
      .sort((a, b) => a.priority - b.priority)
      .map((keyword, index) => ({ ...keyword, priority: index + 1 }));
    patch({ keywords: remaining });
  };

  const moveKeyword = (key: string, direction: -1 | 1) => {
    const ordered = [...draft.keywords].sort(
      (a, b) => a.priority - b.priority || a.value.localeCompare(b.value)
    );
    const index = ordered.findIndex(
      (keyword) => `${keyword.matchMode}::${keyword.value}` === key
    );
    const swapWith = index + direction;
    if (index < 0 || swapWith < 0 || swapWith >= ordered.length) return;
    const a = ordered[index];
    const b = ordered[swapWith];
    ordered[index] = { ...a, priority: b.priority };
    ordered[swapWith] = { ...b, priority: a.priority };
    patch({
      keywords: ordered
        .sort((x, y) => x.priority - y.priority)
        .map((keyword, i) => ({ ...keyword, priority: i + 1 })),
    });
  };

  const loadSourceWorkbooks = async () => {
    const folderId = resolveFolderIdFromConfig(draft.sourceFolder);
    if (!folderId) {
      setError("Configure the source folder (ID or URL), then load workbooks.");
      return;
    }
    setLoadingSourceWorkbooks(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/dataset/lateral-processing/workbooks?folderId=${encodeURIComponent(folderId)}`
      );
      const payload = (await response.json().catch(() => null)) as
        | { error?: string; files?: WorkbookOption[] }
        | null;
      if (!response.ok) {
        throw new Error(payload?.error ?? "Failed to load source workbooks.");
      }
      setSourceWorkbooks(payload?.files ?? []);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to load source workbooks."
      );
    } finally {
      setLoadingSourceWorkbooks(false);
    }
  };

  const searchMasterWorkbooks = async () => {
    const q = masterSearch.trim();
    if (!q) {
      setError("Enter a workbook name to search.");
      return;
    }
    setLoadingMasterWorkbooks(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/dataset/lateral-processing/workbooks?query=${encodeURIComponent(q)}`
      );
      const payload = (await response.json().catch(() => null)) as
        | { error?: string; files?: WorkbookOption[] }
        | null;
      if (!response.ok) {
        throw new Error(payload?.error ?? "Failed to search master workbooks.");
      }
      const files = payload?.files ?? [];
      setMasterWorkbooks(files);
      if (files.length === 0) {
        setError(
          `No Excel workbooks found for “${q}”. Try a shorter name (e.g. MasterSheet Final 2026), or confirm the file is accessible to the connected Google account.`
        );
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to search master workbooks."
      );
    } finally {
      setLoadingMasterWorkbooks(false);
    }
  };

  const loadWorkbookSheets = async (
    which: "source" | "master",
    fileId: string,
    fileName: string
  ) => {
    if (!fileId) return;
    setLoadingSheets(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/dataset/lateral-processing/worksheets?fileId=${encodeURIComponent(fileId)}&fileName=${encodeURIComponent(fileName || "workbook.xlsx")}`
      );
      const payload = (await response.json().catch(() => null)) as
        | { error?: string; worksheets?: string[] }
        | null;
      if (!response.ok) {
        throw new Error(payload?.error ?? "Failed to load worksheet names.");
      }
      const rows = payload?.worksheets ?? [];
      if (which === "source") setSourceSheets(rows);
      else setMasterSheets(rows);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to load worksheet names."
      );
    } finally {
      setLoadingSheets(false);
    }
  };

  const validateStep = (): string | null => {
    if (step === 0) {
      const enabled = draft.keywords.filter(
        (keyword) => keyword.enabled && keyword.value.trim()
      );
      if (enabled.length === 0) {
        return "Add and enable at least one Gmail search keyword.";
      }
    }
    if (
      step === 1 &&
      !draft.destinationFolder.folderId.trim() &&
      !draft.destinationFolder.folderUrl.trim()
    ) {
      return "Configure the Google Drive destination folder (ID, URL, or picker).";
    }
    if (step === 2) {
      if (
        !draft.sourceFolder.folderId.trim() &&
        !draft.sourceFolder.folderUrl.trim()
      ) {
        return "Configure the source Excel folder (ID or URL).";
      }
      if (!draft.sourceWorkbook.fileId.trim()) {
        return "Select which source workbook should be processed.";
      }
    }
    if (step === 3 && !draft.sourceWorksheet.trim()) {
      return "Enter the source worksheet name.";
    }
    if (step === 4 && !draft.masterWorkbook.fileId.trim()) {
      return "Select the Lateral Master Workbook.";
    }
    if (step === 5 && !draft.masterSheet.trim()) {
      return "Enter the Master Sheet name.";
    }
    if (step === 6 && !draft.masterNewSheet.trim()) {
      return "Enter the New Sheet name.";
    }
    if (step === 7) {
      if (draft.schedule.frequency === "custom") {
        if (draft.schedule.customDays.length === 0) {
          return "Select at least one day for the custom schedule.";
        }
        if (
          draft.schedule.customTimes.length === 0 ||
          draft.schedule.customTimes.some(
            (time) => !/^\d{1,2}:\d{2}$/.test(time.trim())
          )
        ) {
          return "Add at least one valid schedule time (HH:MM).";
        }
      } else if (
        draft.schedule.frequency !== "hourly" &&
        !/^\d{1,2}:\d{2}$/.test(draft.schedule.syncTime.trim())
      ) {
        return "Enter a valid schedule time (HH:MM).";
      }
    }
    if (step === 8) {
      if (!draft.timezone.trim()) return "Select a time zone.";
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: draft.timezone }).format(
          new Date()
        );
      } catch {
        return `Invalid time zone: ${draft.timezone}`;
      }
    }
    return null;
  };

  const save = async () => {
    const issue = validateStep();
    if (issue) {
      setError(issue);
      return;
    }
    setSaving(true);
    setError(null);
    setValidation(null);
    try {
      const response = await fetch("/api/dataset/lateral-processing/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      const payload = (await response.json().catch(() => null)) as
        | {
            error?: string;
            setup?: LateralDataProcessingSetup;
            validation?: LateralDataProcessingValidationResult;
          }
        | null;
      if (!response.ok || !payload?.setup) {
        setValidation(payload?.validation ?? null);
        throw new Error(payload?.error ?? "Failed to save setup.");
      }
      setValidation(payload.validation ?? null);
      onSaved(payload.setup);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save setup.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="shadow-sm">
      <CardHeader>
        <CardTitle>Lateral Dataset Setup</CardTitle>
        <CardDescription>
          Configuration only — keywords, Drive folders, workbooks, worksheets,
          schedule, and time zone. Settings are validated before save. No Excel
          file is modified here.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <ol className="flex flex-wrap gap-2">
          {STEPS.map((label, index) => (
            <li
              key={label}
              className={cn(
                "rounded-md border px-2 py-1 text-xs",
                index === step
                  ? "border-primary/40 bg-primary/10 text-primary"
                  : "text-muted-foreground"
              )}
            >
              {index + 1}. {label}
            </li>
          ))}
        </ol>

        {step === 0 ? (
          <div className="space-y-3">
            <p className="text-sm font-medium">
              Gmail search keywords for Lateral assignment
            </p>
            <p className="text-xs text-muted-foreground">
              Matched against attachment file name, email subject, and body.
              Any enabled keyword assigns the email to Lateral.
            </p>
            <div className="flex flex-col gap-2 lg:flex-row">
              <Input
                value={keywordDraft}
                onChange={(event) => setKeywordDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    addKeyword();
                  }
                }}
                placeholder="ATCI Lateral"
                className="h-10 rounded-xl"
              />
              <select
                value={keywordMode}
                onChange={(event) =>
                  setKeywordMode(event.target.value as KeywordMatchMode)
                }
                className="h-10 rounded-xl border border-input bg-background px-3 text-sm"
              >
                {KEYWORD_MATCH_MODES.map((mode) => (
                  <option key={mode} value={mode}>
                    {KEYWORD_MATCH_MODE_LABELS[mode]}
                  </option>
                ))}
              </select>
              <Button
                type="button"
                variant="outline"
                className="rounded-xl gap-1.5"
                onClick={addKeyword}
              >
                <Plus className="size-4" />
                Add Keyword
              </Button>
            </div>
            {draft.keywords.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                Add at least one keyword so Lateral can be matched.
              </p>
            ) : (
              <ul className="space-y-2">
                {[...draft.keywords]
                  .sort(
                    (a, b) =>
                      a.priority - b.priority || a.value.localeCompare(b.value)
                  )
                  .map((keyword) => {
                    const key = `${keyword.matchMode}::${keyword.value}`;
                    return (
                      <li
                        key={key}
                        className={cn(
                          "flex flex-wrap items-center gap-2 rounded-xl border px-3 py-2",
                          keyword.enabled
                            ? "border-border bg-background"
                            : "border-dashed border-border bg-muted/30 opacity-70"
                        )}
                      >
                        <span className="min-w-0 flex-1 truncate text-sm font-medium">
                          {keyword.value}
                        </span>
                        <select
                          value={keyword.matchMode}
                          onChange={(event) =>
                            updateKeyword(key, {
                              matchMode: event.target
                                .value as KeywordMatchMode,
                            })
                          }
                          className="h-8 rounded-lg border border-input bg-background px-2 text-xs"
                        >
                          {KEYWORD_MATCH_MODES.map((mode) => (
                            <option key={mode} value={mode}>
                              {KEYWORD_MATCH_MODE_LABELS[mode]}
                            </option>
                          ))}
                        </select>
                        <label className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                          Priority
                          <Input
                            type="number"
                            min={1}
                            value={keyword.priority}
                            onChange={(event) => {
                              const value = Number(event.target.value);
                              updateKeyword(key, {
                                priority:
                                  Number.isFinite(value) && value >= 1
                                    ? Math.floor(value)
                                    : keyword.priority,
                              });
                            }}
                            className="h-8 w-16 rounded-lg px-2"
                          />
                        </label>
                        <Button
                          type="button"
                          size="icon-sm"
                          variant="ghost"
                          className="rounded-lg"
                          onClick={() => moveKeyword(key, -1)}
                          aria-label="Higher priority"
                        >
                          <ArrowUp className="size-3.5" />
                        </Button>
                        <Button
                          type="button"
                          size="icon-sm"
                          variant="ghost"
                          className="rounded-lg"
                          onClick={() => moveKeyword(key, 1)}
                          aria-label="Lower priority"
                        >
                          <ArrowDown className="size-3.5" />
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="rounded-lg"
                          onClick={() =>
                            updateKeyword(key, { enabled: !keyword.enabled })
                          }
                        >
                          {keyword.enabled ? "Disable" : "Enable"}
                        </Button>
                        <Button
                          type="button"
                          size="icon-sm"
                          variant="ghost"
                          className="rounded-lg text-destructive"
                          onClick={() => removeKeyword(key)}
                          aria-label={`Remove ${keyword.value}`}
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      </li>
                    );
                  })}
              </ul>
            )}
          </div>
        ) : null}

        {step === 1 ? (
          <div className="space-y-3">
            <p className="text-sm font-medium">
              Where should Lateral Excel files be stored in Google Drive?
            </p>
            <DriveFolderBrowser
              value={draft.destinationFolder}
              onChange={(next) => patch({ destinationFolder: next })}
              label="Google Drive destination folder"
              hint="Browse real Drive folders, or paste a folder ID / URL. Not a hardcoded path."
            />
          </div>
        ) : null}

        {step === 2 ? (
          <div className="space-y-3">
            <p className="text-sm font-medium">
              Identify the source Excel workbook to process
            </p>
            <DriveFolderBrowser
              value={draft.sourceFolder}
              onChange={(next) => patch({ sourceFolder: next })}
              label="Source data folder"
              hint="Folder that contains the newly fetched Adhoc DS Excel file."
            />
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                className="rounded-xl"
                onClick={() => void loadSourceWorkbooks()}
                disabled={loadingSourceWorkbooks}
              >
                <FolderOpen className="mr-2 size-4" />
                {loadingSourceWorkbooks
                  ? "Loading..."
                  : "Load workbooks from folder"}
              </Button>
            </div>
            <select
              value={draft.sourceWorkbook.fileId}
              onChange={(event) => {
                const selected = sourceWorkbooks.find(
                  (item) => item.id === event.target.value
                );
                patch({
                  sourceWorkbook: {
                    fileId: selected?.id || "",
                    fileName: selected?.name || "",
                  },
                });
                if (selected) {
                  void loadWorkbookSheets("source", selected.id, selected.name);
                }
              }}
              className="h-10 w-full rounded-xl border border-input bg-background px-3 text-sm"
            >
              <option value="">Select source workbook</option>
              {draft.sourceWorkbook.fileId &&
              !sourceWorkbooks.some(
                (file) => file.id === draft.sourceWorkbook.fileId
              ) ? (
                <option value={draft.sourceWorkbook.fileId}>
                  {draft.sourceWorkbook.fileName || draft.sourceWorkbook.fileId}
                </option>
              ) : null}
              {sourceWorkbooks.map((file) => (
                <option key={file.id} value={file.id}>
                  {file.name}
                </option>
              ))}
            </select>
          </div>
        ) : null}

        {step === 3 ? (
          <div className="space-y-3">
            <p className="text-sm font-medium">
              Which worksheet contains the data that should be imported?
            </p>
            <Input
              value={draft.sourceWorksheet}
              onChange={(event) =>
                patch({ sourceWorksheet: event.target.value })
              }
              placeholder={DEFAULT_LATERAL_SOURCE_WORKSHEET}
              className="h-10 rounded-xl"
            />
            {draft.sourceWorkbook.fileId ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="rounded-xl"
                onClick={() =>
                  void loadWorkbookSheets(
                    "source",
                    draft.sourceWorkbook.fileId,
                    draft.sourceWorkbook.fileName
                  )
                }
                disabled={loadingSheets}
              >
                {loadingSheets ? "Loading sheets..." : "Refresh worksheets"}
              </Button>
            ) : null}
            {sourceSheets.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {sourceSheets.map((name) => (
                  <button
                    key={name}
                    type="button"
                    onClick={() => patch({ sourceWorksheet: name })}
                    className={cn(
                      "rounded-lg border px-2 py-1 text-xs",
                      draft.sourceWorksheet === name
                        ? "border-primary/50 bg-primary/10 text-primary"
                        : "border-border bg-background"
                    )}
                  >
                    {name}
                  </button>
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                Default is “{DEFAULT_LATERAL_SOURCE_WORKSHEET}” (editable). Select
                a source workbook to validate available worksheets.
              </p>
            )}
          </div>
        ) : null}

        {step === 4 ? (
          <div className="space-y-3">
            <p className="text-sm font-medium">
              Which Lateral Master Workbook should be updated?
            </p>
            <p className="text-xs text-muted-foreground">
              Name hint (editable search, not a required file ID):{" "}
              {DEFAULT_LATERAL_MASTER_WORKBOOK_NAME}
            </p>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                value={masterSearch}
                onChange={(event) => setMasterSearch(event.target.value)}
                className="h-10 rounded-xl"
                placeholder={DEFAULT_LATERAL_MASTER_WORKBOOK_NAME}
              />
              <Button
                type="button"
                variant="outline"
                className="rounded-xl"
                onClick={() => void searchMasterWorkbooks()}
                disabled={loadingMasterWorkbooks}
              >
                {loadingMasterWorkbooks ? "Searching..." : "Search Drive"}
              </Button>
            </div>
            <select
              value={draft.masterWorkbook.fileId}
              onChange={(event) => {
                const selected = masterWorkbooks.find(
                  (item) => item.id === event.target.value
                );
                patch({
                  masterWorkbook: {
                    fileId: selected?.id || "",
                    fileName:
                      selected?.name ||
                      draft.masterWorkbook.fileName ||
                      DEFAULT_LATERAL_MASTER_WORKBOOK_NAME,
                  },
                });
                if (selected) {
                  void loadWorkbookSheets("master", selected.id, selected.name);
                }
              }}
              className="h-10 w-full rounded-xl border border-input bg-background px-3 text-sm"
            >
              <option value="">Select master workbook</option>
              {draft.masterWorkbook.fileId &&
              !masterWorkbooks.some(
                (file) => file.id === draft.masterWorkbook.fileId
              ) ? (
                <option value={draft.masterWorkbook.fileId}>
                  {draft.masterWorkbook.fileName || draft.masterWorkbook.fileId}
                </option>
              ) : null}
              {masterWorkbooks.map((file) => (
                <option key={file.id} value={file.id}>
                  {file.name}
                </option>
              ))}
            </select>
          </div>
        ) : null}

        {step === 5 ? (
          <div className="space-y-3">
            <p className="text-sm font-medium">Master Sheet name</p>
            <Input
              value={draft.masterSheet}
              onChange={(event) => patch({ masterSheet: event.target.value })}
              placeholder={DEFAULT_LATERAL_MASTER_SHEET}
              className="h-10 rounded-xl"
            />
            {draft.masterWorkbook.fileId ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="rounded-xl"
                onClick={() =>
                  void loadWorkbookSheets(
                    "master",
                    draft.masterWorkbook.fileId,
                    draft.masterWorkbook.fileName
                  )
                }
                disabled={loadingSheets}
              >
                {loadingSheets ? "Loading sheets..." : "Refresh worksheets"}
              </Button>
            ) : null}
            {loadingSheets ? (
              <p className="text-xs text-muted-foreground">Loading worksheets...</p>
            ) : masterSheets.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {masterSheets.map((name) => (
                  <button
                    key={name}
                    type="button"
                    onClick={() => patch({ masterSheet: name })}
                    className={cn(
                      "rounded-lg border px-2 py-1 text-xs",
                      draft.masterSheet === name
                        ? "border-primary/50 bg-primary/10 text-primary"
                        : "border-border bg-background"
                    )}
                  >
                    {name}
                  </button>
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                Default is “{DEFAULT_LATERAL_MASTER_SHEET}” (editable).
              </p>
            )}
          </div>
        ) : null}

        {step === 6 ? (
          <div className="space-y-3">
            <p className="text-sm font-medium">New Sheet name</p>
            <Input
              value={draft.masterNewSheet}
              onChange={(event) =>
                patch({ masterNewSheet: event.target.value })
              }
              placeholder={DEFAULT_LATERAL_NEW_SHEET}
              className="h-10 rounded-xl"
            />
            {masterSheets.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {masterSheets.map((name) => (
                  <button
                    key={name}
                    type="button"
                    onClick={() => patch({ masterNewSheet: name })}
                    className={cn(
                      "rounded-lg border px-2 py-1 text-xs",
                      draft.masterNewSheet === name
                        ? "border-primary/50 bg-primary/10 text-primary"
                        : "border-border bg-background"
                    )}
                  >
                    {name}
                  </button>
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                Default is “{DEFAULT_LATERAL_NEW_SHEET}” (editable). Available
                sheets appear after you select the master workbook.
              </p>
            )}
          </div>
        ) : null}

        {step === 7 ? (
          <div className="space-y-3">
            <p className="text-sm font-medium">Lateral automation schedule</p>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {(
                Object.keys(SCHEDULE_FREQUENCY_LABELS) as ScheduleFrequency[]
              ).map((frequency) => (
                <button
                  key={frequency}
                  type="button"
                  onClick={() =>
                    patch({
                      schedule: {
                        ...draft.schedule,
                        frequency,
                        customDays:
                          frequency === "custom" &&
                          draft.schedule.customDays.length === 0
                            ? [...DEFAULT_CUSTOM_DAYS]
                            : draft.schedule.customDays,
                        customTimes:
                          frequency === "custom" &&
                          draft.schedule.customTimes.length === 0
                            ? [
                                draft.schedule.syncTime ||
                                  DEFAULT_CUSTOM_TIMES[0],
                              ]
                            : draft.schedule.customTimes,
                      },
                    })
                  }
                  className={cn(
                    "rounded-xl border px-3 py-2 text-left text-sm",
                    draft.schedule.frequency === frequency
                      ? "border-primary/50 bg-primary/10 text-primary"
                      : "border-border bg-background"
                  )}
                >
                  {SCHEDULE_FREQUENCY_LABELS[frequency]}
                </button>
              ))}
            </div>

            {draft.schedule.frequency === "daily" ||
            draft.schedule.frequency === "weekdays" ||
            draft.schedule.frequency === "weekly" ? (
              <label className="block max-w-xs space-y-1 text-sm">
                <span className="font-medium">Time</span>
                <Input
                  type="time"
                  value={draft.schedule.syncTime}
                  onChange={(event) =>
                    patch({
                      schedule: {
                        ...draft.schedule,
                        syncTime: event.target.value,
                        customTimes: [event.target.value],
                      },
                    })
                  }
                  className="h-10 rounded-xl"
                />
              </label>
            ) : null}

            {draft.schedule.frequency === "weekly" ? (
              <label className="block max-w-xs space-y-1 text-sm">
                <span className="font-medium">Day</span>
                <select
                  value={draft.schedule.dayOfWeek}
                  onChange={(event) =>
                    patch({
                      schedule: {
                        ...draft.schedule,
                        dayOfWeek: Number(event.target.value),
                      },
                    })
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

            {draft.schedule.frequency === "hourly" ? (
              <p className="text-xs text-muted-foreground">
                Hourly runs do not require a specific clock time.
              </p>
            ) : null}

            {draft.schedule.frequency === "custom" ? (
              <div className="space-y-3">
                <div className="space-y-2">
                  <p className="text-sm font-medium">Selected days</p>
                  <div className="flex flex-wrap gap-2">
                    {WEEKDAY_SHORT_LABELS.map((label, day) => {
                      const selected = draft.schedule.customDays.includes(day);
                      return (
                        <button
                          key={label}
                          type="button"
                          onClick={() => {
                            const has = draft.schedule.customDays.includes(day);
                            const customDays = has
                              ? draft.schedule.customDays.filter(
                                  (item) => item !== day
                                )
                              : [...draft.schedule.customDays, day].sort(
                                  (a, b) => a - b
                                );
                            patch({
                              schedule: { ...draft.schedule, customDays },
                            });
                          }}
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
                    <p className="text-sm font-medium">Schedule times</p>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="rounded-lg gap-1"
                      onClick={() =>
                        patch({
                          schedule: {
                            ...draft.schedule,
                            customTimes: [
                              ...draft.schedule.customTimes,
                              "14:00",
                            ],
                          },
                        })
                      }
                    >
                      <Plus className="size-3.5" />
                      Add time
                    </Button>
                  </div>
                  <div className="space-y-2">
                    {draft.schedule.customTimes.map((time, index) => (
                      <div
                        key={`${time}-${index}`}
                        className="flex max-w-sm items-center gap-2"
                      >
                        <Input
                          type="time"
                          value={time}
                          onChange={(event) => {
                            const customTimes = [...draft.schedule.customTimes];
                            customTimes[index] = event.target.value;
                            patch({
                              schedule: {
                                ...draft.schedule,
                                customTimes,
                                syncTime: customTimes[0] || draft.schedule.syncTime,
                              },
                            });
                          }}
                          className="h-10 rounded-xl"
                        />
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="rounded-lg"
                          disabled={draft.schedule.customTimes.length <= 1}
                          onClick={() => {
                            const customTimes =
                              draft.schedule.customTimes.filter(
                                (_, i) => i !== index
                              );
                            patch({
                              schedule: {
                                ...draft.schedule,
                                customTimes,
                                syncTime:
                                  customTimes[0] || draft.schedule.syncTime,
                              },
                            });
                          }}
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      </div>
                    ))}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Lateral will run on the selected days at each time you add.
                  </p>
                </div>
              </div>
            ) : null}

            <label className="flex items-start gap-3 rounded-xl border border-border px-3 py-3">
              <input
                type="checkbox"
                className="mt-1"
                checked={draft.schedule.enabled}
                onChange={(event) =>
                  patch({
                    schedule: {
                      ...draft.schedule,
                      enabled: event.target.checked,
                    },
                  })
                }
              />
              <span>
                <span className="block text-sm font-medium">
                  Enable this schedule
                </span>
                <span className="text-xs text-muted-foreground">
                  When disabled, Lateral schedule seeds are saved but not active.
                </span>
              </span>
            </label>
          </div>
        ) : null}

        {step === 8 ? (
          <div className="space-y-3">
            <p className="text-sm font-medium">Preferred scheduler time zone</p>
            <select
              value={draft.timezone}
              onChange={(event) => patch({ timezone: event.target.value })}
              className="h-10 w-full rounded-xl border border-input bg-background px-3 text-sm"
            >
              {timezoneOptions.map((zone) => (
                <option key={zone} value={zone}>
                  {zone}
                </option>
              ))}
            </select>
            <Input
              value={draft.timezone}
              onChange={(event) => patch({ timezone: event.target.value })}
              placeholder={DEFAULT_LATERAL_TIMEZONE}
              className="h-10 rounded-xl"
            />
            <p className="text-xs text-muted-foreground">
              Default is {DEFAULT_LATERAL_TIMEZONE}. Configuration is validated
              before save — Excel workbooks are not modified in this wizard.
            </p>
            <div className="space-y-2 rounded-xl border border-border/70 bg-muted/20 p-3 text-sm">
              <p className="font-medium">Review before save</p>
              <p>
                Keywords:{" "}
                {draft.keywords
                  .filter((k) => k.enabled)
                  .map((k) => k.value)
                  .join(", ") || "None enabled"}
              </p>
              <p>
                Destination:{" "}
                {draft.destinationFolder.folderName ||
                  draft.destinationFolder.folderId ||
                  "(from URL)"}
              </p>
              <p>
                Source workbook:{" "}
                {draft.sourceWorkbook.fileName || "Not selected"}
              </p>
              <p>Source worksheet: {draft.sourceWorksheet}</p>
              <p>
                Master workbook:{" "}
                {draft.masterWorkbook.fileName || "Not selected"}
              </p>
              <p>Master Sheet: {draft.masterSheet}</p>
              <p>New Sheet: {draft.masterNewSheet}</p>
              <p>
                Schedule: {formatScheduleTimeLabel(draft.schedule)}
                {draft.schedule.enabled ? " · enabled" : " · disabled"}
              </p>
              <p>Time zone: {draft.timezone}</p>
            </div>
          </div>
        ) : null}

        {validation ? (
          <div className="rounded-xl border border-border/70 bg-muted/20 p-3">
            <p className="mb-2 text-sm font-semibold">Validation results</p>
            {Object.entries(validation).map(([key, row]) =>
              row ? (
                <p
                  key={key}
                  className={cn(
                    "text-xs",
                    row.ok ? "text-emerald-600" : "text-destructive"
                  )}
                >
                  {row.ok ? "✓" : "✗"} {key}: {row.message}
                </p>
              ) : null
            )}
          </div>
        ) : null}

        {error ? (
          <p className="rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => setStep((s) => Math.max(0, s - 1))}
              disabled={step === 0 || saving}
            >
              <ChevronLeft className="size-4" />
              Back
            </Button>
            {onCancel ? (
              <Button
                type="button"
                variant="ghost"
                onClick={onCancel}
                disabled={saving}
              >
                Cancel
              </Button>
            ) : null}
          </div>
          {step < STEPS.length - 1 ? (
            <Button
              type="button"
              onClick={() => {
                const issue = validateStep();
                if (issue) {
                  setError(issue);
                  return;
                }
                setStep((s) => Math.min(STEPS.length - 1, s + 1));
              }}
              disabled={saving}
            >
              Continue
              <ChevronRight className="size-4" />
            </Button>
          ) : (
            <Button
              type="button"
              onClick={() => void save()}
              disabled={saving}
            >
              {saving ? "Saving..." : "Save setup securely"}
              {saving ? null : <Save className="size-4" />}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/** @deprecated Prefer LateralDatasetSetupWizard — alias kept for compatibility. */
export const LateralProcessingSetupWizard = LateralDatasetSetupWizard;
