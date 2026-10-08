"use client";

import * as React from "react";
import { AlertCircle, AlertTriangle, CheckCircle2, Loader2, Tags } from "lucide-react";
import { FadeIn } from "@/animations/fade-in";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface PostedRunResult {
  ok?: boolean;
  busy?: boolean;
  refused?: boolean;
  driveWarning?: boolean;
  previewOnly?: boolean;
  message: string;
  counts?: {
    yes: number;
    notPosted: number;
    titleLinesRemoved: number;
    blankRowsRemoved: number;
    needsLook: number;
  };
}

interface PostedSnapshot {
  active: boolean;
  runId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  result: PostedRunResult | null;
}

/**
 * Shared state for the Posted button — button and message area render in
 * two different places on the page (same split as Run All: the bare button
 * lives in the header's action row, the message/confirm area renders below
 * it), so this hook is called once per page and its result passed to both.
 * Polls GET every 1.5s while a run is active; the click itself never holds
 * a long HTTP request (see the route's own doc comment).
 */
export function usePostedButton(apiBase: string) {
  const [snapshot, setSnapshot] = React.useState<PostedSnapshot | null>(null);
  const [busyMessage, setBusyMessage] = React.useState<string | null>(null);
  const [confirmingForce, setConfirmingForce] = React.useState(false);
  const pollRef = React.useRef<number | null>(null);

  const stopPolling = React.useCallback(() => {
    if (pollRef.current !== null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const fetchStatus = React.useCallback(async () => {
    try {
      const res = await fetch(apiBase, { cache: "no-store" });
      const payload = (await res.json().catch(() => null)) as PostedSnapshot | null;
      if (payload) setSnapshot(payload);
      if (payload && !payload.active) stopPolling();
    } catch {
      /* transient poll failure — try again on the next tick */
    }
  }, [apiBase, stopPolling]);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(apiBase, { cache: "no-store" });
        const payload = (await res.json().catch(() => null)) as PostedSnapshot | null;
        if (cancelled) return;
        if (payload) setSnapshot(payload);
      } catch {
        /* initial load failure — the user can still click the button */
      }
    })();
    return () => {
      cancelled = true;
      stopPolling();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function startPolling() {
    stopPolling();
    pollRef.current = window.setInterval(() => void fetchStatus(), 1500);
  }

  async function handleClick(force = false) {
    setBusyMessage(null);
    setConfirmingForce(false);
    try {
      const res = await fetch(apiBase, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force }),
      });
      if (res.status === 409) {
        const payload = (await res.json().catch(() => null)) as { message?: string } | null;
        setBusyMessage(payload?.message ?? "A run is in progress.");
        return;
      }
      await fetchStatus();
      startPolling();
    } catch (err) {
      setBusyMessage(err instanceof Error ? err.message : "Could not start Posted.");
    }
  }

  const running = snapshot?.active === true;
  const result = snapshot?.result ?? null;
  const sharpDropMatch = result?.refused
    ? result.message.match(/new Yes count \((\d+)\).*current dashboard Yes count \((\d+)\)/)
    : null;

  return {
    running,
    result,
    busyMessage,
    confirmingForce,
    isSharpDropRefusal: !!sharpDropMatch,
    sharpDropMatch,
    setConfirmingForce,
    handleClick,
  };
}

type PostedButtonState = ReturnType<typeof usePostedButton>;

/** The bare button + its "Run anyway" trigger — goes in the page header's action row, next to Run All. */
export function PostedButtonTrigger({ state }: { state: PostedButtonState }) {
  return (
    <>
      <Button
        type="button"
        variant="outline"
        className="rounded-xl gap-2"
        onClick={() => void state.handleClick(false)}
        disabled={state.running}
      >
        {state.running ? <Loader2 className="size-4 animate-spin" /> : <Tags className="size-4" />}
        {state.running ? "Running…" : "Posted"}
      </Button>
      {state.isSharpDropRefusal ? (
        <Button
          type="button"
          variant="outline"
          className="rounded-xl border-amber-500/40 text-amber-700 dark:text-amber-400"
          onClick={() => state.setConfirmingForce(true)}
        >
          Run anyway
        </Button>
      ) : null}
    </>
  );
}

/** The confirm bar + busy/result message — goes below the page header, same spot Run All's own message renders. */
export function PostedButtonMessages({ state }: { state: PostedButtonState }) {
  const { result, busyMessage, confirmingForce, isSharpDropRefusal, sharpDropMatch, running } = state;

  return (
    <>
      {confirmingForce ? (
        <FadeIn>
          <div className="flex items-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-sm">
            <p className="flex-1 text-foreground">Yes would drop more than 35% — run anyway?</p>
            <Button type="button" size="sm" variant="outline" onClick={() => state.setConfirmingForce(false)}>
              Cancel
            </Button>
            <Button type="button" size="sm" onClick={() => void state.handleClick(true)}>
              Confirm
            </Button>
          </div>
        </FadeIn>
      ) : null}

      {busyMessage ? (
        <FadeIn>
          <div className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-foreground">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" />
            <p>{busyMessage}</p>
          </div>
        </FadeIn>
      ) : null}

      {!running && result ? (
        <FadeIn>
          <div
            className={cn(
              "flex items-start gap-2 rounded-xl border p-3 text-sm",
              result.driveWarning
                ? "border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-300"
                : result.refused
                  ? "border-amber-500/30 bg-amber-500/5 text-foreground"
                  : result.ok
                    ? "border-primary/30 bg-primary/5 text-foreground"
                    : "border-destructive/30 bg-destructive/5 text-destructive"
            )}
          >
            {result.driveWarning || result.refused ? (
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            ) : result.ok ? (
              <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
            ) : (
              <AlertCircle className="mt-0.5 size-4 shrink-0" />
            )}
            <p>
              {isSharpDropRefusal && sharpDropMatch
                ? `Yes would drop from ${sharpDropMatch[2]} to ${sharpDropMatch[1]}. ${result.message}`
                : result.message}
            </p>
          </div>
        </FadeIn>
      ) : null}
    </>
  );
}

export function LastPostedLine({ apiBase }: { apiBase: string }) {
  const [summary, setSummary] = React.useState<{ ranAt: string; yes: number; notPosted: number } | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(apiBase, { cache: "no-store" });
        const payload = (await res.json().catch(() => null)) as { lastPostedSummary?: typeof summary } | null;
        if (!cancelled && payload?.lastPostedSummary) setSummary(payload.lastPostedSummary);
      } catch {
        /* no summary yet is a normal state, not an error */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [apiBase]);

  if (!summary) return null;

  return (
    <p className="text-xs text-muted-foreground">
      Last Posted: {formatIstDateTimeInline(summary.ranAt)}, {summary.yes} Yes, {summary.notPosted} not posted
    </p>
  );
}

/** Explicit Asia/Kolkata formatting — never local Date getters. */
function formatIstDateTimeInline(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "unknown time";
  const datePart = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", day: "2-digit", month: "2-digit", year: "numeric" }).format(d);
  const timePart = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
  return `${datePart} ${timePart} IST`;
}
