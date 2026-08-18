import { createHash, timingSafeEqual } from "node:crypto";

/** Node-only. Compare dashboard password without leaking length via early return. */
export function passwordMatches(input: string, expected: string): boolean {
  if (!expected) return false;
  const a = createHash("sha256").update(input, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}
