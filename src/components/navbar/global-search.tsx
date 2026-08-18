"use client";

import { Search, X } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useSearchStore } from "@/stores/search-store";
import { NAVBAR } from "@/constants/navbar";
import { cn } from "@/lib/utils";

interface GlobalSearchProps {
  className?: string;
  expanded?: boolean;
  onClose?: () => void;
}

export function GlobalSearch({
  className,
  expanded = true,
  onClose,
}: GlobalSearchProps) {
  const query = useSearchStore((s) => s.query);
  const setQuery = useSearchStore((s) => s.setQuery);
  const clearQuery = useSearchStore((s) => s.clearQuery);

  return (
    <motion.div
      layout
      className={cn("relative w-full", className)}
      initial={false}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.2 }}
    >
      <Search className="pointer-events-none absolute top-1/2 left-3 z-10 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={NAVBAR.searchPlaceholder}
        aria-label="Global search"
        className={cn(
          "h-10 rounded-xl border-border/80 bg-muted/40 pr-10 pl-9 shadow-none transition-[box-shadow,background-color,border-color] duration-200",
          "placeholder:text-muted-foreground/80",
          "focus-visible:border-primary/40 focus-visible:bg-background focus-visible:ring-primary/20"
        )}
      />
      <AnimatePresence>
        {(query || (expanded && onClose)) && (
          <motion.div
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.9 }}
            className="absolute top-1/2 right-1.5 flex -translate-y-1/2 items-center gap-0.5"
          >
            {query ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Clear search"
                onClick={clearQuery}
                className="text-muted-foreground"
              >
                <X className="size-3.5" />
              </Button>
            ) : null}
            {onClose ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Close search"
                onClick={onClose}
                className="text-muted-foreground md:hidden"
              >
                <X className="size-3.5" />
              </Button>
            ) : null}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
