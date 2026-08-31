"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { HardDrive, Mail, RefreshCw, Settings2 } from "lucide-react";
import { FadeIn } from "@/animations/fade-in";
import { PageHeader } from "@/components/layouts/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { buttonVariants } from "@/components/ui/button";
import { ROUTES } from "@/constants/routes";
import { cn } from "@/lib/utils";
import { apiFetch } from "@/lib/api/client";
import { gmailOAuthStartHref } from "@/lib/config/gmail-oauth-start";
import type { DatasetSetupConfig } from "@/types/dataset-setup";

const GmailInboxPanel = dynamic(
  () =>
    import("@/components/dataset/gmail-inbox-panel").then(
      (m) => m.GmailInboxPanel
    ),
  { ssr: false, loading: () => <Skeleton className="h-64 w-full rounded-2xl" /> }
);

const UpdateGmailDrivePanel = dynamic(
  () =>
    import("@/components/dataset/update-gmail-drive-panel").then(
      (m) => m.UpdateGmailDrivePanel
    ),
  { ssr: false, loading: () => <Skeleton className="h-64 w-full rounded-2xl" /> }
);

type ConnectionView = "hub" | "gmail" | "drive";

function StatusBadge({ connected }: { connected: boolean }) {
  return (
    <Badge
      variant="secondary"
      className={cn(
        "rounded-md font-medium",
        connected
          ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
          : "bg-rose-500/10 text-rose-700 dark:text-rose-300"
      )}
    >
      {connected ? "Connected" : "Not Connected"}
    </Badge>
  );
}

