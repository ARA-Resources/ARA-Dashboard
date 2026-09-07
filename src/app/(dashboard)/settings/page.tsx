import type { Metadata } from "next";
import { PageHeader } from "@/components/layouts/page-header";
import { PageTransition } from "@/animations/page-transition";
import { SettingsWorkspace } from "@/components/settings/settings-workspace";

export const metadata: Metadata = {
  title: "Settings",
};

export default function SettingsPage() {
  return (
    <PageTransition>
      <PageHeader
        title="Settings"
        description="Your account, profile, and workspace preferences."
      />
      <SettingsWorkspace />
    </PageTransition>
  );
}
