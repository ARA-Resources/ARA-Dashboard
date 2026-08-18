"use client";

import { HomeBusinessUnits } from "@/components/home/home-business-units";
import { HomeFooter } from "@/components/home/home-footer";
import { HomeHero } from "@/components/home/home-hero";
import { HomeQuickActions } from "@/components/home/home-quick-actions";
import { HomeWidgetsGrid } from "@/components/home/widgets";

export function HomePageContent() {
  return (
    <div className="relative mx-auto w-full max-w-6xl space-y-12 pb-6 sm:space-y-14 sm:pb-8">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 -top-8 -z-10 h-72 bg-gradient-to-b from-primary/5 via-transparent to-transparent dark:from-primary/10"
      />

      <HomeHero />

      <HomeWidgetsGrid />

      <HomeQuickActions />

      <HomeBusinessUnits />

      <HomeFooter />
    </div>
  );
}
