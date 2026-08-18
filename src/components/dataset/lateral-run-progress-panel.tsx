"use client";

import * as React from "react";
import { CheckCircle2, Circle, Loader2, MinusCircle, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { LateralRunProgressSnapshot } from "@/types/lateral-scheduler";

function StageIcon({
  status,
}: {
  status: LateralRunProgressSnapshot["stages"][number]["status"];
}) {
  if (status === "active") {
    return <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" />;
  }
  if (status === "ok") {
    return <CheckCircle2 className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />;
  }
  if (status === "failed") {
    return <XCircle className="size-3.5 shrink-0 text-destructive" />;
  }
  if (status === "skipped") {
    return <MinusCircle className="size-3.5 shrink-0 text-muted-foreground" />;
  }
  return <Circle className="size-3.5 shrink-0 text-muted-foreground/50" />;
}

export function LateralRunProgressPanel({
  progress,
  compact = false,
}: {
  progress: LateralRunProgressSnapshot;
  compact?: boolean;
}) {
  const visibleStages = compact
    ? progress.stages.filter(
        (s) =>
          s.status === "active" ||
          s.status === "failed" ||
          (s.status === "ok" &&
            !s.id.startsWith("pipeline_")) ||
          s.id === `pipeline_${progress.pipelineStep}`
      )
    : progress.stages;

  const showFullList = !compact || visibleStages.length === 0;

  return (
    <div className="rounded-xl border border-border/80 bg-muted/20 px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium text-foreground">
          {progress.active ? "Lateral Dataset Sync in progress" : "Lateral Dataset Sync"}
        </p>
        {progress.pipelineStep ? (
          <span className="text-xs text-muted-foreground">
            Pipeline step {progress.pipelineStep}/{progress.pipelineStepTotal}
          </span>
        ) : null}
      </div>
      {progress.currentStageLabel ? (
        <p className="mt-1 text-xs text-muted-foreground">{progress.currentStageLabel}</p>
      ) : null}
      <ol className="mt-3 space-y-1.5">
        {(showFullList ? progress.stages : visibleStages).map((stage) => (
          <li
            key={stage.id}
            className={cn(
              "flex items-start gap-2 text-xs",
              stage.status === "active" && "font-medium text-foreground",
              stage.status === "pending" && "text-muted-foreground/70",
              stage.status === "skipped" && "text-muted-foreground",
              stage.status === "failed" && "text-destructive"
            )}
          >
            <StageIcon status={stage.status} />
            <span className="min-w-0 flex-1">{stage.label}</span>
            {stage.detail && stage.status !== "pending" ? (
              <span className="max-w-[45%] truncate text-[10px] text-muted-foreground">
                {stage.detail}
              </span>
            ) : null}
          </li>
        ))}
      </ol>
    </div>
  );
}
