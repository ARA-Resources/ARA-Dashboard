"use client";

import * as React from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { AlertTriangle, Loader2, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  CANDIDATE_MASTER_COLUMN_MAP,
  type CandidateMasterSheetDbColumn,
} from "@/services/persistence/candidate-master-sheet-columns";
import type { CandidateMasterSheetPgRow } from "@/services/persistence/candidate-master-sheet-postgres";
import type { CandidateMasterRow } from "@/services/persistence/read-candidate-master";
import type { CandidateManualFieldValues } from "@/services/candidate-processing/candidate-manual-edit";
import {
  CandidateDuplicateCidError,
  CandidateStaleEditError,
  checkCandidateCidDuplicates,
  scanCandidateJobRequisition,
  useAddCandidateRow,
  useModifyCandidateRow,
} from "@/hooks/use-candidate-master-row-mutations";

export interface CandidateRowFormModalProps {
  open: boolean;
  mode: "add" | "modify";
  /** Required for mode="modify" — the currently-selected row, pre-filled. Ignored for mode="add". */
  row: CandidateMasterSheetPgRow | null;
  onOpenChange: (open: boolean) => void;
  /** Called after a successful save (any path) so the caller can clear selection / show a toast. */
  onSaved: (summary: { cid: string; name: string; mode: "inserted" | "updated" }) => void;
}

type FieldValues = Record<CandidateMasterSheetDbColumn, string>;

const GENDER_OPTIONS = ["Male", "Female"];

function emptyValues(): FieldValues {
  const out = {} as FieldValues;
  for (const mapping of CANDIDATE_MASTER_COLUMN_MAP) out[mapping.dbColumn] = "";
  return out;
}

function rowToValues(row: CandidateMasterSheetPgRow): FieldValues {
  const out = {} as FieldValues;
  for (const mapping of CANDIDATE_MASTER_COLUMN_MAP) {
    const raw = row[mapping.excelHeader];
    out[mapping.dbColumn] = raw === "-" || raw == null ? "" : String(raw);
  }
  return out;
}

/** Section layout — mirrors the 16 dashboard columns, grouped for the form. */
const SECTIONS: { title: string; fields: CandidateMasterSheetDbColumn[] }[] = [
  {
    title: "Candidate",
    fields: ["cid", "name", "email", "contact_number", "gender"],
  },
  {
    title: "Submission",
    fields: [
      "date_of_upload",
      "submitter",
      "customer",
      "status",
      "submitted_date",
      "submission_comments",
    ],
  },
  {
    title: "Requisition",
    fields: [
      "job_requisition_id",
      "primary_skills",
      "job_management_level",
      "market",
      "client_spoc",
    ],
  },
];

const LABEL_BY_COLUMN = new Map<CandidateMasterSheetDbColumn, string>(
  CANDIDATE_MASTER_COLUMN_MAP.map((m) => [m.dbColumn, m.excelHeader])
);

type Step = "edit" | "duplicate" | "review";

