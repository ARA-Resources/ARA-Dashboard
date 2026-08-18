"use client";

import * as React from "react";
import { HardDrive, Mail, RefreshCw, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  type DatasetDriveFolderConfig,
  type DatasetSetupConfig,
  type DriveFolderInputMode,
} from "@/types/dataset-setup";
import { DATASET_SYNC_NAMES, type DatasetSyncName } from "@/types/dataset-sync";

export interface UpdateGmailDrivePanelProps {
  setup: DatasetSetupConfig;
  onCancel: () => void;
  onSaved: (setup: DatasetSetupConfig, options: { emailChanged: boolean }) => void;
}

function isValidEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/i.test(value.trim());
}

function folderConfigured(folder: DatasetDriveFolderConfig) {
  if (folder.mode === "folder_url") return Boolean(folder.folderUrl.trim());
  return Boolean(folder.folderId.trim());
}

export function UpdateGmailDrivePanel({
  setup,
  onCancel,
  onSaved,
}: UpdateGmailDrivePanelProps) {
  const [gmailAddress, setGmailAddress] = React.useState(setup.gmailAddress);
  const [folders, setFolders] = React.useState<
    Record<DatasetSyncName, DatasetDriveFolderConfig>
  >(() => ({
    Lateral: { ...setup.datasets.Lateral.driveFolder },
    Executive: { ...setup.datasets.Executive.driveFolder },
    Consulting: { ...setup.datasets.Consulting.driveFolder },
  }));
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [info, setInfo] = React.useState<string | null>(null);

  const originalEmail = setup.gmailAddress.trim().toLowerCase();

  function updateFolder(
    name: DatasetSyncName,
    patch: Partial<DatasetDriveFolderConfig>
  ) {
    setFolders((prev) => ({
      ...prev,
      [name]: { ...prev[name], ...patch },
    }));
  }

  async function handleSave() {
    setError(null);
    setInfo(null);

    const email = gmailAddress.trim().toLowerCase();
    if (!isValidEmail(email)) {
      setError("Enter a valid Gmail address.");
      return;
    }

    for (const name of DATASET_SYNC_NAMES) {
      const dataset = setup.datasets[name];
      if (!dataset?.enabled) continue;
      if (!folderConfigured(folders[name])) {
        setError(
          `${name} needs a Drive folder ID or URL. Each dataset must have its own folder.`
        );
        return;
      }
    }

    const emailChanged = email !== originalEmail;
    const next: DatasetSetupConfig = {
      ...setup,
      gmailAddress: email,
      // Shared Google account — Drive uses the same mailbox as Gmail.
      driveAccountEmail: email,
      driveAuthStatus: "authenticated",
      datasets: {
        ...setup.datasets,
        Lateral: {
          ...setup.datasets.Lateral,
          driveFolder: { ...folders.Lateral },
        },
        Executive: {
          ...setup.datasets.Executive,
          driveFolder: { ...folders.Executive },
        },
        Consulting: {
          ...setup.datasets.Consulting,
          driveFolder: { ...folders.Consulting },
        },
      },
      updatedAt: new Date().toISOString(),
    };

    setSaving(true);
    try {
      const response = await fetch("/api/dataset/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next),
      });
      const payload = (await response.json().catch(() => null)) as {
        error?: string;
        setup?: DatasetSetupConfig;
      } | null;
      if (!response.ok || !payload?.setup) {
        throw new Error(payload?.error ?? "Failed to save Gmail / Drive settings.");
      }

      if (emailChanged) {
        // Old OAuth tokens belong to the previous mailbox — disconnect so user reconnects.
        await fetch("/api/dataset/connections", { method: "DELETE" }).catch(
          () => undefined
        );
        setInfo(
          "Saved. Gmail ID changed — reconnect the shared Google account so Gmail and Drive use the new mailbox."
        );
      } else {
        setInfo("Saved Gmail ID and Drive folders.");
      }

      onSaved(payload.setup, { emailChanged });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-5 rounded-2xl border border-border/70 bg-card p-4 sm:p-5">
      <div className="space-y-1">
        <h2 className="text-base font-semibold text-foreground">
          Update Gmail ID & Drive folders
        </h2>
        <p className="text-sm text-muted-foreground">
          One Google account is shared by Lateral, Executive, and Consulting.
          Change the mailbox or remapped folders here without re-running the full setup wizard.
        </p>
      </div>

      <section className="space-y-3 rounded-xl border border-border/60 bg-muted/20 px-3 py-3">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <Mail className="size-4" />
          Gmail ID
        </div>
        <div className="space-y-1.5">
          <label
            htmlFor="update-gmail-id"
            className="text-sm font-medium text-foreground"
          >
            Mailbox to monitor
          </label>
          <Input
            id="update-gmail-id"
            type="email"
            value={gmailAddress}
            onChange={(event) => setGmailAddress(event.target.value)}
            placeholder="name@company.com"
            className="h-10 rounded-xl"
            autoComplete="email"
          />
          <p className="text-xs text-muted-foreground">
            Drive uses this same Google account. Changing it requires reconnecting OAuth after save.
          </p>
        </div>
      </section>

      <section className="space-y-3 rounded-xl border border-border/60 bg-muted/20 px-3 py-3">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <HardDrive className="size-4" />
          Drive folders (one per dataset)
        </div>
        <div className="space-y-4">
          {DATASET_SYNC_NAMES.map((name) => {
            const folder = folders[name];
            const enabled = setup.datasets[name]?.enabled !== false;
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
                    {name} → Google Drive folder
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
                        value: "folder_id" as DriveFolderInputMode,
                        title: "Folder ID",
                      },
                      {
                        value: "folder_url" as DriveFolderInputMode,
                        title: "Folder URL",
                      },
                      {
                        value: "picker" as DriveFolderInputMode,
                        title: "Name + ID",
                      },
                    ] as const
                  ).map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      className={cn(
                        "rounded-lg border px-3 py-2 text-left text-sm transition-colors",
                        folder.mode === option.value
                          ? "border-primary bg-primary/5 text-foreground"
                          : "border-border bg-muted/30 text-muted-foreground hover:bg-muted/50"
                      )}
                      onClick={() => updateFolder(name, { mode: option.value })}
                    >
                      {option.title}
                    </button>
                  ))}
                </div>

                <Input
                  value={folder.folderName}
                  onChange={(event) =>
                    updateFolder(name, { folderName: event.target.value })
                  }
                  placeholder={`Folder name (e.g. ATCI ${name})`}
                  className="h-10 rounded-xl"
                />

                {folder.mode === "folder_url" ? (
                  <Input
                    value={folder.folderUrl}
                    onChange={(event) =>
                      updateFolder(name, { folderUrl: event.target.value })
                    }
                    placeholder="https://drive.google.com/drive/folders/…"
                    className="h-10 rounded-xl"
                  />
                ) : (
                  <Input
                    value={folder.folderId}
                    onChange={(event) =>
                      updateFolder(name, { folderId: event.target.value })
                    }
                    placeholder="Google Drive Folder ID"
                    className="h-10 rounded-xl"
                  />
                )}
              </div>
            );
          })}
        </div>
      </section>

      {error ? (
        <p className="rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {info ? (
        <p className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300">
          {info}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          className="rounded-xl gap-2"
          disabled={saving}
          onClick={() => void handleSave()}
        >
          {saving ? (
            <RefreshCw className="size-4 animate-spin" />
          ) : (
            <Save className="size-4" />
          )}
          Save Gmail & folders
        </Button>
        <Button
          type="button"
          variant="outline"
          className="rounded-xl"
          disabled={saving}
          onClick={onCancel}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}
