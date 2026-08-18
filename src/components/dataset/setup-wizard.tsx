"use client";

import * as React from "react";
import {
  createEmptyDatasetSetup,
  createKeywordConfig,
  DEFAULT_FILE_TYPES,
  DEFAULT_SYNC_TIME,
  getEnabledKeywords,
  KEYWORD_MATCH_MODE_LABELS,
  KEYWORD_MATCH_MODES,
  withSetupDefaults,
  type DatasetDriveFolderConfig,
  type DatasetFileType,
  type DatasetKeywordConfig,
  type DatasetSearchConfig,
  type DatasetSetupConfig,
  type DriveFolderInputMode,
  type FileReplacePolicy,
  type KeywordMatchMode,
  type SyncFrequency,
} from "@/types/dataset-setup";
import { DATASET_SYNC_NAMES, type DatasetSyncName } from "@/types/dataset-sync";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronLeft,
  ChevronRight,
  FolderOpen,
  HardDrive,
  Mail,
  Plus,
  ShieldCheck,
  Trash2,
  X,
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

const STEPS = [
  { id: 1, title: "Gmail account", short: "Gmail" },
  { id: 2, title: "Lateral search", short: "Lateral" },
  { id: 3, title: "Executive search", short: "Executive" },
  { id: 4, title: "Consulting search", short: "Consulting" },
  { id: 5, title: "Replace / versions", short: "Files" },
  { id: 6, title: "Drive account", short: "Drive" },
  { id: 7, title: "Drive folders", short: "Folders" },
  { id: 8, title: "Default schedule", short: "Schedule" },
  { id: 9, title: "Notifications", short: "Alerts" },
] as const;

const STEP_TO_DATASET: Partial<Record<number, DatasetSyncName>> = {
  2: "Lateral",
  3: "Executive",
  4: "Consulting",
};

type WizardDraft = Omit<DatasetSetupConfig, "updatedAt">;

interface DatasetSetupWizardProps {
  initial?: DatasetSetupConfig | null;
  editing?: boolean;
  onSaved: (setup: DatasetSetupConfig) => void;
  onCancel?: () => void;
  onReset?: () => void | Promise<void>;
}

function ChipList({
  values,
  onRemove,
}: {
  values: string[];
  onRemove: (value: string) => void;
}) {
  if (values.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {values.map((value) => (
        <span
          key={value}
          className="inline-flex items-center gap-1 rounded-lg bg-primary/10 px-2 py-1 text-xs font-medium text-primary"
        >
          {value}
          <button
            type="button"
            className="rounded p-0.5 hover:bg-primary/15"
            onClick={() => onRemove(value)}
            aria-label={`Remove ${value}`}
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
    </div>
  );
}

function OptionCard({
  selected,
  title,
  description,
  onClick,
}: {
  selected: boolean;
  title: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-xl border px-3 py-3 text-left transition-colors",
        selected
          ? "border-primary/50 bg-primary/10"
          : "border-border bg-background hover:bg-muted/40"
      )}
    >
      <p className="text-sm font-medium text-foreground">{title}</p>
      <p className="mt-1 text-xs text-muted-foreground">{description}</p>
    </button>
  );
}

function TagInput({
  label,
  hint,
  placeholder,
  values,
  draft,
  onDraftChange,
  onAdd,
  onRemove,
  inputType = "text",
}: {
  label: string;
  hint?: string;
  placeholder: string;
  values: string[];
  draft: string;
  onDraftChange: (value: string) => void;
  onAdd: () => void;
  onRemove: (value: string) => void;
  inputType?: "text" | "email";
}) {
  return (
    <div className="space-y-2">
      <div>
        <p className="text-sm font-medium text-foreground">{label}</p>
        {hint ? (
          <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>
        ) : null}
      </div>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          type={inputType}
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              onAdd();
            }
          }}
          placeholder={placeholder}
          className="h-10 rounded-xl"
        />
        <Button
          type="button"
          variant="outline"
          className="rounded-xl gap-1.5"
          onClick={onAdd}
        >
          <Plus className="size-4" />
          Add
        </Button>
      </div>
      <ChipList values={values} onRemove={onRemove} />
    </div>
  );
}

