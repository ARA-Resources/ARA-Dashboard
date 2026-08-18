/**
 * Vercel Cron endpoint for the Lateral Dataset Sync job.
 *
 * Called automatically by Vercel Cron on the configured schedule (see vercel.json).
 * May also be called manually by an operator for testing (same auth applies).
 *
 * Security:
 *   - Vercel passes `Authorization: Bearer <CRON_SECRET>` on every cron call.
 *   - Requests without a valid secret are rejected with 401.
 *   - Timing-safe comparison via `timingSafeEqual` to prevent timing attacks.
 *
 * Execution:
 *   - Acquires a PostgreSQL pg_advisory_lock (postgres mode) before running.
 *   - If another instance holds the lock, returns 409 without starting the job.
 *   - Uses invokeLateralJob (same function as manual Run All) — shared code path.
 *
 * Vercel runtime constraints:
 *   - Route is Node.js runtime.
 *   - maxDuration is capped at 300s (Vercel Hobby). Full Windows Run All is not expected here.
 *   - Do NOT import win32com / pywin32 / child_process in this file or its imports.
 *
 * Environment:
 *   CRON_SECRET — required; must match Authorization header.
 *   ARA_PERSISTENCE — must be "postgres" for distributed locking to engage.
 */

import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { invokeLateralJob } from "@/services/lateral-processing/lateral-scheduler";

export const runtime = "nodejs";

// Vercel Hobby allows maxDuration 1–300. Pro can go higher.
export const maxDuration = 300;

function getCronSecret(): string | undefined {
  return process.env.CRON_SECRET;
}

function isAuthorized(request: NextRequest): boolean {
  const secret = getCronSecret();
  if (!secret) {
    console.error("[cron/lateral] CRON_SECRET is not configured — endpoint disabled");
    return false;
  }

  const authHeader = request.headers.get("authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : authHeader;

  if (!token) return false;

  try {
    const secretBuf = Buffer.from(secret, "utf8");
    const tokenBuf = Buffer.from(token, "utf8");
    if (secretBuf.length !== tokenBuf.length) return false;
    return timingSafeEqual(secretBuf, tokenBuf);
  } catch {
    return false;
  }
}

export async function POST(request: NextRequest) {
  const startedAt = new Date().toISOString();

  if (!isAuthorized(request)) {
    console.warn("[cron/lateral] Unauthorized cron request rejected", {
      at: startedAt,
      ip: request.headers.get("x-forwarded-for") ?? "unknown",
    });
    return NextResponse.json(
      { ok: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  console.info("[cron/lateral] Authorized cron trigger received", { at: startedAt });

  let result;
  try {
    result = await invokeLateralJob("scheduler");
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const isBusy =
      message.includes("already running") ||
      message.includes("another instance");

    if (isBusy) {
      console.info("[cron/lateral] Job already running — cron call safely rejected", {
        message,
      });
      return NextResponse.json(
        { ok: false, busy: true, message },
        { status: 409 }
      );
    }

    console.error("[cron/lateral] Lateral job error", { message });
    return NextResponse.json(
      { ok: false, error: message },
      { status: 500 }
    );
  }

  const { outcome } = result;
  const success = outcome.status === "success";

  console.info("[cron/lateral] Lateral job completed", {
    status: outcome.status,
    durationMs: outcome.durationMs,
    message: outcome.message,
  });

  return NextResponse.json(
    {
      ok: success,
      status: outcome.status,
      durationMs: outcome.durationMs,
      message: outcome.message,
      ranAt: outcome.ranAt,
    },
    { status: success ? 200 : 500 }
  );
}
