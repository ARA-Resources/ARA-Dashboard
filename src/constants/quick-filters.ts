import type { DynamicFilterField, DynamicFilterSchema } from "@/services/excel/discover-filters";

export interface QuickFilterDef {
  id: string;
  /** Short label shown on the toolbar button */
  label: string;
  /** Match against exact Excel header names */
  match: RegExp;
}

/**
 * Primary filters surfaced on the openings toolbar.
 * Remaining Excel columns stay inside the All filters sheet.
 */
export const QUICK_FILTER_DEFS: readonly QuickFilterDef[] = [
  { id: "priority", label: "Priority", match: /^priority$/i },
  {
    id: "skillCategorization",
    label: "Skill Categorization",
    match: /skill\s*categor/i,
  },
  { id: "marketMap", label: "Market Map", match: /market\s*map/i },
  { id: "jobStatus", label: "Job Status", match: /job\s*status|^status$/i },
  { id: "posted", label: "Posted", match: /^posted$/i },
] as const;

export interface ResolvedQuickFilter {
  def: QuickFilterDef;
  field: DynamicFilterField;
}

export function resolveQuickFilters(
  schema: DynamicFilterSchema | undefined
): ResolvedQuickFilter[] {
  if (!schema) return [];

  const used = new Set<string>();
  const resolved: ResolvedQuickFilter[] = [];

  for (const def of QUICK_FILTER_DEFS) {
    let field = schema.fields.find(
      (candidate) =>
        !used.has(candidate.column) && def.match.test(candidate.column)
    );

    // Prefer "Job Status" over a bare "Status" column when both exist
    if (def.id === "jobStatus") {
      const preferred = schema.fields.find(
        (candidate) =>
          !used.has(candidate.column) && /job\s*status/i.test(candidate.column)
      );
      if (preferred) field = preferred;
    }

    if (!field) continue;
    used.add(field.column);
    resolved.push({ def, field });
  }

  return resolved;
}

export function getQuickFilterColumns(
  schema: DynamicFilterSchema | undefined
): Set<string> {
  return new Set(resolveQuickFilters(schema).map((item) => item.field.column));
}
