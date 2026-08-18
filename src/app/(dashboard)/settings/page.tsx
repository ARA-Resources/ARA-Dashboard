import type { Metadata } from "next";
import { PageHeader } from "@/components/layouts/page-header";
import { PageTransition } from "@/animations/page-transition";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { COMPANIES } from "@/constants/companies";

export const metadata: Metadata = {
  title: "Settings",
};

export default function SettingsPage() {
  return (
    <PageTransition>
      <PageHeader
        title="Settings"
        description="Theme, source registry, and company configuration."
      />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="shadow-sm">
          <CardHeader>
            <CardTitle>Companies</CardTitle>
            <CardDescription>
              Add or update companies in one file:{" "}
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
            Profile menu and sidebar share the same workspace state.
          </CardContent>
        </Card>
      </div>
    </PageTransition>
  );
}
