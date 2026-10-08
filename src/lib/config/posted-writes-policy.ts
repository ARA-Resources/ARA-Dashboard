/**
 * Write gate for the "Posted" button (Lateral + Executive).
 *
 * Unlike the scheduler flags in `scheduler-policy.ts`, this one has NO
 * environment-dependent default — it is off everywhere, including
 * development, until a human explicitly sets it. Real Postgres/Drive writes
 * from the Posted button only happen once this is deliberately turned on
 * after reviewing Stage 1/2 in a throwaway container; there is no "off in
 * prod, on in dev" shortcut here the way the dataset schedulers have.
 */
const FLAG_ON = ["1", "true", "on", "yes"];
const FLAG_OFF = ["0", "false", "off", "no"];

function trimEnv(name: string): string {
  return process.env[name]?.trim() ?? "";
}

function readFlag(name: string): "on" | "off" | null {
  const raw = trimEnv(name).toLowerCase();
  if (FLAG_ON.includes(raw)) return "on";
  if (FLAG_OFF.includes(raw)) return "off";
  return null;
}

/** ARA_POSTED_WRITES_ENABLED=1/true/on/yes → real writes. Anything else (including unset) → preview only. */
export function isPostedWritesEnabled(): boolean {
  return readFlag("ARA_POSTED_WRITES_ENABLED") === "on";
}

/**
 * Human-readable reason, for inclusion in the button's result message.
 * Never prints the raw env value (only whether it was recognized) — same
 * defensive habit as `scheduler-policy.ts`'s `describeFlag`.
 */
export function postedWritesPolicyReason(): string {
  const flag = readFlag("ARA_POSTED_WRITES_ENABLED");
  if (flag === "on") return "ARA_POSTED_WRITES_ENABLED=1";
  if (flag === "off") return "ARA_POSTED_WRITES_ENABLED=0";
  const raw = trimEnv("ARA_POSTED_WRITES_ENABLED");
  if (raw) {
    return `ARA_POSTED_WRITES_ENABLED has an unrecognized value (${raw.length} chars) — treated as off; use 1 or 0`;
  }
  return "ARA_POSTED_WRITES_ENABLED unset — off by default";
}
