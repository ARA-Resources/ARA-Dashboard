"use client";

import { motion } from "framer-motion";
import { cn } from "@/lib/utils";
import { fadeUp } from "@/components/home/home-motion";

interface HomeSectionProps {
  id?: string;
  title?: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
  headerClassName?: string;
}

export function HomeSection({
  id,
  title,
  description,
  children,
  className,
  headerClassName,
}: HomeSectionProps) {
  return (
    <motion.section
      id={id}
      variants={fadeUp}
      initial="hidden"
      whileInView="visible"
      viewport={{ once: true, margin: "-60px" }}
      className={cn("scroll-mt-24", className)}
    >
      {(title || description) && (
        <div className={cn("mb-6", headerClassName)}>
          {title ? (
            <h2 className="text-xl font-semibold tracking-tight text-primary sm:text-2xl">
              {title}
            </h2>
          ) : null}
          {description ? (
            <p className="mt-1.5 max-w-2xl text-sm text-muted-foreground">
              {description}
            </p>
          ) : null}
        </div>
      )}
      {children}
    </motion.section>
  );
}
