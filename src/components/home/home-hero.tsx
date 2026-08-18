"use client";

import Image from "next/image";
import { motion } from "framer-motion";
import { fadeUp } from "@/components/home/home-motion";
import { HOME_META } from "@/constants/home";
import { NAVBAR } from "@/constants/navbar";

export function HomeHero() {
  return (
    <motion.section
      variants={fadeUp}
      initial="hidden"
      animate="visible"
      className="relative overflow-hidden rounded-3xl border border-border/60 bg-gradient-to-br from-white via-white to-accent/40 p-6 shadow-sm sm:p-8 lg:p-10 dark:from-card dark:via-card dark:to-primary/10"
    >
      <div
        aria-hidden
        className="pointer-events-none absolute -top-24 -right-16 size-72 rounded-full bg-primary/10 blur-3xl dark:bg-primary/20"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -bottom-20 -left-10 size-56 rounded-full bg-secondary/10 blur-3xl"
      />

      <div className="relative">
        <div>
          <motion.div
            className="relative mb-6 size-14 overflow-hidden rounded-2xl ring-1 ring-border shadow-sm sm:size-16"
            initial={{ scale: 0.92, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ type: "spring", stiffness: 260, damping: 20 }}
          >
            <Image
              src={NAVBAR.logoPath}
              alt="ARA"
              fill
              sizes="64px"
              className="object-contain"
              priority
            />
          </motion.div>

          <h1 className="max-w-xl text-3xl font-semibold tracking-tight text-primary sm:text-4xl lg:text-[2.75rem] lg:leading-tight">
            {HOME_META.heroTitle}
          </h1>
          <p className="mt-4 max-w-lg text-sm leading-relaxed text-muted-foreground sm:text-base">
            {HOME_META.heroDescription}
          </p>
        </div>
      </div>
    </motion.section>
  );
}
