"use client";

import Link from "next/link";
import { Building2 } from "lucide-react";
import { FadeIn } from "@/animations/fade-in";
import { PageHeader } from "@/components/layouts/page-header";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { getEnabledCompanies } from "@/constants/companies";
import { useNavigation } from "@/hooks/use-navigation";

export default function CompanyIndexPage() {
  const companies = getEnabledCompanies();
  const { expandForWorkspace, setActiveCompanyId } = useNavigation();

  return (
    <div>
      <PageHeader
        title="Company"
        description="Choose a company, then open its dashboard or business-unit modules."
      />

      <FadeIn>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {companies.map((company) => (
            <Link
              key={company.id}
              href={`/company/${company.slug}`}
              onClick={() => {
                setActiveCompanyId(company.id);
                expandForWorkspace("company", company.id);
              }}
              className="group block rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Card className="h-full shadow-sm transition-colors group-hover:border-primary/40 group-hover:bg-muted/30">
                <CardHeader className="flex flex-row items-start gap-3 space-y-0">
                  <span className="flex size-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
                    <Building2 className="size-5" />
                  </span>
                  <div className="space-y-1">
                    <CardTitle className="text-base">{company.name}</CardTitle>
                    <CardDescription>
                      {company.modules.length} module
                      {company.modules.length === 1 ? "" : "s"}
                    </CardDescription>
                  </div>
                </CardHeader>
              </Card>
            </Link>
          ))}
        </div>
      </FadeIn>
    </div>
  );
}
