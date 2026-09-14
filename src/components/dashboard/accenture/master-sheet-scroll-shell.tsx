"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Shared scroll mechanics for the Lateral and Executive Master Sheet tables:
 * a single bounded-height scroll container (so `position: sticky` on the
 * table header has a real scrolling ancestor to stick against — see note
 * below), plus a thin mirrored horizontal scrollbar above the header that
 * stays in sync with the real one.
 *
 * Why a single container matters: shadcn's <Table> wraps itself in its own
 * `overflow-x-auto` div. Per the CSS overflow spec, any element with a
 * non-visible overflow on one axis has the other axis force-computed to
 * `auto` too — so that wrapper is *also* a vertical scroll container, and
 * `position: sticky` always anchors to the nearest one. Nesting our own
 * scroll div around shadcn's would make the header stick relative to the
 * wrong (inner, non-scrolling) box and never visibly stick. The fix is to
 * not use <Table>'s wrapper at all here — render a bare <table> inside the
 * one scroll div these components already control.
 */
export function useMasterSheetScrollShell() {
  const bodyScrollRef = React.useRef<HTMLDivElement>(null);
  const topScrollRef = React.useRef<HTMLDivElement>(null);
  const [mirrorWidth, setMirrorWidth] = React.useState(0);
  const syncingRef = React.useRef(false);

  // A callback ref (not a plain useRef) because the <table> is behind
  // isLoading/errorMessage branches — it often doesn't exist yet on first
  // mount. A `useEffect(..., [])` keyed off a useRef would capture `null`
  // that one time and never re-run once the table actually appears; this
  // re-attaches the observer whenever the node itself changes.
  const [tableEl, setTableEl] = React.useState<HTMLTableElement | null>(null);
  const tableRef = React.useCallback((node: HTMLTableElement | null) => {
    setTableEl(node);
  }, []);

  React.useEffect(() => {
    if (!tableEl) return;
    const update = () => setMirrorWidth(tableEl.scrollWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(tableEl);
    return () => observer.disconnect();
  }, [tableEl]);

  const onBodyScroll = React.useCallback(() => {
    if (syncingRef.current) return;
    const body = bodyScrollRef.current;
    const top = topScrollRef.current;
    if (!body || !top) return;
    syncingRef.current = true;
    top.scrollLeft = body.scrollLeft;
    syncingRef.current = false;
  }, []);

  const onTopScroll = React.useCallback(() => {
    if (syncingRef.current) return;
    const body = bodyScrollRef.current;
    const top = topScrollRef.current;
    if (!body || !top) return;
    syncingRef.current = true;
    body.scrollLeft = top.scrollLeft;
    syncingRef.current = false;
  }, []);

  return {
    bodyScrollRef,
    tableRef,
    topScrollRef,
    mirrorWidth,
    onBodyScroll,
    onTopScroll,
  };
}

/**
 * Thin, always-visible horizontal scrollbar strip that mirrors the real
 * table's horizontal scroll position. Sits directly above the (sticky)
 * table header so it reads as the header's own scroll affordance rather
 * than a separate control row.
 */
export function MasterSheetTopScrollbar({
  scrollRef,
  onScroll,
  width,
  className,
}: {
  scrollRef: React.RefObject<HTMLDivElement | null>;
  onScroll: () => void;
  width: number;
  className?: string;
}) {
  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      aria-hidden="true"
      className={cn(
        "h-3 overflow-x-auto overflow-y-hidden border-b border-border bg-muted/30",
        className
      )}
      style={{ scrollbarWidth: "thin" }}
    >
      <div style={{ width: Math.max(width, 1), height: 1 }} />
    </div>
  );
}
