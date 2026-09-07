"use client";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { COMPANIES } from "@/constants/companies";
import { ChangePasswordCard } from "@/components/settings/change-password-card";
import { ProfileCard } from "@/components/settings/profile-card";

/**
 * Settings body — everything here is available to every signed-in user.
 *
 * Account (profile + change password) acts only on the caller's own row.
 * The Companies card is read-only reference: the registry is a compile-time
 * constant (src/constants/companies.ts) that already ships in every user's JS
 * bundle and drives the sidebar, and there is no endpoint behind it — so it is
 * not role-gated.
 */
export function SettingsWorkspace() {
  return (
    <div className="flex flex-col gap-6">
      <section className="grid gap-4 lg:grid-cols-2">
        <ProfileCard />
        <ChangePasswordCard />
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <Card className="shadow-sm">
          <CardHeader>
            <CardTitle>Companies</CardTitle>
            <CardDescription>
              Reference only. Add or update companies in one file:{" "}
              <code>src/constants/companies.ts</code>
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2 text-sm">
              {COMPANIES.map((company) => (
                <li
                  key={company.id}
                  className="rounded-lg border border-border bg-muted/40 p-3"
                >
                  <p className="font-medium text-foreground">{company.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {company.modules.length > 0
                      ? company.modules.map((m) => m.label).join(" · ")
                      : "Modules coming later"}
                  </p>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>

        <Card className="shadow-sm">
          <CardHeader>
            <CardTitle>Theme</CardTitle>
            <CardDescription>
              Use the navbar toggle for Light / Dark mode.
            </CardDescription>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            Your choice is remembered on this device.
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
