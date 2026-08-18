"use client";

import * as React from "react";
import { Check, ChevronDown, Copy, Download, Loader2, X } from "lucide-react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  type JobDescriptionMetaField,
} from "@/utils/format-job-description";
import { downloadStructuredJobDescriptionPdf } from "@/utils/download-job-description-pdf";
import {
  buildStructuredJobDescription,
  jobReqIdFromMeta,
  structuredJobDescriptionToPdfInput,
  structuredJobDescriptionToPlainText,
  type StructuredJobDescription,
} from "@/utils/structured-job-description-view";
import { cn } from "@/lib/utils";

export interface JobDescriptionModalProps {
  open: boolean;
  /**
   * Exact Job Description cell text from the Master Sheet (source of truth).
   * Never pre-parse, normalize, or rewrite this value before passing it in.
   */
  description: string;
  meta: JobDescriptionMetaField[];
  /**
   * Stable id for the currently selected Master Sheet row.
   * Changes whenever the user opens a different Job Description.
   */
  selectionKey: string;
  onOpenChange: (open: boolean) => void;
}

type ActionToast = {
  message: string;
  variant: "success" | "error";
};

function useCopyFeedback() {
  const [copiedKey, setCopiedKey] = React.useState<string | null>(null);
  const [actionToast, setActionToast] = React.useState<ActionToast | null>(
    null
  );
  const timerRef = React.useRef<number | null>(null);
  const toastTimerRef = React.useRef<number | null>(null);

  React.useEffect(() => {
    return () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
      if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    };
  }, []);

  const showToast = React.useCallback(
    (message: string, variant: ActionToast["variant"]) => {
      setActionToast({ message, variant });
      if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
      toastTimerRef.current = window.setTimeout(
        () => setActionToast(null),
        2600
      );
    },
    []
  );

  const copy = React.useCallback(
    async (
      key: string,
      value: string,
      options?: { successToast?: string }
    ): Promise<boolean> => {
      if (!value.trim()) return false;
      try {
        await navigator.clipboard.writeText(value);
        setCopiedKey(key);
        if (timerRef.current) window.clearTimeout(timerRef.current);
        timerRef.current = window.setTimeout(() => setCopiedKey(null), 1600);

        if (options?.successToast) {
          showToast(options.successToast, "success");
        }
        return true;
      } catch {
        // Clipboard may be blocked; fail silently to avoid cluttering UI
        return false;
      }
    },
    [showToast]
  );

  return { copiedKey, copy, actionToast, showToast };
}

function SkillChips({
  skills,
  variant,
}: {
  skills: string[];
  variant: "must" | "good" | "generic";
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {skills.map((skill) => (
        <Badge
          key={`${variant}-${skill}`}
          variant="outline"
          className={cn(
            "rounded-lg px-2.5 py-1 text-xs font-medium shadow-none",
            variant === "must" &&
              "border-primary/35 bg-primary/12 text-primary",
            variant === "good" &&
              "border-secondary/40 bg-secondary/12 text-secondary",
            variant === "generic" &&
              "border-primary/25 bg-accent text-primary dark:bg-primary/10"
          )}
          title={skill}
        >
          {skill}
        </Badge>
      ))}
    </div>
  );
}

function isProjectRoleHeading(heading: string | null): boolean {
  if (!heading) return false;
  return /^(?:PROJECT ROLE|PROJECT ROLE DESCRIPTION|ROLE DESCRIPTION)$/i.test(
    heading
  );
}

function SectionHeading({ text }: { text: string }) {
  const projectRole = isProjectRoleHeading(text);
  return (
    <h3
      className={cn(
        "font-semibold tracking-[0.14em] text-primary uppercase",
        projectRole
          ? "text-sm sm:text-[0.95rem]"
          : "text-[11px] sm:text-xs"
      )}
    >
      {text}
    </h3>
  );
}

/**
 * Renders the shared structured Job Description object.
 * Does not parse — receives the same sections used by Copy Description.
 */
