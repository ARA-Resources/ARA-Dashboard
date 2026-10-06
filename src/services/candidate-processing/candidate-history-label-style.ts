import type { CandidateHistoryKindLabel } from "@/services/persistence/read-candidate-highlights";

/**
 * Violet is the Accenture color everywhere else in this feature (the cell
 * highlight, the hover). An Oorwin/manual/legacy history entry is not an
 * Accenture entry and must not be painted with its color.
 *
 * Deliberately its own zero-dependency module (not exported from
 * candidate-history-modal.tsx itself): the only import here is a type
 * (erased at compile time), so this stays safely importable from both the
 * client modal component and plain node verify scripts, without pulling in
 * either React/UI code or read-candidate-highlights.ts's DB client code.
 */
export function kindLabelClassName(kindLabel: CandidateHistoryKindLabel): string {
  return kindLabel === "Accenture Final Report upload"
    ? "text-violet-600 dark:text-violet-400"
    : "text-muted-foreground";
}
