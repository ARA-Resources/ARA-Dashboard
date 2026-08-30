"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { PageHeader } from "@/components/layouts/page-header";
import { PageTransition } from "@/animations/page-transition";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api/client";

export default function LogoutPage() {
  const router = useRouter();
  const [done, setDone] = useState(false);

  useEffect(() => {
    // Same-origin /api/auth/logout → Node via Stage 8C-1 rewrite when configured.
    void apiFetch("/api/auth/logout", { method: "POST" })
      .catch(() => undefined)
      .finally(() => {
        setDone(true);
        router.replace("/login");
        router.refresh();
      });
  }, [router]);

  return (
    <PageTransition>
      <PageHeader
        title="Logout"
        description="Signing you out of the ARA Dashboard."
      />
      <Card className="max-w-lg shadow-sm">
        <CardHeader>
          <CardTitle>{done ? "Signed out" : "Signing out…"}</CardTitle>
          <CardDescription>
            Your session cookie is being cleared. You will need to sign in
            again to use the dashboard.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Link href="/login">
            <Button>Go to sign in</Button>
          </Link>
        </CardContent>
      </Card>
    </PageTransition>
  );
}