function JobDescriptionBody({
  structured,
}: {
  structured: StructuredJobDescription;
}) {
  const { originalRaw, sections } = structured;

  if (!originalRaw.trim()) {
    return (
      <p className="text-sm text-muted-foreground">
        No job description available.
      </p>
    );
  }

  if (sections.length === 0) {
    return (
      <p className="whitespace-pre-wrap wrap-break-word text-sm leading-relaxed text-card-foreground">
        {originalRaw}
      </p>
    );
  }

  return (
    <div className="space-y-5 text-sm leading-relaxed text-card-foreground">
      {sections.map((section, sectionIndex) => {
        const projectRole = isProjectRoleHeading(section.heading);
        return (
          <section
            key={`jd-section-${sectionIndex}-${section.heading ?? "body"}`}
            className="space-y-2.5"
          >
            {section.heading ? <SectionHeading text={section.heading} /> : null}

            <div
              className={cn(
                "space-y-2",
                projectRole && "space-y-1.5"
              )}
            >
              {section.blocks.map((block, index) => {
                if (block.type === "skillChips") {
                  return (
                    <SkillChips
                      key={`skills-${sectionIndex}-${index}`}
                      skills={block.skills}
                      variant={block.variant}
                    />
                  );
                }
                if (block.type === "bullet") {
                  return (
                    <div
                      key={`b-${sectionIndex}-${index}`}
                      className="flex gap-2.5 pl-0.5"
                    >
                      <span className="mt-2 size-1.5 shrink-0 rounded-full bg-secondary" />
                      <p className="min-w-0 flex-1 whitespace-pre-wrap wrap-break-word text-card-foreground">
                        {block.text}
                      </p>
                    </div>
                  );
                }
                if (block.type === "number") {
                  return (
                    <div
                      key={`n-${sectionIndex}-${index}`}
                      className="flex gap-2 pl-0.5"
                    >
                      <span className="w-5 shrink-0 tabular-nums text-secondary">
                        {block.index}.
                      </span>
                      <p className="min-w-0 flex-1 whitespace-pre-wrap wrap-break-word text-card-foreground">
                        {block.text}
                      </p>
                    </div>
                  );
                }
                if (block.type === "paragraph") {
                  return (
                    <p
                      key={`p-${sectionIndex}-${index}`}
                      className={cn(
                        "whitespace-pre-wrap wrap-break-word text-card-foreground",
                        projectRole &&
                          "text-base font-medium tracking-tight text-foreground sm:text-[1.05rem]"
                      )}
                    >
                      {block.text}
                    </p>
                  );
                }
                return null;
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function CopyActionButton({
  label,
  copied,
  disabled,
  onClick,
}: {
  label: string;
  copied: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={disabled}
      onClick={onClick}
      className="h-8 gap-1.5 rounded-lg px-2.5 text-xs"
    >
      {copied ? (
        <Check className="size-3.5 text-primary" />
      ) : (
        <Copy className="size-3.5" />
      )}
      {copied ? "Copied!" : label}
    </Button>
  );
}

function DownloadActionButton({
  generating,
  disabled,
  onClick,
}: {
  generating: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={disabled || generating}
      onClick={onClick}
      aria-busy={generating || undefined}
      className="h-8 gap-1.5 rounded-lg px-2.5 text-xs"
    >
      {generating ? (
        <Loader2 className="size-3.5 animate-spin text-primary" />
      ) : (
        <Download className="size-3.5" />
      )}
      {generating ? "Generating PDF..." : "Download Job Description"}
    </Button>
  );
}

/**
 * Source-of-truth accordion — exact Master Sheet Job Description.
 * Must never render parsed / formatted / normalized content.
 */
function OriginalJobDescriptionAccordion({
  open,
  onOpenChange,
  rawDescription,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Exact Master Sheet cell text — unmodified. */
  rawDescription: string;
}) {
  return (
    <Collapsible open={open} onOpenChange={onOpenChange}>
      <div className="rounded-xl border border-border bg-muted/30">
        <CollapsibleTrigger className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left hover:bg-muted/40">
          <span className="text-xs font-semibold tracking-wide text-primary uppercase">
            Original Job Description
          </span>
          <ChevronDown
            className={cn(
              "size-4 shrink-0 text-secondary transition-transform",
              open && "rotate-180"
            )}
          />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="border-t border-border px-3 py-3">
            {/*
              Source of truth: render the Master Sheet value exactly.
              Do not pass this through parse/format helpers.
            */}
            <pre className="m-0 whitespace-pre-wrap wrap-break-word font-sans text-sm leading-relaxed text-card-foreground">
              {rawDescription}
            </pre>
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

/**
 * Reusable Job Description modal (single instance per table).
 * Receives selected-row data dynamically — do not mount per row.
 * Theme tokens follow the existing Light/Dark toggle.
 *
 * Architecture:
 *   Original Excel JD → Parser → StructuredJobDescription (once per selectionKey)
 *     → Modal UI
 *     → Copy Description (serialize same object; no second parse)
 *     → Download PDF (same live object; no second parse / no raw Excel)
 *
 * ORIGINAL JOB DESCRIPTION accordion = exact Master Sheet source of truth.
 */
export function JobDescriptionModal({
  open,
  description,
  meta,
  selectionKey,
  onOpenChange,
}: JobDescriptionModalProps) {
  const [originalOpen, setOriginalOpen] = React.useState(false);
  const [pdfGenerating, setPdfGenerating] = React.useState(false);
  const { copiedKey, copy, actionToast, showToast } = useCopyFeedback();

  // Exact Master Sheet cell — never parse/normalize for original accordion
  const originalRawDescription = description;

  // ONE shared structured object for the CURRENT selection only
  const structuredJobDescription = React.useMemo(
    () =>
      buildStructuredJobDescription({
        selectionKey,
        originalRaw: originalRawDescription,
        meta,
      }),
    [selectionKey, originalRawDescription, meta]
  );

  // Live ref so Download always reads the currently displayed object (never a prior row)
  const structuredRef = React.useRef(structuredJobDescription);
  structuredRef.current = structuredJobDescription;

  const jobReqId = jobReqIdFromMeta(structuredJobDescription.meta);

  const structuredCopyText = React.useMemo(
    () => structuredJobDescriptionToPlainText(structuredJobDescription),
    [structuredJobDescription]
  );

  React.useEffect(() => {
    // Reset accordion / avoid carrying UI state across row selections
    setOriginalOpen(false);
    setPdfGenerating(false);
  }, [open, selectionKey]);

  const downloadCurrentSelection = React.useCallback(async () => {
    if (pdfGenerating) return;

    const current = structuredRef.current;
    // Guard: only download when this modal selection is active
    if (!current.selectionKey || current.selectionKey !== selectionKey) {
      return;
    }

    setPdfGenerating(true);
    // Yield so the button can paint "Generating PDF..." before sync PDF work
    await new Promise<void>((resolve) => {
      window.requestAnimationFrame(() => resolve());
    });

    try {
      // Re-read live object after yield in case selection changed mid-click
      const latest = structuredRef.current;
      if (!latest.selectionKey || latest.selectionKey !== selectionKey) {
        return;
      }
      downloadStructuredJobDescriptionPdf(
        structuredJobDescriptionToPdfInput(latest)
      );
      showToast("Job description downloaded successfully.", "success");
    } catch (error) {
      console.error("[JobDescriptionModal] PDF generation failed", error);
      showToast(
        "Unable to generate the job description PDF. Please try again.",
        "error"
      );
    } finally {
      setPdfGenerating(false);
    }
  }, [pdfGenerating, selectionKey, showToast]);

  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(nextOpen) => onOpenChange(nextOpen)}
      modal
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop
          className={cn(
            "fixed inset-0 z-100",
            "bg-foreground/25 dark:bg-black/55",
            "supports-backdrop-filter:backdrop-blur-[1px]",
            "transition-opacity duration-200 ease-out",
            "data-starting-style:opacity-0",
            "data-ending-style:opacity-0"
          )}
        />

        <DialogPrimitive.Popup
          className={cn(
            "fixed top-1/2 left-1/2 z-110",
            "-translate-x-1/2 -translate-y-1/2",
            "flex w-[min(90vw,48rem)] max-h-[90vh]",
            "flex-col overflow-hidden",
            "rounded-2xl border border-border bg-card text-card-foreground",
            "shadow-lg outline-none",
            "origin-center",
            "transition-[opacity,transform] duration-200 ease-out",
            "data-starting-style:opacity-0 data-starting-style:scale-95",
            "data-ending-style:opacity-0 data-ending-style:scale-95"
          )}
        >
          {/* Sticky header — stays visible while body scrolls */}
          <header className="sticky top-0 z-10 shrink-0 border-b border-border bg-card/95 px-5 py-3.5 backdrop-blur-sm supports-backdrop-filter:bg-card/90">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1 space-y-2.5">
                <DialogPrimitive.Title className="text-sm font-semibold tracking-[0.08em] text-primary uppercase">
                  Job Description
                </DialogPrimitive.Title>

                {structuredJobDescription.meta.length > 0 ? (
                  <dl className="grid gap-x-4 gap-y-1.5 sm:grid-cols-2">
                    {structuredJobDescription.meta.map((field) => (
                      <div key={field.label} className="min-w-0">
                        <dt className="text-[10px] font-medium uppercase tracking-wide text-secondary">
                          {field.label}
                        </dt>
                        <dd className="truncate text-sm font-medium text-card-foreground">
                          {field.value}
                        </dd>
                      </div>
                    ))}
                  </dl>
                ) : null}

                <div className="flex flex-wrap items-center gap-2">
                  <CopyActionButton
                    label="Copy Description"
                    copied={copiedKey === "description"}
                    disabled={!structuredCopyText.trim()}
                    onClick={() =>
                      void copy(
                        "description",
                        structuredJobDescriptionToPlainText(
                          structuredRef.current
                        ),
                        {
                          successToast: "Job description copied successfully.",
                        }
                      )
                    }
                  />
                  {jobReqId ? (
                    <CopyActionButton
                      label="Copy Job Req ID"
                      copied={copiedKey === "jobReqId"}
                      onClick={() =>
                        void copy(
                          "jobReqId",
                          jobReqIdFromMeta(structuredRef.current.meta)
                        )
                      }
                    />
                  ) : null}
                  <DownloadActionButton
                    generating={pdfGenerating}
                    disabled={
                      pdfGenerating ||
                      (!structuredJobDescription.sections.length &&
                        !structuredJobDescription.meta.length)
                    }
                    onClick={() => void downloadCurrentSelection()}
                  />
                </div>
              </div>

              <DialogPrimitive.Close
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-8 shrink-0 rounded-lg text-muted-foreground hover:bg-secondary/10 hover:text-secondary"
                    aria-label="Close Job Description"
                  />
                }
              >
                <X className="size-4" />
              </DialogPrimitive.Close>
            </div>
          </header>

          <DialogPrimitive.Description className="sr-only">
            Complete job description from the Master Sheet. Press Escape or
            click outside to close.
          </DialogPrimitive.Description>

          {/* Scrollable content only — remount when selection changes */}
          <div
            key={selectionKey || "empty-selection"}
            className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain bg-card px-5 py-4"
          >
            {/* Same StructuredJobDescription object as Copy / Download */}
            <JobDescriptionBody structured={structuredJobDescription} />

            {/* Source-of-truth raw Master Sheet text — always at bottom */}
            <OriginalJobDescriptionAccordion
              open={originalOpen}
              onOpenChange={setOriginalOpen}
              rawDescription={structuredJobDescription.originalRaw}
            />
          </div>

          {/* Compact footer */}
          <footer className="shrink-0 border-t border-border bg-card px-5 py-3">
            <div className="flex items-center justify-between gap-3">
              <p className="min-w-0 truncate text-xs text-muted-foreground">
                {jobReqId ? (
                  <>
                    <span className="font-medium text-secondary">
                      Job Requisition ID
                    </span>
                    <span className="mx-1.5 text-border">·</span>
                    <span className="font-medium text-card-foreground">
                      {jobReqId}
                    </span>
                  </>
                ) : (
                  <span>Job Description</span>
                )}
              </p>

              <DialogPrimitive.Close
                render={
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-8 shrink-0 rounded-lg px-3 text-xs"
                  />
                }
              >
                Close
              </DialogPrimitive.Close>
            </div>
          </footer>
        </DialogPrimitive.Popup>

        {actionToast ? (
          <div
            role="status"
            aria-live="polite"
            className={cn(
              "fixed bottom-6 left-1/2 z-120 -translate-x-1/2",
              "rounded-xl border bg-card px-4 py-2.5",
              "text-sm font-medium text-card-foreground shadow-lg",
              "flex items-center gap-2",
              actionToast.variant === "success" && "border-primary/25",
              actionToast.variant === "error" && "border-destructive/35"
            )}
          >
            {actionToast.variant === "success" ? (
              <Check className="size-4 shrink-0 text-primary" />
            ) : (
              <X className="size-4 shrink-0 text-destructive" />
            )}
            <span>{actionToast.message}</span>
          </div>
        ) : null}
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
