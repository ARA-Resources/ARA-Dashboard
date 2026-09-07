"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { apiFetch } from "@/lib/api/client";

type InviteState =
  | { status: "loading" }
  | { status: "invalid"; error: string }
  | { status: "ready"; email: string; role: string };

export function AcceptInviteForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get("token") ?? "";

  const [invite, setInvite] = useState<InviteState>({ status: "loading" });
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!token) {
      setInvite({
        status: "invalid",
        error: "This invite link is missing its token.",
      });
      return;
    }

    void apiFetch(
      `/api/auth/accept-invite?token=${encodeURIComponent(token)}`,
      { cache: "no-store" }
    )
      .then(async (res) => {
        const data = (await res.json()) as {
          ok?: boolean;
          email?: string;
          role?: string;
          error?: string;
        };
        if (!res.ok || !data.ok || !data.email || !data.role) {
          setInvite({
            status: "invalid",
            error: data.error || "This invite link is not valid.",
          });
          return;
        }
        setInvite({ status: "ready", email: data.email, role: data.role });
      })
      .catch(() => {
        setInvite({
          status: "invalid",
          error: "Could not check this invite right now. Try again later.",
        });
      });
  }, [token]);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);

    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }

    setPending(true);
    try {
      const res = await apiFetch("/api/auth/accept-invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password, confirmPassword }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        setError(data.error || "Could not complete the invite.");
        return;
      }
      router.replace("/home");
      router.refresh();
    } catch {
      setError("Could not complete the invite.");
    } finally {
      setPending(false);
    }
  }

  if (invite.status === "loading") {
    return (
      <p className="text-sm text-muted-foreground">Checking your invite…</p>
    );
  }

  if (invite.status === "invalid") {
    return (
      <Card className="w-full max-w-md shadow-sm">
        <CardHeader>
          <CardTitle>Invite unavailable</CardTitle>
          <CardDescription>{invite.error}</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Ask a super admin to send you a new invite link.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="w-full max-w-md shadow-sm">
      <CardHeader>
        <CardTitle>Set your password</CardTitle>
        <CardDescription>
          You&rsquo;ve been invited to the ARA Dashboard as{" "}
          <strong>{invite.role}</strong>. Set a password to finish creating your
          account.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="flex flex-col gap-3" onSubmit={onSubmit}>
          <label className="flex flex-col gap-1 text-sm">
            Email
            <Input
              name="email"
              value={invite.email}
              readOnly
              disabled
              autoComplete="username"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Password
            <Input
              name="password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Confirm password
            <Input
              name="confirmPassword"
              type="password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              required
            />
          </label>
          {error ? (
            <p className="text-sm text-destructive">{error}</p>
          ) : null}
          <Button type="submit" disabled={pending}>
            {pending ? "Setting password…" : "Set password & sign in"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
