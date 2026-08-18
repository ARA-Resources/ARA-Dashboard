"use client";

import { useEffect, useState } from "react";
import { useTheme } from "@/providers/theme-provider";
import { motion } from "framer-motion";
import { fadeUp } from "@/components/home/home-motion";
import { HOME_META } from "@/constants/home";

export function HomeFooter() {
  const { resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const themeLabel = !mounted
    ? "—"
    : resolvedTheme === "dark"
      ? "Dark"
      : "Light";

  return (
    <motion.footer
      variants={fadeUp}
      initial="hidden"
      whileInView="visible"
      viewport={{ once: true }}
      className="border-t border-border/60 pt-8 pb-2"
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-sm font-semibold text-primary">
            {HOME_META.productName}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Version {HOME_META.version} · Built for {HOME_META.builtFor}
          </p>
        </div>
        <div className="flex flex-wrap gap-x-6 gap-y-2 text-xs text-muted-foreground">
          <p>
            Current Theme{" "}
            <span className="font-medium text-foreground">{themeLabel}</span>
          </p>
          <p>
            Current User{" "}
            <span className="font-medium text-foreground">
              {HOME_META.defaultUserLabel}
            </span>
          </p>
        </div>
      </div>
    </motion.footer>
  );
}
