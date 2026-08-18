"use client";

import { motion } from "framer-motion";
import {
  ArrowRight,
  Building2,
  UserRound,
  type LucideIcon,
} from "lucide-react";
import { HomeSection } from "@/components/home/home-section";
import { cardHover, fadeUp, staggerContainer } from "@/components/home/home-motion";
import { HOME_QUICK_ACTIONS, type HomeQuickActionItem } from "@/constants/home";
import { useHomeWorkspaceActions } from "@/hooks/use-home-workspace-actions";
import { cn } from "@/lib/utils";

const ACTION_ICONS: Record<HomeQuickActionItem["icon"], LucideIcon> = {
  company: Building2,
  candidate: UserRound,
};

export function HomeQuickActions() {
  const { enterCandidate, openCompanyDashboard } = useHomeWorkspaceActions();

  function handleAction(action: HomeQuickActionItem["action"]) {
    switch (action) {
      case "company":
        openCompanyDashboard();
        break;
      case "candidate":
        enterCandidate();
        break;
      default:
        break;
    }
  }

  return (
    <HomeSection
      title="Quick Actions"
    >
      <motion.div
        className="grid grid-cols-1 gap-3 sm:grid-cols-2"
        variants={staggerContainer}
        initial="hidden"
        whileInView="visible"
        viewport={{ once: true, margin: "-40px" }}
      >
        {HOME_QUICK_ACTIONS.map((item) => {
          const Icon = ACTION_ICONS[item.icon];
          return (
            <motion.div key={item.id} variants={fadeUp}>
              <motion.button
                type="button"
                onClick={() => handleAction(item.action)}
                initial="rest"
                whileHover="hover"
                animate="rest"
                variants={cardHover}
                className={cn(
                  "group flex w-full items-start gap-4 rounded-2xl border border-border/60 bg-card p-4 text-left shadow-sm outline-none",
                  "transition-[box-shadow,border-color] duration-300",
                  "hover:border-primary/30 hover:shadow-[0_14px_36px_-18px_rgba(142,36,170,0.4)]",
                  "focus-visible:ring-2 focus-visible:ring-primary/40"
                )}
              >
                <motion.span
                  className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary"
                  whileHover={{ rotate: -8 }}
                >
                  <Icon className="size-5" />
                </motion.span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center justify-between gap-2">
                    <span className="text-sm font-semibold text-foreground">
                      {item.title}
                    </span>
                    <ArrowRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-primary" />
                  </span>
                  <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
                    {item.description}
                  </span>
                </span>
              </motion.button>
            </motion.div>
          );
        })}
      </motion.div>
    </HomeSection>
  );
}
