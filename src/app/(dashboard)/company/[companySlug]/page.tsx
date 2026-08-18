import Link from "next/link";
import { notFound } from "next/navigation";
import { LayoutDashboard } from "lucide-react";
import { PageTransition } from "@/animations/page-transition";
import { PageHeader } from "@/components/layouts/page-header";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  getCompanyBySlug,
  getCompanyModuleHref,
} from "@/constants/companies";

interface CompanyPageProps {
  params: Promise<{ companySlug: string }>;
}

export default async function CompanyLandingPage({ params }: CompanyPageProps) {
  const { companySlug } = await params;
  const company = getCompanyBySlug(companySlug);

  if (!company || !company.enabled) {
    notFound();
  }

  return (
    <PageTransition>
      <PageHeader
        title={company.name}
        description="Select a module to open its dashboard."
      />

      {company.modules.length === 0 ? (
        <Card className="shadow-sm">
          <CardHeader>
            <CardTitle>{company.name}</CardTitle>
            <CardDescription>
              No modules configured yet. Add them in{" "}
              <code>src/constants/companies.ts</code>.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {company.modules.map((module) => {
            const href = getCompanyModuleHref(company.slug, module);
            return (
              <Link
                key={module.id}
                href={href}
                className="group block rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Card className="h-full shadow-sm transition-colors group-hover:border-primary/40 group-hover:bg-muted/30">
                  <CardHeader className="flex flex-row items-start gap-3 space-y-0">
                    <span className="flex size-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
                      <LayoutDashboard className="size-5" />
                    </span>
                    <div className="space-y-1">
                      <CardTitle className="text-base">{module.label}</CardTitle>
                      <CardDescription>
                        Open {module.label.toLowerCase()}
                      </CardDescription>
                    </div>
                  </CardHeader>
                </Card>
              </Link>
            );
          })}
        </div>
      )}
    </PageTransition>
  );
}
