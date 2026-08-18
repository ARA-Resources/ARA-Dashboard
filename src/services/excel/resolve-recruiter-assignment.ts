/**
 * Resolve the effective HR recruiter for an opening.
 * Opening override wins; otherwise inherit the cluster assignment.
 */
export function resolveEffectiveRecruiter(
  openingId: string,
  clusterId: string,
  clusterAssignments: Record<string, string>,
  openingOverrides: Record<string, string>
): string | null {
  if (Object.prototype.hasOwnProperty.call(openingOverrides, openingId)) {
    const override = openingOverrides[openingId]?.trim();
    return override ? override : null;
  }
  const inherited = clusterAssignments[clusterId]?.trim();
  return inherited ? inherited : null;
}

export function hasOpeningRecruiterOverride(
  openingId: string,
  openingOverrides: Record<string, string>
): boolean {
  return Object.prototype.hasOwnProperty.call(openingOverrides, openingId);
}
