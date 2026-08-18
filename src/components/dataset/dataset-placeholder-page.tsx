"use client";

import Link from "next/link";
import { Database } from "lucide-react";
import { FadeIn } from "@/animations/fade-in";
import { PageHeader } from "@/components/layouts/page-header";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { ROUTES } from "@/constants/routes";
import { cn } from "@/lib/utils";

export function DatasetPlaceholderPage({
  datasetName,
}: {
  datasetName: "Executive" | "Consulting";
}) {
  return (
    <div className="space-y-4">
      <PageHeader
        title={`${datasetName} Dataset`}
        description="Configuration placeholder — processing automation is not enabled yet."
      />
      <FadeIn>
        <div className="rounded-2xl border border-border/70 bg-card/60 p-6 sm:p-8">
          <div className="flex flex-wrap items-start gap-3">
            <div className="flex size-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <Database className="size-5" />
            </div>
            <div className="min-w-0 flex-1 space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-lg font-semibold text-foreground">
                  {datasetName}
                </h2>
                <Badge
                  variant="secondary"
                  className="rounded-md bg-ara-highlight/15 text-ara-highlight"
                >
                  Coming soon
                </Badge>
              </div>
              <p className="max-w-2xl text-sm text-muted-foreground">
                {datasetName} will use the same shared Gmail and Google Drive
                connections as Lateral. Dataset-specific processing for{" "}
                {datasetName} is not implemented yet — this page is a
                configuration placeholder only.
              </p>
              <div className="flex flex-wrap gap-2 pt-2">
                <Link
                  href={ROUTES.datasetLateral}
                  className={cn(buttonVariants(), "rounded-xl")}
                >
                  Open Lateral Dataset
                </Link>
                <Link
                  href={ROUTES.datasetConnectionsGmail}
                  className={cn(
                    buttonVariants({ variant: "outline" }),
                    "rounded-xl"
                  )}
                >
                  Common Connections
                </Link>
              </div>
            </div>
          </div>
        </div>
      </FadeIn>
    </div>
  );
}
