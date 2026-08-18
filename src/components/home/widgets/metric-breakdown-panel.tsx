"use client";

import { forwardRef } from "react";
import { X } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { Button } from "@/components/ui/button";
import type { BusinessUnitMetricBreakdownItem } from "@/types/home-widgets";

interface MetricBreakdownPanelProps {
  open: boolean;
  title: string;
  items: BusinessUnitMetricBreakdownItem[];
  onClose: () => void;
}

export const MetricBreakdownPanel = forwardRef<
  HTMLElement,
  MetricBreakdownPanelProps
>(function MetricBreakdownPanel({ open, title, items, onClose }, ref) {
  return (
    <AnimatePresence>
      {open ? (
        <motion.aside
          ref={ref}
          initial={{ opacity: 0, x: 20 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: 20 }}
          transition={{ duration: 0.2 }}
          className="fixed right-5 bottom-5 z-40 w-[min(92vw,420px)] rounded-2xl border border-border/70 bg-card/95 p-4 shadow-2xl backdrop-blur"
          aria-label={`${title} breakdown panel`}
        >
          <div className="mb-3 flex items-start justify-between gap-3">
            <div>
              <h4 className="text-sm font-semibold text-primary">{title}</h4>
              <p className="text-xs text-muted-foreground">
                Lateral, Executive, Consulting
              </p>
            </div>
            <Button
              size="icon-sm"
              variant="ghost"
              className="rounded-lg"
              onClick={onClose}
              aria-label="Close breakdown panel"
            >
              <X />
            </Button>
          </div>

          <div className="space-y-2">
            {items.map((item) => (
              <div
                key={item.businessUnitId}
                className="flex items-center justify-between rounded-xl border border-border/60 bg-muted/30 px-3 py-2.5"
              >
                <span className="text-sm font-medium text-foreground">
                  {item.name}
                </span>
                <span className="text-sm font-semibold tabular-nums text-primary">
                  {item.value.toLocaleString()}
                </span>
              </div>
            ))}
          </div>
        </motion.aside>
      ) : null}
    </AnimatePresence>
  );
});
