"use client";

import { motion } from "framer-motion";

/** Abstract dashboard graphic — brand magenta / pink only */
export function HomeHeroGraphic({ className }: { className?: string }) {
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, x: 24 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.7, delay: 0.15, ease: [0.22, 1, 0.36, 1] }}
      aria-hidden
    >
      <div className="relative mx-auto aspect-[4/3] w-full max-w-lg">
        <div className="absolute -inset-4 rounded-[2rem] bg-gradient-to-br from-primary/15 via-secondary/10 to-transparent blur-2xl dark:from-primary/25 dark:via-secondary/15" />

        <div className="relative h-full overflow-hidden rounded-2xl border border-border/70 bg-card/80 p-4 shadow-[0_20px_50px_-24px_rgba(142,36,170,0.35)] backdrop-blur-sm dark:bg-card/60">
          <div className="mb-3 flex items-center gap-2">
            <span className="size-2.5 rounded-full bg-secondary" />
            <span className="size-2.5 rounded-full bg-primary/70" />
            <span className="size-2.5 rounded-full bg-muted-foreground/30" />
            <span className="ml-auto h-2 w-20 rounded-full bg-muted" />
          </div>

          <div className="grid h-[calc(100%-1.25rem)] grid-cols-3 gap-3">
            <div className="col-span-2 flex flex-col gap-3">
              <div className="flex flex-1 flex-col justify-end rounded-xl bg-gradient-to-br from-primary/20 to-secondary/15 p-3 dark:from-primary/30 dark:to-secondary/20">
                <div className="mb-2 flex items-end gap-1.5">
                  {[40, 65, 48, 82, 58, 90, 72].map((h, i) => (
                    <motion.div
                      key={i}
                      className="flex-1 rounded-t-md bg-gradient-to-t from-secondary to-primary"
                      initial={{ height: 0 }}
                      animate={{ height: `${h}%` }}
                      transition={{
                        delay: 0.35 + i * 0.05,
                        duration: 0.55,
                        ease: [0.22, 1, 0.36, 1],
                      }}
                      style={{ minHeight: 8 }}
                    />
                  ))}
                </div>
                <div className="h-1.5 w-2/3 rounded-full bg-primary/30" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-xl border border-border/60 bg-background/80 p-3">
                  <div className="mb-2 h-1.5 w-10 rounded-full bg-primary/40" />
                  <div className="h-6 w-14 rounded-md bg-primary/20" />
                </div>
                <div className="rounded-xl border border-border/60 bg-background/80 p-3">
                  <div className="mb-2 h-1.5 w-12 rounded-full bg-secondary/40" />
                  <div className="h-6 w-16 rounded-md bg-secondary/20" />
                </div>
              </div>
            </div>

            <div className="flex flex-col gap-3">
              <div className="flex-1 rounded-xl border border-border/60 bg-background/80 p-3">
                <div className="mb-3 size-8 rounded-lg bg-primary/15" />
                <div className="space-y-2">
                  <div className="h-1.5 w-full rounded-full bg-muted" />
                  <div className="h-1.5 w-4/5 rounded-full bg-muted" />
                  <div className="h-1.5 w-3/5 rounded-full bg-muted" />
                </div>
              </div>
              <div className="rounded-xl bg-gradient-to-br from-secondary/90 to-primary p-3 text-white shadow-sm">
                <div className="mb-2 h-1.5 w-10 rounded-full bg-white/50" />
                <div className="h-5 w-12 rounded-md bg-white/25" />
              </div>
            </div>
          </div>
        </div>
      </div>
    </motion.div>
  );
}