export function CandidateRowFormModal({
  open,
  mode,
  row,
  onOpenChange,
  onSaved,
}: CandidateRowFormModalProps) {
  const [step, setStep] = React.useState<Step>("edit");
  const [values, setValues] = React.useState<FieldValues>(emptyValues());
  const [initialValues, setInitialValues] = React.useState<FieldValues>(emptyValues());
  const [autoFilledFields, setAutoFilledFields] = React.useState<Set<CandidateMasterSheetDbColumn>>(
    new Set()
  );
  const [scanState, setScanState] = React.useState<
    "idle" | "scanning" | "found" | "not_found" | "conflict"
  >("idle");
  const [scanConflicts, setScanConflicts] = React.useState<{ field: string; lateralValue: string; executiveValue: string }[]>([]);
  const [duplicates, setDuplicates] = React.useState<CandidateMasterRow[]>([]);
  const [chosenExistingId, setChosenExistingId] = React.useState<number | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [checkingDuplicate, setCheckingDuplicate] = React.useState(false);

  const addMutation = useAddCandidateRow();
  const modifyMutation = useModifyCandidateRow();
  const saving = addMutation.isPending || modifyMutation.isPending;

  React.useEffect(() => {
    if (!open) return;
    setStep("edit");
    setAutoFilledFields(new Set());
    setScanState("idle");
    setScanConflicts([]);
    setDuplicates([]);
    setChosenExistingId(null);
    setError(null);
    addMutation.reset();
    modifyMutation.reset();
    if (mode === "modify" && row) {
      const v = rowToValues(row);
      setValues(v);
      setInitialValues(v);
    } else {
      setValues(emptyValues());
      setInitialValues(emptyValues());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mode, row?.id]);

  function setField(field: CandidateMasterSheetDbColumn, value: string) {
    setValues((prev) => ({ ...prev, [field]: value }));
    setAutoFilledFields((prev) => {
      if (!prev.has(field)) return prev;
      const next = new Set(prev);
      next.delete(field);
      return next;
    });
  }

  async function handleScan() {
    const jr = values.job_requisition_id.trim();
    if (!jr) return;
    setScanState("scanning");
    setScanConflicts([]);
    try {
      const result = await scanCandidateJobRequisition(jr);
      const filled = new Set<CandidateMasterSheetDbColumn>();
      const nextValues = { ...values };
      if (result.values.primarySkills) {
        nextValues.primary_skills = result.values.primarySkills;
        filled.add("primary_skills");
      }
      if (result.values.jobManagementLevel) {
        nextValues.job_management_level = result.values.jobManagementLevel;
        filled.add("job_management_level");
      }
      if (result.values.market) {
        nextValues.market = result.values.market;
        filled.add("market");
      }
      if (result.values.clientSpoc) {
        nextValues.client_spoc = result.values.clientSpoc;
        filled.add("client_spoc");
      }
      setValues(nextValues);
      setAutoFilledFields(filled);
      if (result.conflicts.length > 0) {
        setScanState("conflict");
        setScanConflicts(result.conflicts);
      } else if (result.sources.lateral || result.sources.executive) {
        setScanState("found");
      } else {
        setScanState("not_found");
      }
    } catch {
      setScanState("not_found");
    }
  }

  function validateBeforeReview(): string | null {
    if (!values.cid.trim()) return "Candidate ID is required.";
    if (!/^C[0-9]+$/.test(values.cid.trim())) {
      return 'Candidate ID must be "C" followed by digits, e.g. C12345.';
    }
    if (!values.name.trim()) return "Name is required.";
    return null;
  }

  async function handleContinueFromEdit() {
    const validationError = validateBeforeReview();
    if (validationError) {
      setError(validationError);
      return;
    }
    setError(null);

    if (mode === "add") {
      setCheckingDuplicate(true);
      try {
        const found = await checkCandidateCidDuplicates(values.cid.trim());
        if (found.length > 0) {
          setDuplicates(found);
          setChosenExistingId(found[0]?.id ?? null);
          setStep("duplicate");
          return;
        }
      } catch {
        // If the pre-check itself fails, fall through — the POST will still
        // catch a real duplicate via its own 409 path.
      } finally {
        setCheckingDuplicate(false);
      }
    }
    setStep("review");
  }

  async function handleSave() {
    setError(null);
    try {
      if (mode === "add") {
        const result = await addMutation.mutateAsync({ values, onDuplicate: "add" });
        onSaved({ cid: values.cid, name: values.name, mode: "inserted" });
        void result;
      } else if (row) {
        const id = Number(row.id);
        const original = Object.fromEntries(
          CANDIDATE_MASTER_COLUMN_MAP.map((m) => [m.dbColumn, initialValues[m.dbColumn]])
        ) as CandidateManualFieldValues;
        await modifyMutation.mutateAsync({ id, values, original });
        onSaved({ cid: values.cid, name: values.name, mode: "updated" });
      }
      onOpenChange(false);
    } catch (err) {
      if (err instanceof CandidateStaleEditError) {
        setError(
          `${err.message} Close and reopen this candidate to see the latest values.`
        );
      } else {
        setError(err instanceof Error ? err.message : "Failed to save.");
      }
    }
  }

  async function handleAddAsDuplicate() {
    setError(null);
    try {
      await addMutation.mutateAsync({ values, onDuplicate: "add" });
      onSaved({ cid: values.cid, name: values.name, mode: "inserted" });
      onOpenChange(false);
    } catch (err) {
      if (err instanceof CandidateDuplicateCidError) {
        setError("Still a duplicate — please retry.");
      } else {
        setError(err instanceof Error ? err.message : "Failed to save.");
      }
    }
  }

  function handleContinueTreatAsExisting() {
    if (chosenExistingId == null) return;
    setError(null);
    setStep("review");
  }

  async function handleSaveTreatAsExisting() {
    if (chosenExistingId == null) return;
    setError(null);
    try {
      await addMutation.mutateAsync({
        values,
        onDuplicate: { existingId: chosenExistingId },
      });
      onSaved({ cid: values.cid, name: values.name, mode: "updated" });
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save.");
    }
  }

  const treatingAsExisting = step === "review" && mode === "add" && chosenExistingId != null;
  const chosenExisting = duplicates.find((d) => d.id === chosenExistingId) ?? null;

  const changedFields =
    mode === "modify"
      ? CANDIDATE_MASTER_COLUMN_MAP.filter((m) => values[m.dbColumn] !== initialValues[m.dbColumn])
      : [];

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop
          className={cn(
            "fixed inset-0 z-50 bg-black/40 transition-opacity duration-150",
            "data-ending-style:opacity-0 data-starting-style:opacity-0",
            "supports-backdrop-filter:backdrop-blur-xs"
          )}
        />
        <DialogPrimitive.Popup
          className={cn(
            "fixed top-1/2 left-1/2 z-50 flex w-[min(44rem,calc(100vw-2rem))] max-h-[min(85vh,48rem)]",
            "-translate-x-1/2 -translate-y-1/2 flex-col gap-3 rounded-2xl border border-border",
            "bg-popover p-5 text-sm text-popover-foreground shadow-lg outline-none",
            "transition duration-150",
            "data-ending-style:opacity-0 data-ending-style:scale-95",
            "data-starting-style:opacity-0 data-starting-style:scale-95"
          )}
        >
          <div className="flex items-start justify-between gap-3 pr-8">
            <DialogPrimitive.Title className="text-base font-semibold text-foreground">
              {mode === "add" ? "Add Candidate" : `Modify Candidate — ${row?.["Candidate ID"] ?? ""}`}
              {step === "duplicate" ? " — Duplicate Candidate ID" : step === "review" ? " — Review" : ""}
            </DialogPrimitive.Title>
            <DialogPrimitive.Close
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="absolute top-3 right-3 rounded-lg"
                  aria-label="Close"
                />
              }
            >
              <X className="size-4" />
            </DialogPrimitive.Close>
          </div>

          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
            {step === "edit" ? (
              <>
                {SECTIONS.map((section) => (
                  <div key={section.title} className="space-y-2">
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      {section.title}
                    </p>
                    <div className="grid grid-cols-2 gap-3">
                      {section.fields.map((field) => (
                        <div
                          key={field}
                          className={cn(
                            "space-y-1",
                            (field === "submission_comments" || field === "job_requisition_id") &&
                              "col-span-2"
                          )}
                        >
                          <label className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                            {LABEL_BY_COLUMN.get(field)}
                            {autoFilledFields.has(field) ? (
                              <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
                                auto
                              </span>
                            ) : null}
                          </label>
                          {field === "gender" ? (
                            <select
                              value={values.gender}
                              onChange={(e) => setField("gender", e.target.value)}
                              className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
                            >
                              <option value="">—</option>
                              {GENDER_OPTIONS.map((g) => (
                                <option key={g} value={g}>
                                  {g}
                                </option>
                              ))}
                              {values.gender && !GENDER_OPTIONS.includes(values.gender) ? (
                                <option value={values.gender}>{values.gender}</option>
                              ) : null}
                            </select>
                          ) : field === "job_requisition_id" ? (
                            <div className="flex items-center gap-2">
                              <Input
                                value={values.job_requisition_id}
                                onChange={(e) => setField("job_requisition_id", e.target.value)}
                                placeholder="e.g. JR12345"
                              />
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="h-8 shrink-0 gap-1.5 rounded-lg"
                                disabled={!values.job_requisition_id.trim() || scanState === "scanning"}
                                onClick={() => void handleScan()}
                              >
                                {scanState === "scanning" ? (
                                  <Loader2 className="size-3.5 animate-spin" />
                                ) : (
                                  <Search className="size-3.5" />
                                )}
                                Scan
                              </Button>
                            </div>
                          ) : (
                            <Input
                              value={values[field]}
                              onChange={(e) => setField(field, e.target.value)}
                              placeholder={
                                field === "date_of_upload" || field === "submitted_date"
                                  ? "DD/MM/YYYY"
                                  : undefined
                              }
                            />
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}

                {scanState === "found" ? (
                  <p className="text-xs text-primary">
                    Found in Lateral/Executive Master — Primary Skills, Job Management Level,
                    Market and Client SPOC filled where available. Still editable.
                  </p>
                ) : scanState === "not_found" ? (
                  <p className="text-xs text-muted-foreground">
                    Job Requisition ID not found in Lateral or Executive Master — fields left
                    manual.
                  </p>
                ) : scanState === "conflict" ? (
                  <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-2 text-xs text-amber-700 dark:text-amber-400">
                    <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                    <div>
                      <p className="font-medium">
                        Lateral and Executive Master disagree on{" "}
                        {scanConflicts.map((c) => c.field).join(", ")} — left blank. Fill manually;
                        this will be flagged for review on save.
                      </p>
                    </div>
                  </div>
                ) : null}
              </>
            ) : step === "duplicate" ? (
              <div className="space-y-3">
                <p className="text-sm text-foreground">
                  Candidate ID <span className="font-semibold">{values.cid}</span> already exists on{" "}
                  {duplicates.length} row{duplicates.length === 1 ? "" : "s"} in candidate_master.
                </p>
                <div className="space-y-2 rounded-lg border border-border p-2">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    (b) Treat as existing — pick which row
                  </p>
                  {duplicates.map((d) => (
                    <label
                      key={d.id}
                      className={cn(
                        "flex cursor-pointer items-start gap-2 rounded-lg border p-2 text-xs",
                        chosenExistingId === d.id
                          ? "border-primary bg-primary/5"
                          : "border-border hover:bg-muted/40"
                      )}
                    >
                      <input
                        type="radio"
                        name="existing-row"
                        className="mt-0.5"
                        checked={chosenExistingId === d.id}
                        onChange={() => setChosenExistingId(d.id)}
                      />
                      <span className="space-y-0.5">
                        <span className="block font-medium text-foreground">
                          id={d.id} — {d.name}
                        </span>
                        <span className="block text-muted-foreground">
                          JR: {d.job_requisition_id} · Status: {d.status} · Submitted:{" "}
                          {d.submitted_date} · Uploaded: {d.date_of_upload}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">
                  (a) Add anyway creates a new row with the same CID (shown under the Duplicate
                  CID highlight). (b) applies your entered values to the chosen row above —
                  fields you left blank keep that row&apos;s current value.
                </p>
                {error ? <p className="text-xs text-destructive">{error}</p> : null}
              </div>
            ) : (
              <div className="space-y-3">
                {treatingAsExisting && chosenExisting ? (
                  <p className="text-xs text-muted-foreground">
                    Applying to existing row id={chosenExisting.id} ({chosenExisting.name}) —
                    changed fields below.
                  </p>
                ) : null}
                <dl className="space-y-2">
                  {(mode === "modify" || treatingAsExisting
                    ? CANDIDATE_MASTER_COLUMN_MAP.filter((m) =>
                        treatingAsExisting && chosenExisting
                          ? values[m.dbColumn] !==
                            ((chosenExisting as unknown as Record<string, string>)[m.dbColumn] ?? "-")
                          : values[m.dbColumn] !== initialValues[m.dbColumn]
                      )
                    : CANDIDATE_MASTER_COLUMN_MAP.filter((m) => values[m.dbColumn].trim() !== "")
                  ).map((m) => (
                    <div
                      key={m.dbColumn}
                      className="flex items-baseline justify-between gap-3 rounded-lg border border-border/60 bg-muted/20 px-2.5 py-1.5"
                    >
                      <span className="text-xs font-medium text-muted-foreground">{m.excelHeader}</span>
                      <span className="truncate text-right text-sm text-foreground">
                        {mode === "modify" || treatingAsExisting ? (
                          <>
                            <span className="text-muted-foreground line-through">
                              {treatingAsExisting && chosenExisting
                                ? (chosenExisting as unknown as Record<string, string>)[m.dbColumn] ??
                                  "-"
                                : initialValues[m.dbColumn] || "-"}
                            </span>{" "}
                            → {values[m.dbColumn] || "-"}
                          </>
                        ) : (
                          values[m.dbColumn] || "-"
                        )}
                      </span>
                    </div>
                  ))}
                </dl>
                {mode === "modify" && changedFields.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No fields changed.</p>
                ) : null}
                {error ? <p className="text-xs text-destructive">{error}</p> : null}
              </div>
            )}
          </div>

          <div className="flex items-center justify-between gap-2 border-t border-border pt-3">
            {step === "edit" ? (
              <>
                {error ? <p className="text-xs text-destructive">{error}</p> : <span />}
                <div className="flex gap-2">
                  <DialogPrimitive.Close render={<Button type="button" variant="ghost" size="sm" />}>
                    Cancel
                  </DialogPrimitive.Close>
                  <Button
                    type="button"
                    size="sm"
                    className="gap-1.5"
                    disabled={checkingDuplicate}
                    onClick={() => void handleContinueFromEdit()}
                  >
                    {checkingDuplicate ? <Loader2 className="size-3.5 animate-spin" /> : null}
                    Continue
                  </Button>
                </div>
              </>
            ) : step === "duplicate" ? (
              <div className="ml-auto flex gap-2">
                <Button type="button" variant="ghost" size="sm" onClick={() => setStep("edit")}>
                  Back
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={saving}
                  onClick={() => void handleAddAsDuplicate()}
                >
                  (a) Add anyway
                </Button>
                <Button
                  type="button"
                  size="sm"
                  disabled={chosenExistingId == null}
                  onClick={handleContinueTreatAsExisting}
                >
                  (b) Continue with existing
                </Button>
              </div>
            ) : (
              <div className="ml-auto flex gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setStep(mode === "add" && duplicates.length > 0 ? "duplicate" : "edit")}
                >
                  Back
                </Button>
                <Button
                  type="button"
                  size="sm"
                  disabled={saving || (mode === "modify" && changedFields.length === 0)}
                  onClick={() =>
                    void (treatingAsExisting ? handleSaveTreatAsExisting() : handleSave())
                  }
                >
                  {saving ? <Loader2 className="size-3.5 animate-spin" /> : null}
                  Save
                </Button>
              </div>
            )}
          </div>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