export function DatasetConnectionsPage({
  view = "hub",
}: {
  view?: ConnectionView;
}) {
  const [loading, setLoading] = React.useState(true);
  const [setup, setSetup] = React.useState<DatasetSetupConfig | null>(null);
  const [gmailConnected, setGmailConnected] = React.useState(false);
  const [driveConnected, setDriveConnected] = React.useState(false);
  const [email, setEmail] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [editingFolders, setEditingFolders] = React.useState(false);

  const refresh = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [setupRes, connRes] = await Promise.all([
        apiFetch("/api/dataset/setup"),
        apiFetch("/api/dataset/connections"),
      ]);
      const setupPayload = (await setupRes.json()) as {
        setup?: DatasetSetupConfig | null;
        error?: string;
      };
      const connPayload = (await connRes.json().catch(() => null)) as {
        email?: string | null;
        gmail?: { connected?: boolean };
        drive?: { connected?: boolean };
        error?: string;
      } | null;
      if (!setupRes.ok) {
        throw new Error(setupPayload.error ?? "Failed to load setup.");
      }
      setSetup(setupPayload.setup ?? null);
      setGmailConnected(Boolean(connPayload?.gmail?.connected));
      setDriveConnected(Boolean(connPayload?.drive?.connected));
      setEmail(connPayload?.email ?? setupPayload.setup?.gmailAddress ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load connections.");
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const title =
    view === "gmail"
      ? "Gmail Connection"
      : view === "drive"
        ? "Google Drive Connection"
        : "Common Connections";

  const description =
    view === "gmail"
      ? "One shared Gmail connection for Lateral, Executive, and Consulting."
      : view === "drive"
        ? "One shared Google Drive connection for all Dataset types. Same OAuth as Gmail."
        : "Shared Google account used by every Dataset type. Connect once — use everywhere.";

  if (loading) {
    return (
      <div className="space-y-4">
        <PageHeader title={title} description={description} />
        <Skeleton className="h-40 w-full rounded-2xl" />
        <Skeleton className="h-64 w-full rounded-2xl" />
      </div>
    );
  }

  if (editingFolders && setup) {
    return (
      <div className="space-y-4">
        <PageHeader
          title="Update Gmail ID & Drive folders"
          description="Shared mailbox and per-dataset Drive folder mapping."
        />
        <UpdateGmailDrivePanel
          setup={setup}
          onCancel={() => setEditingFolders(false)}
          onSaved={(next, options) => {
            setSetup(next);
            setEditingFolders(false);
            if (options.emailChanged) {
              setGmailConnected(false);
              setDriveConnected(false);
              setEmail(next.gmailAddress);
            }
            void refresh();
          }}
        />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <PageHeader title={title} description={description} />

      {error ? (
        <p className="rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <FadeIn>
        <div className="rounded-2xl border border-border/70 bg-card/60 p-4 sm:p-5">
          <p className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Shared by Lateral · Executive · Consulting
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-xl border border-border/60 bg-muted/20 px-3 py-3">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <Mail className="size-4 text-primary" />
                  Gmail Connection
                </div>
                <StatusBadge connected={gmailConnected} />
              </div>
              <p className="mt-2 break-all text-sm text-muted-foreground">
                {email || setup?.gmailAddress || "Not connected"}
              </p>
              {view === "hub" ? (
                <Link
                  href={ROUTES.datasetConnectionsGmail}
                  className={cn(
                    buttonVariants({ variant: "outline", size: "sm" }),
                    "mt-3 rounded-xl"
                  )}
                >
                  Manage Gmail
                </Link>
              ) : null}
            </div>
            <div className="rounded-xl border border-border/60 bg-muted/20 px-3 py-3">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <HardDrive className="size-4 text-primary" />
                  Google Drive Connection
                </div>
                <StatusBadge connected={driveConnected} />
              </div>
              <p className="mt-2 break-all text-sm text-muted-foreground">
                {email || setup?.driveAccountEmail || "Not connected"}
              </p>
              {view === "hub" ? (
                <Link
                  href={ROUTES.datasetConnectionsDrive}
                  className={cn(
                    buttonVariants({ variant: "outline", size: "sm" }),
                    "mt-3 rounded-xl"
                  )}
                >
                  Manage Drive
                </Link>
              ) : null}
            </div>
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              className="rounded-xl gap-2"
              onClick={() => {
                window.location.href = gmailOAuthStartHref(
                  setup?.gmailAddress || email
                );
              }}
            >
              <RefreshCw className="size-4" />
              {gmailConnected || driveConnected
                ? "Reconnect shared Google account"
                : "Connect shared Google account"}
            </Button>
            {setup ? (
              <Button
                type="button"
                variant="outline"
                className="rounded-xl gap-2"
                onClick={() => setEditingFolders(true)}
              >
                <Settings2 className="size-4" />
                Update Gmail ID & Drive folders
              </Button>
            ) : (
              <Link
                href={`${ROUTES.datasetLateral}?edit=1`}
                className={cn(
                  buttonVariants({ variant: "outline" }),
                  "rounded-xl"
                )}
              >
                Complete Dataset setup first
              </Link>
            )}
          </div>
        </div>
      </FadeIn>

      {view === "gmail" && setup ? (
        <FadeIn>
          <GmailInboxPanel setupEmail={setup.gmailAddress} />
        </FadeIn>
      ) : null}

      {view === "drive" && setup ? (
        <FadeIn>
          <div className="space-y-3 rounded-2xl border border-border/70 bg-card/60 p-4 sm:p-5">
            <h3 className="text-sm font-semibold text-foreground">
              Per-dataset Drive folders
            </h3>
            <p className="text-sm text-muted-foreground">
              Lateral, Executive, and Consulting each upload to their own mapped
              folder. They share this one Drive connection.
            </p>
            <ul className="space-y-2 text-sm">
              {(["Lateral", "Executive", "Consulting"] as const).map((name) => {
                const folder = setup.datasets?.[name]?.driveFolder;
                const label =
                  folder?.folderName ||
                  folder?.folderId ||
                  folder?.folderUrl ||
                  "Not mapped";
                return (
                  <li
                    key={name}
                    className="flex flex-wrap items-baseline justify-between gap-2 rounded-lg border border-border/50 bg-muted/15 px-3 py-2"
                  >
                    <span className="font-medium text-foreground">{name}</span>
                    <span className="break-all text-muted-foreground">
                      {label}
                    </span>
                  </li>
                );
              })}
            </ul>
            <Button
              type="button"
              className="rounded-xl gap-2"
              onClick={() => setEditingFolders(true)}
            >
              <Settings2 className="size-4" />
              Edit Drive folders
            </Button>
          </div>
        </FadeIn>
      ) : null}

      {!setup ? (
        <p className="text-sm text-muted-foreground">
          No Dataset setup found. Open{" "}
          <Link
            href={ROUTES.datasetLateral}
            className="font-medium text-primary underline-offset-4 hover:underline"
          >
            Lateral
          </Link>{" "}
          to complete the setup wizard.
        </p>
      ) : null}
    </div>
  );
}
