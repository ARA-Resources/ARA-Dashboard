/** Verify the pure Posted-button write guards (no network, no I/O). */
import { evaluatePostedWriteGuards } from "../src/services/dataset-posted/posted-write-guards";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

// Zero JR IDs: always refuses, force cannot override.
{
  const r1 = evaluatePostedWriteGuards({ uniqueJrIdCount: 0, newYesCount: 0, currentYesCount: 50, force: false });
  assert(r1.tripped && r1.reason === "zero_jr_ids", "zero JR IDs must always refuse");
  const r2 = evaluatePostedWriteGuards({ uniqueJrIdCount: 0, newYesCount: 0, currentYesCount: 50, force: true });
  assert(r2.tripped && r2.reason === "zero_jr_ids", "zero JR IDs must refuse even with force=true — no override exists");
}

// Sharp drop: >35% below current Yes count refuses unless forced.
{
  // current 100, new 64 -> 36% drop -> refuse
  const r1 = evaluatePostedWriteGuards({ uniqueJrIdCount: 64, newYesCount: 64, currentYesCount: 100, force: false });
  assert(r1.tripped && r1.reason === "sharp_drop", "a >35% drop must refuse");

  // current 100, new 65 -> exactly 35% drop -> must NOT refuse (threshold is "more than 35%")
  const r2 = evaluatePostedWriteGuards({ uniqueJrIdCount: 65, newYesCount: 65, currentYesCount: 100, force: false });
  assert(!r2.tripped, "exactly 35% drop must not refuse — only MORE than 35%");

  // force=true bypasses the sharp-drop guard
  const r3 = evaluatePostedWriteGuards({ uniqueJrIdCount: 64, newYesCount: 64, currentYesCount: 100, force: true });
  assert(!r3.tripped, "force=true must bypass the sharp-drop guard");
}

// currentYesCount === 0: guard never trips on the drop check (nothing to drop from).
{
  const r = evaluatePostedWriteGuards({ uniqueJrIdCount: 1, newYesCount: 0, currentYesCount: 0, force: false });
  assert(!r.tripped, "a zero current-Yes baseline must never trip the sharp-drop guard");
}

console.log("verify-posted-write-guards: OK");
