"use client";

import { motion } from "framer-motion";
import { fadeIn } from "@/animations/variants";

export function PageTransition({ children }: { children: React.ReactNode }) {
  return (
    <motion.div
      initial="hidden"
      animate="visible"
      variants={fadeIn}
      className="h-full w-full"
    >
      {children}
    </motion.div>
  );
}
