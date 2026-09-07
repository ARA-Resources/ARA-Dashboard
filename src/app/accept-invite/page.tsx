import type { Metadata } from "next";
import { Suspense } from "react";
import { AcceptInviteForm } from "./accept-invite-form";

export const metadata: Metadata = {
  title: "Accept invite",
};

export default function AcceptInvitePage() {
  return (
    <main className="flex min-h-full items-center justify-center p-6">
      <Suspense
        fallback={
          <p className="text-sm text-muted-foreground">Loading…</p>
        }
      >
        <AcceptInviteForm />
      </Suspense>
    </main>
  );
}
