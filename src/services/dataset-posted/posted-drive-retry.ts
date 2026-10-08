/**
 * One retry, with a short delay, for the Posted button's own Drive download
 * and final upload calls ONLY — never touches any shared helper Run All
 * uses. Retries only network errors, HTTP 5xx, and 429; anything else
 * (including a modifiedTime mismatch, which is checked separately and must
 * hard-abort, never retry) passes straight through.
 */
const RETRYABLE_HTTP_STATUS = new Set([429, 500, 502, 503, 504]);
const RETRYABLE_NETWORK_CODES = new Set(["ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "EPIPE"]);

function extractHttpStatus(error: unknown): number | null {
  const e = error as { code?: unknown; status?: unknown; response?: { status?: unknown } } | null;
  const candidates = [e?.status, e?.response?.status, e?.code];
  for (const c of candidates) {
    if (typeof c === "number") return c;
    if (typeof c === "string" && /^\d{3}$/.test(c)) return Number(c);
  }
  return null;
}

function extractNetworkCode(error: unknown): string | null {
  const e = error as { code?: unknown } | null;
  return typeof e?.code === "string" ? e.code : null;
}

export function isRetryablePostedDriveError(error: unknown): boolean {
  if (!error) return false;
  const status = extractHttpStatus(error);
  if (status !== null && RETRYABLE_HTTP_STATUS.has(status)) return true;
  const netCode = extractNetworkCode(error);
  if (netCode && RETRYABLE_NETWORK_CODES.has(netCode)) return true;
  return false;
}

export async function withPostedDriveRetry<T>(
  fn: () => Promise<T>,
  label: string,
  delayMs = 1500
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (!isRetryablePostedDriveError(error)) throw error;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    try {
      return await fn();
    } catch (secondError) {
      const message = secondError instanceof Error ? secondError.message : String(secondError);
      throw new Error(`${label} failed after one retry: ${message}`);
    }
  }
}
