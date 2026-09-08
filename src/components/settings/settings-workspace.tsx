"use client";

import { ChangePasswordCard } from "@/components/settings/change-password-card";
import { ProfileCard } from "@/components/settings/profile-card";

/**
 * Settings body — everything here is available to every signed-in user.
 *
 * Account (profile + change password) acts only on the caller's own row.
 */
export function SettingsWorkspace() {
  return (
    <div className="flex flex-col gap-6">
      <section className="grid gap-4 lg:grid-cols-2">
        <ProfileCard />
        <ChangePasswordCard />
      </section>
    </div>
  );
}
