import type { Metadata } from "next";
import { PageHeader } from "@/components/layouts/page-header";
import { PageTransition } from "@/animations/page-transition";
import { AdminWorkspace } from "@/components/admin/admin-workspace";

export const metadata: Metadata = {
  title: "Admin",
};

export default function AdminPage() {
  return (
    <PageTransition>
      <PageHeader
        title="Admin"
        description="User management and administration."
      />
      <AdminWorkspace />
    </PageTransition>
  );
}
