"use client";

import { motion } from "framer-motion";
import {
  Briefcase,
  Crown,
  Handshake,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { AnimatedCounter } from "@/components/home/animated-counter";
import { HomeSection } from "@/components/home/home-section";
import {
  buttonHover,
  cardHover,
  fadeUp,
  staggerContainer,
} from "@/components/home/home-motion";
import {
  HOME_BUSINESS_UNIT_NAV,
  type HomeBusinessUnitNavItem,
} from "@/constants/home";
import { useHomeWidgets } from "@/hooks/use-home-widgets";
import { useHomeWorkspaceActions } from "@/hooks/use-home-workspace-actions";
import { cn } from "@/lib/utils";

const BU_ICONS: Record<HomeBusinessUnitNavItem["icon"], LucideIcon> = {
  lateral: Briefcase,
  executive: Crown,
  consulting: Handshake,
};

export function HomeBusinessUnits() {
  const { openBusinessUnit } = useHomeWorkspaceActions();
  const { data, isLoading, isError } = useHomeWidgets();

  const distributionById = new Map(
    (data?.businessUnitDistribution ?? []).map((item) => [
      item.businessUnitId,
      item,
    ])
  );

  const syncById = new Map(
    (data?.excelSyncStatus ?? []).map((item) => [item.businessUnitId, item])
  );

  return (
    <HomeSection
      title="Business Unit Overview"
    >
      <motion.div
        className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3"
        variants={staggerContainer}
        initial="hidden"
        whileInView="visible"
        viewport={{ once: true, margin: "-40px" }}
      >
        {HOME_BUSINESS_UNIT_NAV.map((unit) => {
          const Icon = BU_ICONS[unit.icon];
          const dist = distributionById.get(unit.id);
          const sync = syncById.get(unit.id);

          return (
            <motion.div key={unit.id} variants={fadeUp}>
              <motion.article
                initial="rest"
                whileHover="hover"
                animate="rest"
                variants={cardHover}
                role="button"
                tabIndex={0}
                onClick={() => openBusinessUnit(unit.moduleSlug)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    openBusinessUnit(unit.moduleSlug);
                  }
                }}
                className={cn(
                  "group flex h-full cursor-pointer flex-col rounded-2xl border border-border/60 bg-card p-5 shadow-sm outline-none",
                  "transition-[box-shadow,border-color] duration-300",
                  "hover:border-primary/30 hover:shadow-[0_14px_36px_-18px_rgba(142,36,170,0.4)]",
                  "focus-visible:ring-2 focus-visible:ring-primary/40"
                )}
              >
                <div className="mb-4 flex items-start justify-between gap-3">
                  <motion.div
                    className="flex size-11 items-center justify-center rounded-xl bg-primary/10 text-primary"
                    whileHover={{ rotate: 8 }}
                  >
                    <Icon className="size-5" />
                  </motion.div>
                </div>

                <h3 className="text-lg font-semibold text-primary">{unit.name}</h3>
                <p className="mt-2 flex-1 text-sm leading-relaxed text-muted-foreground">
                  {unit.description}
                </p>

                <div className="mt-5 grid grid-cols-2 gap-3 rounded-xl bg-muted/50 p-3 dark:bg-muted/20">
                  <div>
                    <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                      Total Openings
                    </p>
                    {isLoading ? (
                      <Skeleton className="mt-2 h-7 w-14 rounded-md" />
                    ) : isError || !dist ? (
                      <p className="mt-1 text-sm font-medium text-muted-foreground">
                        —
                      </p>
                    ) : (
                      <p className="mt-1 text-xl font-semibold text-foreground">
                        <AnimatedCounter value={dist.openings} />
                      </p>
                    )}
                  </div>
                  <div>
                    <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                      Last Synced
                    </p>
                    {isLoading ? (
                      <Skeleton className="mt-2 h-5 w-20 rounded-md" />
                    ) : (
                      <p className="mt-1 text-sm font-medium text-foreground">
                        {sync
                          ? new Date(sync.lastSyncedAt).toLocaleString(
                              undefined,
                              {
                                month: "short",
                                day: "numeric",
                                hour: "2-digit",
                                minute: "2-digit",
                              }
                            )
                          : "—"}
                      </p>
                    )}
                  </div>
                </div>

                <motion.div
                  className="mt-5"
                  variants={buttonHover}
                  initial="rest"
                  whileHover="hover"
                  whileTap="tap"
                >
                  <Button
                    className="w-full rounded-xl"
                    onClick={(event) => {
                      event.stopPropagation();
                      openBusinessUnit(unit.moduleSlug);
                    }}
                  >
                    View Dashboard
                  </Button>
                </motion.div>
              </motion.article>
            </motion.div>
          );
        })}
      </motion.div>
    </HomeSection>
  );
}