function DatasetSearchStep({
  datasetName,
  config,
  onChange,
  errorSetter,
}: {
  datasetName: DatasetSyncName;
  config: DatasetSearchConfig;
  onChange: (next: DatasetSearchConfig) => void;
  errorSetter: (message: string | null) => void;
}) {
  const [keywordDraft, setKeywordDraft] = React.useState("");
  const [keywordMode, setKeywordMode] =
    React.useState<KeywordMatchMode>("contains");

  function patch(partial: Partial<DatasetSearchConfig>) {
    onChange({ ...config, ...partial });
    errorSetter(null);
  }

  function addKeyword() {
    const value = keywordDraft.trim();
    if (!value) return;
    if (keywordMode === "regex") {
      try {
        void new RegExp(value, "i");
      } catch {
        errorSetter(`Invalid regex: ${value}`);
        return;
      }
    }
    const duplicate = config.keywords.some(
      (keyword) =>
        keyword.value.toLowerCase() === value.toLowerCase() &&
        keyword.matchMode === keywordMode
    );
    if (duplicate) {
      errorSetter(`That keyword is already listed for ${datasetName}.`);
      return;
    }
    const nextPriority =
      config.keywords.reduce(
        (max, keyword) => Math.max(max, keyword.priority),
        0
      ) + 1;
    patch({
      keywords: [
        ...config.keywords,
        createKeywordConfig(value, nextPriority, keywordMode, true),
      ],
    });
    setKeywordDraft("");
  }

  function updateKeyword(
    key: string,
    partial: Partial<DatasetKeywordConfig>
  ) {
    patch({
      keywords: config.keywords.map((keyword) => {
        const id = `${keyword.matchMode}::${keyword.value}`;
        return id === key ? { ...keyword, ...partial } : keyword;
      }),
    });
  }

  function removeKeyword(key: string) {
    const remaining = config.keywords
      .filter(
        (keyword) => `${keyword.matchMode}::${keyword.value}` !== key
      )
      .sort((a, b) => a.priority - b.priority)
      .map((keyword, index) => ({ ...keyword, priority: index + 1 }));
    patch({ keywords: remaining });
  }

  function moveKeyword(key: string, direction: -1 | 1) {
    const ordered = [...config.keywords].sort(
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
  }

  function toggleFileType(type: DatasetFileType) {
    const has = config.fileTypes.includes(type);
    const next = has
      ? config.fileTypes.filter((item) => item !== type)
      : [...config.fileTypes, type];
    patch({
      fileTypes: next.length > 0 ? next : [...DEFAULT_FILE_TYPES],
    });
  }

  return (
    <StepShell
      title={`${datasetName} — keyword library`}
      hint={`Gmail scans all Excel emails on the selected date. Keywords assign matches to ${datasetName} (attachment name → subject → body). Senders are not required.`}
    >
      <label className="flex items-start gap-3 rounded-xl border border-border px-3 py-3">
        <input
          type="checkbox"
          className="mt-1"
          checked={config.enabled}
          onChange={(event) => patch({ enabled: event.target.checked })}
        />
        <span>
          <span className="block text-sm font-medium">
            Enable {datasetName} matching
          </span>
          <span className="text-xs text-muted-foreground">
            When disabled, this dataset is skipped during Gmail scan and sync.
          </span>
        </span>
      </label>

      <fieldset
        disabled={!config.enabled}
        className={cn("space-y-4", !config.enabled && "opacity-50")}
      >
        <div className="space-y-2">
          <div>
            <p className="text-sm font-medium text-foreground">
              Search Keywords
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Matched against attachment file name, email subject, and body.
              Any enabled keyword assigns the email to {datasetName}. Priority 1
              wins when several match.
            </p>
          </div>
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
          {config.keywords.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              Add at least one keyword so {datasetName} can be matched.
            </p>
          ) : (
            <ul className="space-y-2">
              {[...config.keywords]
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

        <div className="space-y-2">
          <p className="text-sm font-medium text-foreground">
            Supported File Types
          </p>
          <div className="flex flex-wrap gap-2">
            {DEFAULT_FILE_TYPES.map((type) => (
              <label
                key={type}
                className={cn(
                  "inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-sm",
                  config.fileTypes.includes(type)
                    ? "border-primary/40 bg-primary/10 text-primary"
                    : "border-border bg-background"
                )}
              >
                <input
                  type="checkbox"
                  checked={config.fileTypes.includes(type)}
                  onChange={() => toggleFileType(type)}
                />
                .{type}
              </label>
            ))}
          </div>
        </div>
      </fieldset>
    </StepShell>
  );
}

export function DatasetSetupWizard({
  initial,
  editing = Boolean(initial),
  onSaved,
  onCancel,
  onReset,
}: DatasetSetupWizardProps) {
  const [step, setStep] = React.useState(1);
  const [draft, setDraft] = React.useState<WizardDraft>(() =>
    withSetupDefaults(initial)
  );
  const [baseline, setBaseline] = React.useState<WizardDraft>(() =>
    withSetupDefaults(initial)
  );
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [resetting, setResetting] = React.useState(false);
  const [info, setInfo] = React.useState<string | null>(null);

  React.useEffect(() => {
    const next = withSetupDefaults(initial);
    setDraft(next);
    setBaseline(next);
    setStep(1);
    setError(null);
    setInfo(null);
  }, [initial?.updatedAt]);

  const gmailChanged =
    Boolean(baseline.gmailAddress) &&
    draft.gmailAddress.trim().toLowerCase() !==
      baseline.gmailAddress.trim().toLowerCase();
  const driveChanged =
    Boolean(baseline.driveAccountEmail) &&
    draft.driveAccountEmail.trim().toLowerCase() !==
      baseline.driveAccountEmail.trim().toLowerCase();

  const visibleSteps = [...STEPS];
  const stepIndex = visibleSteps.findIndex((item) => item.id === step);
  const isLast = stepIndex === visibleSteps.length - 1;

  function update<K extends keyof WizardDraft>(
    key: K,
    value: WizardDraft[K]
  ) {
    setDraft((prev) => {
      const next = { ...prev, [key]: value };
      if (key === "gmailAddress") {
        const changed =
          String(value).trim().toLowerCase() !==
          baseline.gmailAddress.trim().toLowerCase();
        if (changed) {
          setInfo(
            "Gmail account changed. Reconnect Gmail OAuth after saving if needed."
          );
        }
      }
      if (key === "driveAccountEmail") {
        const changed =
          String(value).trim().toLowerCase() !==
          baseline.driveAccountEmail.trim().toLowerCase();
        if (changed) {
          next.driveAuthStatus = "pending";
          setInfo(
            "Google Drive account changed. Re-authenticate Drive before saving."
          );
        } else if (
          baseline.driveAuthStatus === "authenticated" &&
          String(value).trim().toLowerCase() ===
            baseline.driveAccountEmail.trim().toLowerCase()
        ) {
          next.driveAuthStatus = "authenticated";
          setInfo(null);
        }
      }
      return next;
    });
    setError(null);
  }

  function updateDataset(
    datasetName: DatasetSyncName,
    next: DatasetSearchConfig
  ) {
    setDraft((prev) => ({
      ...prev,
      datasets: {
        ...prev.datasets,
        [datasetName]: next,
      },
    }));
    setError(null);
  }

  function updateDriveFolder(
    datasetName: DatasetSyncName,
    partial: Partial<DatasetDriveFolderConfig>
  ) {
    setDraft((prev) => ({
      ...prev,
      datasets: {
        ...prev.datasets,
        [datasetName]: {
          ...prev.datasets[datasetName],
          driveFolder: {
            ...prev.datasets[datasetName].driveFolder,
            ...partial,
          },
        },
      },
    }));
    setError(null);
  }

  function validateDatasetConfig(
    name: DatasetSyncName,
    config: DatasetSearchConfig
  ): string | null {
    if (!config.enabled) return null;
    if (config.fileTypes.length === 0) {
      return `${name}: select at least one supported file type.`;
    }
    if (getEnabledKeywords(config).length === 0) {
      return `${name}: add and enable at least one keyword, or disable this dataset.`;
    }
    return null;
  }

  function validateCurrentStep(): string | null {
    switch (step) {
      case 1:
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/i.test(draft.gmailAddress.trim())) {
          return "Enter the Gmail address that should be monitored.";
        }
        return null;
      case 2:
      case 3:
      case 4: {
        const name = STEP_TO_DATASET[step];
        if (!name) return null;
        return validateDatasetConfig(name, draft.datasets[name]);
      }
      case 5:
        return null;
      case 6:
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/i.test(draft.driveAccountEmail.trim())) {
          return "Enter which Google Drive account should receive files.";
        }
        if (draft.driveAuthStatus !== "authenticated") {
          return driveChanged
            ? "Drive account changed — re-authenticate Google Drive to continue."
            : "Authenticate the Google Drive account to continue.";
        }
        return null;
      case 7: {
        for (const name of DATASET_SYNC_NAMES) {
          const dataset = draft.datasets[name];
          if (!dataset.enabled) continue;
          const folder = dataset.driveFolder;
          if (folder.mode === "folder_id" && !folder.folderId.trim()) {
            return `${name}: enter the Google Drive Folder ID.`;
          }
          if (folder.mode === "folder_url" && !folder.folderUrl.trim()) {
            return `${name}: enter the Google Drive Folder URL.`;
          }
          if (
            folder.mode === "picker" &&
            !folder.folderName.trim() &&
            !folder.folderId.trim()
          ) {
            return `${name}: choose a Drive folder (name or ID).`;
          }
          if (folder.folderId === "pending-picker-folder-id") {
            return `${name}: replace the placeholder with a real Folder ID.`;
          }
        }
        return null;
      }
      case 8:
        if (draft.syncFrequency === "custom") {
          if (!(draft.customDays?.length)) {
            return "Select at least one day for the custom schedule.";
          }
          if (!(draft.customTimes?.length)) {
            return "Add at least one time for the custom schedule.";
          }
        }
        return null;
      case 9: {
        if (
          draft.alertEmail.trim() &&
          !/^[^\s@]+@[^\s@]+\.[^\s@]+$/i.test(draft.alertEmail.trim())
        ) {
          return "Enter a valid notification email, or leave it blank.";
        }
        const enabled = DATASET_SYNC_NAMES.filter(
          (name) => draft.datasets[name].enabled
        );
        if (enabled.length === 0) {
          return "Enable at least one dataset (Lateral, Executive, or Consulting).";
        }
        for (const name of DATASET_SYNC_NAMES) {
          const err = validateDatasetConfig(name, draft.datasets[name]);
          if (err) return err;
        }
        return null;
      }
      default:
        return null;
    }
  }

  function goNext() {
    const validationError = validateCurrentStep();
    if (validationError) {
      setError(validationError);
      return;
    }
    const next = visibleSteps[stepIndex + 1];
    if (next) setStep(next.id);
  }

  function goBack() {
    const prev = visibleSteps[stepIndex - 1];
    if (prev) {
      setStep(prev.id);
      setError(null);
    }
  }

  async function saveSetup() {
    const validationError = validateCurrentStep();
    if (validationError) {
      setError(validationError);
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/dataset/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      const payload = (await response.json().catch(() => null)) as {
        error?: string;
        setup?: DatasetSetupConfig;
        message?: string;
        requiresReauth?: { gmail?: boolean; drive?: boolean };
      } | null;
      if (!response.ok || !payload?.setup) {
        throw new Error(payload?.error ?? "Failed to save configuration.");
      }
      onSaved(payload.setup);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to save configuration."
      );
    } finally {
      setSaving(false);
    }
  }

  function handleCancel() {
    setDraft(baseline);
    setStep(1);
    setError(null);
    setInfo(null);
    onCancel?.();
  }

  async function handleReset() {
    if (
      !window.confirm(
        "Reset configuration? Automation will stop until you configure Dataset again."
      )
    ) {
      return;
    }
    setResetting(true);
    setError(null);
    try {
      if (onReset) {
        await onReset();
        return;
      }
      const response = await fetch("/api/dataset/setup", { method: "DELETE" });
      const payload = (await response.json().catch(() => null)) as {
        error?: string;
      } | null;
      if (!response.ok) {
        throw new Error(payload?.error ?? "Failed to reset configuration.");
      }
      const empty = createEmptyDatasetSetup();
      setDraft(empty);
      setBaseline(empty);
      setStep(1);
      onSaved({ ...empty, updatedAt: new Date(0).toISOString() });
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to reset configuration."
      );
    } finally {
      setResetting(false);
    }
  }

  const activeDataset = STEP_TO_DATASET[step];

  return (
    <Card className="shadow-sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldCheck className="size-4 text-primary" />
          {editing ? "Edit dataset configuration" : "Dataset setup wizard"}
        </CardTitle>
        <CardDescription>
          {editing
            ? "Each dataset has its own keywords, Drive folder, and file types. Gmail is scanned by date — not by sender."
            : "Configure keywords for Lateral, Executive, and Consulting, then connect Drive and scheduling."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {(gmailChanged || driveChanged) && (
          <p className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-200">
            {gmailChanged && driveChanged
              ? "Gmail and Google Drive accounts changed — re-authentication is required for the new accounts."
              : gmailChanged
                ? "Gmail account changed — reconnect Gmail OAuth after saving if the mailbox differs."
                : "Google Drive account changed — re-authenticate Drive before saving."}
          </p>
        )}
        {info && !gmailChanged && !driveChanged ? (
          <p className="rounded-xl border border-primary/20 bg-primary/5 px-3 py-2 text-sm text-primary">
            {info}
          </p>
        ) : null}
        <ol className="flex flex-wrap gap-2">
          {visibleSteps.map((item, index) => {
            const active = item.id === step;
            const done = index < stepIndex;
            return (
              <li
                key={item.id}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-lg border px-2 py-1 text-[11px] font-medium",
                  active && "border-primary/40 bg-primary/10 text-primary",
                  done && !active && "border-border text-foreground",
                  !done && !active && "border-border text-muted-foreground"
                )}
              >
                <span
                  className={cn(
                    "flex size-4 items-center justify-center rounded-full text-[10px]",
                    active || done
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted text-muted-foreground"
                  )}
                >
                  {done ? <Check className="size-2.5" /> : index + 1}
                </span>
                {item.short}
              </li>
            );
          })}
        </ol>

        <div className="rounded-2xl border border-border bg-muted/15 px-4 py-4">
          {step === 1 ? (
            <StepShell
              title="Which Gmail account should be monitored?"
              hint="One shared mailbox. Each dataset still searches with its own filters."
            >
              <label className="block space-y-1.5 text-sm">
                <span className="font-medium text-foreground">Email Address</span>
                <Input
                  type="email"
                  value={draft.gmailAddress}
                  onChange={(event) =>
                    update("gmailAddress", event.target.value)
                  }
                  placeholder="name@company.com"
                  className="h-10 rounded-xl"
                  autoComplete="email"
                />
              </label>
            </StepShell>
          ) : null}

          {activeDataset ? (
            <DatasetSearchStep
              key={activeDataset}
              datasetName={activeDataset}
              config={draft.datasets[activeDataset]}
              onChange={(next) => updateDataset(activeDataset, next)}
              errorSetter={setError}
            />
          ) : null}

          {step === 5 ? (
            <StepShell title="Replace existing file or keep version history?">
              <div className="grid gap-2 sm:grid-cols-3">
                {(
                  [
                    {
                      value: "replace" as FileReplacePolicy,
                      title: "Replace existing file",
                      description:
                        "Overwrite the previous file in Drive and Dataset Manager.",
                    },
                    {
                      value: "keep_old" as FileReplacePolicy,
                      title: "Keep old file",
                      description:
                        "Upload new copies without replacing Dataset Manager current.",
                    },
                    {
                      value: "version_history" as FileReplacePolicy,
                      title: "Version history",
                      description:
                        "Archive each prior file, then promote the new one.",
                    },
                  ] as const
                ).map((option) => (
                  <OptionCard
                    key={option.value}
                    selected={draft.fileReplacePolicy === option.value}
                    title={option.title}
                    description={option.description}
                    onClick={() => update("fileReplacePolicy", option.value)}
                  />
                ))}
              </div>
            </StepShell>
          ) : null}

          {step === 6 ? (
            <StepShell
              title="Which Google Drive account should receive the files?"
              hint="Do not use a hardcoded account. Authenticate the account that owns the destination Drive."
            >
              <label className="block space-y-1.5 text-sm">
                <span className="font-medium text-foreground">
                  Google Drive account email
                </span>
                <Input
                  type="email"
                  value={draft.driveAccountEmail}
                  onChange={(event) =>
                    update("driveAccountEmail", event.target.value)
                  }
                  placeholder="drive-owner@company.com"
                  className="h-10 rounded-xl"
                />
              </label>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  className="rounded-xl gap-2"
                  onClick={() => {
                    if (
                      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/i.test(
                        draft.driveAccountEmail.trim()
                      )
                    ) {
                      setError("Enter a valid Drive account email first.");
                      return;
                    }
                    update("driveAuthStatus", "authenticated");
                    setError(null);
                    setInfo(
                      driveChanged
                        ? "Drive re-authenticated for the new account."
                        : editing
                          ? "Existing Drive authentication kept — no reconnect needed."
                          : null
                    );
                  }}
                >
                  <HardDrive className="size-4" />
                  {draft.driveAuthStatus === "authenticated" && !driveChanged
                    ? "Authenticated"
                    : driveChanged
                      ? "Re-authenticate with Google"
                      : "Authenticate with Google"}
                </Button>
                <span
                  className={cn(
                    "text-xs font-medium",
                    draft.driveAuthStatus === "authenticated"
                      ? "text-emerald-600 dark:text-emerald-400"
                      : "text-muted-foreground"
                  )}
                >
                  {draft.driveAuthStatus === "authenticated"
                    ? driveChanged
                      ? "Ready to save with new Drive account"
                      : "No re-authentication required"
                    : "Authentication required"}
                </span>
              </div>
            </StepShell>
          ) : null}

          {step === 7 ? (
            <StepShell
              title="Map each dataset to its own Google Drive folder"
              hint="Lateral, Executive, and Consulting never share a folder. Uploads go only to the mapped destination."
            >
              <div className="space-y-4">
                {DATASET_SYNC_NAMES.map((name) => {
                  const folder = draft.datasets[name].driveFolder;
                  const enabled = draft.datasets[name].enabled;
                  return (
                    <div
                      key={name}
                      className={cn(
                        "space-y-3 rounded-xl border border-border bg-background px-3 py-3",
                        !enabled && "opacity-60"
                      )}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-sm font-semibold text-foreground">
                          {name} → Google Drive Folder
                        </p>
                        {!enabled ? (
                          <span className="text-xs text-muted-foreground">
                            Dataset disabled — folder optional
                          </span>
                        ) : null}
                      </div>
                      <div className="grid gap-2 sm:grid-cols-3">
                        {(
                          [
                            {
                              value: "picker" as DriveFolderInputMode,
                              title: "Folder Picker",
                              description: "Choose visually.",
                            },
                            {
                              value: "folder_id" as DriveFolderInputMode,
                              title: "Folder ID",
                              description: "Paste the folder ID.",
                            },
                            {
                              value: "folder_url" as DriveFolderInputMode,
                              title: "Folder URL",
                              description: "Paste the Drive link.",
                            },
                          ] as const
                        ).map((option) => (
                          <OptionCard
                            key={option.value}
                            selected={folder.mode === option.value}
                            title={option.title}
                            description={option.description}
                            onClick={() =>
                              updateDriveFolder(name, { mode: option.value })
                            }
                          />
                        ))}
                      </div>

                      {folder.mode === "picker" ? (
                        <div className="space-y-2">
                          <Button
                            type="button"
                            variant="outline"
                            className="rounded-xl gap-2"
                            onClick={() => {
                              updateDriveFolder(name, {
                                folderName:
                                  folder.folderName || `ATCI ${name}`,
                                folderId:
                                  folder.folderId ||
                                  "pending-picker-folder-id",
                              });
                            }}
                          >
                            <FolderOpen className="size-4" />
                            Open folder picker
                          </Button>
                          <Input
                            value={folder.folderName}
                            onChange={(event) =>
                              updateDriveFolder(name, {
                                folderName: event.target.value,
                              })
                            }
                            placeholder={`e.g. ATCI ${name}`}
                            className="h-10 rounded-xl"
                          />
                          <Input
                            value={folder.folderId}
                            onChange={(event) =>
                              updateDriveFolder(name, {
                                folderId: event.target.value,
                              })
                            }
                            placeholder="Selected folder ID"
                            className="h-10 rounded-xl"
                          />
                        </div>
                      ) : null}

                      {folder.mode === "folder_id" ? (
                        <div className="space-y-2">
                          <Input
                            value={folder.folderName}
                            onChange={(event) =>
                              updateDriveFolder(name, {
                                folderName: event.target.value,
                              })
                            }
                            placeholder={`Folder name (e.g. ATCI ${name})`}
                            className="h-10 rounded-xl"
                          />
                          <Input
                            value={folder.folderId}
                            onChange={(event) =>
                              updateDriveFolder(name, {
                                folderId: event.target.value,
                              })
                            }
                            placeholder="Google Drive Folder ID"
                            className="h-10 rounded-xl"
                          />
                        </div>
                      ) : null}

                      {folder.mode === "folder_url" ? (
                        <div className="space-y-2">
                          <Input
                            value={folder.folderName}
                            onChange={(event) =>
                              updateDriveFolder(name, {
                                folderName: event.target.value,
                              })
                            }
                            placeholder={`Folder name (e.g. ATCI ${name})`}
                            className="h-10 rounded-xl"
                          />
                          <Input
                            value={folder.folderUrl}
                            onChange={(event) =>
                              updateDriveFolder(name, {
                                folderUrl: event.target.value,
                              })
                            }
                            placeholder="https://drive.google.com/drive/folders/…"
                            className="h-10 rounded-xl"
                          />
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </StepShell>
          ) : null}

          {step === 8 ? (
            <StepShell
              title="Seed schedule (optional)"
              hint="This creates your first automation schedule after save. Add more anytime in Dataset Manager → Automation schedules (unlimited, per-dataset)."
            >
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                {(
                  [
                    {
                      value: "hourly" as SyncFrequency,
                      title: "Every Hour",
                      description: "Sync once per hour.",
                    },
                    {
                      value: "daily" as SyncFrequency,
                      title: "Daily",
                      description: "Once per day at the chosen time.",
                    },
                    {
                      value: "weekdays" as SyncFrequency,
                      title: "Weekdays",
                      description: "Monday–Friday only.",
                    },
                    {
                      value: "custom" as SyncFrequency,
                      title: "Custom",
                      description: "Pick days and one or more times.",
                    },
                  ] as const
                ).map((option) => (
                  <OptionCard
                    key={option.value}
                    selected={draft.syncFrequency === option.value}
                    title={option.title}
                    description={option.description}
                    onClick={() => update("syncFrequency", option.value)}
                  />
                ))}
              </div>

              {draft.syncFrequency === "daily" ||
              draft.syncFrequency === "weekdays" ? (
                <label className="block space-y-1.5 text-sm">
                  <span className="font-medium text-foreground">
                    Sync time (default 07:00)
                  </span>
                  <Input
                    type="time"
                    value={draft.syncTime || DEFAULT_SYNC_TIME}
                    onChange={(event) => update("syncTime", event.target.value)}
                    className="h-10 max-w-xs rounded-xl"
                  />
                </label>
              ) : null}

              {draft.syncFrequency === "custom" ? (
                <div className="space-y-3">
                  <div className="space-y-2">
                    <p className="text-sm font-medium">Days</p>
                    <div className="flex flex-wrap gap-2">
                      {(
                        ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const
                      ).map((label, day) => {
                        const days = draft.customDays ?? [1, 2, 3, 4, 5];
                        const selected = days.includes(day);
                        return (
                          <button
                            key={label}
                            type="button"
                            onClick={() => {
                              const next = selected
                                ? days.filter((item) => item !== day)
                                : [...days, day].sort((a, b) => a - b);
                              update("customDays", next);
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
                      <p className="text-sm font-medium">Times</p>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="rounded-lg"
                        onClick={() => {
                          const times = draft.customTimes?.length
                            ? draft.customTimes
                            : [draft.syncTime || DEFAULT_SYNC_TIME];
                          update("customTimes", [...times, "14:00"]);
                        }}
                      >
                        Add time
                      </Button>
                    </div>
                    {(draft.customTimes?.length
                      ? draft.customTimes
                      : [draft.syncTime || DEFAULT_SYNC_TIME]
                    ).map((time, index) => (
                      <div
                        key={`${time}-${index}`}
                        className="flex max-w-sm items-center gap-2"
                      >
                        <Input
                          type="time"
                          value={time}
                          onChange={(event) => {
                            const times = [
                              ...(draft.customTimes?.length
                                ? draft.customTimes
                                : [draft.syncTime || DEFAULT_SYNC_TIME]),
                            ];
                            times[index] = event.target.value;
                            update("customTimes", times);
                            if (index === 0) update("syncTime", event.target.value);
                          }}
                          className="h-10 rounded-xl"
                        />
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="rounded-lg text-destructive"
                          disabled={
                            (draft.customTimes?.length ?? 1) <= 1
                          }
                          onClick={() => {
                            const times = [
                              ...(draft.customTimes?.length
                                ? draft.customTimes
                                : [draft.syncTime || DEFAULT_SYNC_TIME]),
                            ];
                            if (times.length <= 1) return;
                            times.splice(index, 1);
                            update("customTimes", times);
                          }}
                        >
                          Remove
                        </Button>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </StepShell>
          ) : null}

          {step === 9 ? (
            <StepShell
              title="Notification settings"
              hint="In-app bell alerts always run. Optional email alerts use SMTP (ARA_ALERT_*) or the alert address below."
            >
              <label className="flex items-start gap-3 rounded-xl border border-border px-3 py-3">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={draft.notifyOnFailure}
                  onChange={(event) =>
                    update("notifyOnFailure", event.target.checked)
                  }
                />
                <span>
                  <span className="block text-sm font-medium">
                    Notify on failure
                  </span>
                  <span className="text-xs text-muted-foreground">
                    Alert when download, validation, or Drive upload fails.
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-3 rounded-xl border border-border px-3 py-3">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={draft.notifyOnSuccess}
                  onChange={(event) =>
                    update("notifyOnSuccess", event.target.checked)
                  }
                />
                <span>
                  <span className="block text-sm font-medium">
                    Notify on success
                  </span>
                  <span className="text-xs text-muted-foreground">
                    Also notify when a dataset syncs successfully.
                  </span>
                </span>
              </label>
              <label className="block space-y-1.5 text-sm">
                <span className="font-medium text-foreground">
                  Alert email (optional)
                </span>
                <Input
                  type="email"
                  value={draft.alertEmail}
                  onChange={(event) => update("alertEmail", event.target.value)}
                  placeholder={draft.gmailAddress || "alerts@company.com"}
                  className="h-10 rounded-xl"
                />
              </label>
            </StepShell>
          ) : null}
        </div>

        {error ? (
          <p className="rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              className="rounded-xl gap-1.5"
              onClick={goBack}
              disabled={stepIndex <= 0 || saving || resetting}
            >
              <ChevronLeft className="size-4" />
              Back
            </Button>
            {editing && onCancel ? (
              <Button
                type="button"
                variant="ghost"
                className="rounded-xl"
                onClick={handleCancel}
                disabled={saving || resetting}
              >
                Cancel
              </Button>
            ) : null}
            {editing ? (
              <Button
                type="button"
                variant="outline"
                className="rounded-xl text-destructive hover:text-destructive"
                onClick={() => void handleReset()}
                disabled={saving || resetting}
              >
                {resetting ? "Resetting…" : "Reset Configuration"}
              </Button>
            ) : null}
          </div>

          {isLast ? (
            <Button
              type="button"
              className="rounded-xl gap-1.5"
              onClick={() => void saveSetup()}
              disabled={saving || resetting}
            >
              <Mail className="size-4" />
              {saving
                ? "Saving…"
                : editing
                  ? "Save Changes"
                  : "Save setup securely"}
            </Button>
          ) : (
            <Button
              type="button"
              className="rounded-xl gap-1.5"
              onClick={goNext}
              disabled={saving || resetting}
            >
              Continue
              <ChevronRight className="size-4" />
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function StepShell({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        {hint ? (
          <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
        ) : null}
      </div>
      <div className="space-y-3">{children}</div>
    </div>
  );
}
