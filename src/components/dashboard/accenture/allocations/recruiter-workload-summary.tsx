"use client";

import { Scale, Users } from "lucide-react";
import type { RecruiterWorkloadSummary } from "@/types/recruiter-workload";
import { cn } from "@/lib/utils";

interface RecruiterWorkloadSummaryProps {
  summary: RecruiterWorkloadSummary;
  className?: string;
}

function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string | number;
  hint?: string;
}) {
  return (
    <div className="min-w-0 rounded-xl border border-border/70 bg-background/70 px-3 py-2.5">
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p className="mt-0.5 text-lg font-semibold tabular-nums text-foreground">
        {value}
      </p>
      {hint ? (
        <p className="mt-0.5 text-[11px] text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

export function RecruiterWorkloadPanel({
  summary,
  className,
}: RecruiterWorkloadSummaryProps) {
  const maxOpenings = Math.max(
    1,
    ...summary.recruiters.map((row) => row.openingCount)
  );
  const avg = summary.averageOpeningsPerRecruiter;

  return (
    <section
      className={cn(
        "rounded-2xl border border-border bg-card p-4 shadow-sm",
        className
      )}
      aria-label="Recruiter workload summary"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Scale className="size-4 text-primary" />
            <h2 className="text-sm font-semibold text-foreground">
              Recruiter distribution & workload
            </h2>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Cluster assignments cascade to openings; opening overrides stay
            local. Balance uses effective opening ownership.
          </p>
        </div>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Users className="size-3.5" />
          {summary.recruiters.length} recruiter
          {summary.recruiters.length === 1 ? "" : "s"} with work
        </div>
      </div>

      <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Clusters assigned"
          value={summary.assignedClusters}
          hint={`${summary.unassignedClusters} unassigned`}
        />
        <Stat
          label="Openings assigned"
          value={summary.assignedOpenings}
          hint={`${summary.unassignedOpenings} unassigned`}
        />
        <Stat
          label="Coverage"
          value={
            summary.totalOpenings === 0
              ? "—"
              : `${Math.round((summary.assignedOpenings / summary.totalOpenings) * 100)}%`
          }
          hint={`${summary.assignedOpenings} / ${summary.totalOpenings} openings`}
        />
        <Stat
          label="Avg openings / recruiter"
          value={avg === 0 ? "—" : avg.toFixed(1)}
          hint="Balance reference line"
        />
      </div>

      {summary.recruiters.length === 0 ? (
        <p className="mt-4 rounded-xl border border-dashed border-border bg-muted/20 px-3 py-6 text-center text-sm text-muted-foreground">
          Assign a recruiter to a skill cluster to start tracking workload.
        </p>
      ) : (
        <div className="mt-4 space-y-2.5">
          {summary.recruiters.map((row) => {
            const share = (row.openingCount / maxOpenings) * 100;
            const vsAvg =
              avg === 0 ? 0 : (row.openingCount - avg) / Math.max(avg, 1);
            const loadLabel =
              avg === 0
                ? "—"
                : vsAvg > 0.25
                  ? "Above average"
                  : vsAvg < -0.25
                    ? "Below average"
                    : "Balanced";

            return (
              <div
                key={row.recruiter}
                className="rounded-xl border border-border/60 bg-background/60 px-3 py-2.5"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="text-sm font-medium text-foreground">
                    {row.recruiter}
                  </p>
                  <p
                    className={cn(
                      "text-[11px] font-medium",
                      loadLabel === "Above average" && "text-ara-highlight",
                      loadLabel === "Below average" && "text-muted-foreground",
                      loadLabel === "Balanced" && "text-primary"
                    )}
                  >
                    {loadLabel}
                  </p>
                </div>

                <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                  <span>
                    <span className="font-medium tabular-nums text-foreground">
                      {row.clusterCount}
                    </span>{" "}
                    skill cluster{row.clusterCount === 1 ? "" : "s"}
                  </span>
                  <span>
                    <span className="font-medium tabular-nums text-foreground">
                      {row.openingCount}
                    </span>{" "}
                    opening{row.openingCount === 1 ? "" : "s"}
                  </span>
                  <span>
                    <span className="font-medium tabular-nums text-foreground">
                      {row.primarySkills.length}
                    </span>{" "}
                    primary skill
                    {row.primarySkills.length === 1 ? "" : "s"}
                  </span>
                </div>

                <div
                  className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted"
                  role="presentation"
                >
                  <div
                    className="h-full rounded-full bg-primary transition-[width]"
                    style={{ width: `${share}%` }}
                  />
                </div>

                {row.primarySkills.length > 0 ? (
                  <p className="mt-1.5 truncate text-[11px] text-muted-foreground">
                    {row.primarySkills.slice(0, 4).join(" · ")}
                    {row.primarySkills.length > 4
                      ? ` · +${row.primarySkills.length - 4} more`
                      : ""}
                  </p>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
