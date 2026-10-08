/**
 * Pure guard evaluation for the Posted button's real-write path. Evaluated
 * only when `ARA_POSTED_WRITES_ENABLED` is on and only before any write —
 * preview mode never writes, so these never block a preview.
 */
export type PostedWriteGuardResult =
  | { tripped: false }
  | { tripped: true; reason: "zero_jr_ids" }
  | { tripped: true; reason: "sharp_drop"; currentYesCount: number; newYesCount: number };

export interface PostedWriteGuardInput {
  uniqueJrIdCount: number;
  newYesCount: number;
  currentYesCount: number;
  /** Bypasses the sharp-drop guard only — never the zero-JR-IDs guard. */
  force: boolean;
}

const SHARP_DROP_FRACTION = 0.35;

export function evaluatePostedWriteGuards(input: PostedWriteGuardInput): PostedWriteGuardResult {
  if (input.uniqueJrIdCount === 0) {
    return { tripped: true, reason: "zero_jr_ids" };
  }
  if (!input.force && input.currentYesCount > 0) {
    const threshold = input.currentYesCount * (1 - SHARP_DROP_FRACTION);
    if (input.newYesCount < threshold) {
      return {
        tripped: true,
        reason: "sharp_drop",
        currentYesCount: input.currentYesCount,
        newYesCount: input.newYesCount,
      };
    }
  }
  return { tripped: false };
}
