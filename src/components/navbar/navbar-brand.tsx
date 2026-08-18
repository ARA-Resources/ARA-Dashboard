"use client";

import Image from "next/image";
import Link from "next/link";
import { motion } from "framer-motion";
import { NAVBAR } from "@/constants/navbar";
import { ROUTES } from "@/constants/routes";
import { cn } from "@/lib/utils";

interface NavbarBrandProps {
  className?: string;
  compact?: boolean;
}

export function NavbarBrand({ className, compact = false }: NavbarBrandProps) {
  return (
    <Link
      href={ROUTES.homePage}
      aria-label="ARA Dashboard Home"
      className={cn(
        "group flex min-w-0 items-center gap-2.5 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className
      )}
    >
      <motion.div
        whileHover={{ scale: 1.04 }}
        whileTap={{ scale: 0.97 }}
        transition={{ type: "spring", stiffness: 400, damping: 24 }}
        className="relative size-9 shrink-0 overflow-hidden rounded-md ring-1 ring-border"
      >
        <Image
          src={NAVBAR.logoPath}
          alt="ARA"
          fill
          sizes="36px"
          className="object-contain"
          priority
        />
      </motion.div>
      <p
        className={cn(
          "truncate text-sm font-semibold tracking-tight text-foreground transition-colors group-hover:text-primary",
          compact && "hidden sm:block"
        )}
      >
        {NAVBAR.brandName}
      </p>
    </Link>
  );
}
