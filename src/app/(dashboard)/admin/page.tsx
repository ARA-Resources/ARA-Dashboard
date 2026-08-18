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

export const metadata: Metadata = {
  title: "Admin",
};

export default function AdminPage() {
  return (
    <PageTransition>
      <PageHeader
        title="Admin"
        description="Administration tools. Synced with the profile Admin item."
      />
      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle>Admin</CardTitle>
          <CardDescription>
            Admin workspace placeholder — expand this section as needed.
          </CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Coming in a later phase.
        </CardContent>
      </Card>
    </PageTransition>
  );
}
