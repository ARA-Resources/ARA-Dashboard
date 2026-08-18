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

export function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const nextPath = searchParams.get("next") || "/home";
  const [username, setUsername] = useState("operator");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    void fetch("/api/auth/login", { cache: "no-store" })
      .then((res) => res.json())
      .then((data: { configured?: boolean }) => {
        setConfigured(Boolean(data.configured));
      })
      .catch(() => setConfigured(false));
  }, []);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setPending(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        setError(data.error || "Sign-in failed.");
        return;
      }
      const safeNext =
        nextPath.startsWith("/") && !nextPath.startsWith("//")
          ? nextPath
          : "/home";
      router.replace(safeNext);
      router.refresh();
    } catch {
      setError("Sign-in failed.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Card className="w-full max-w-md shadow-sm">
      <CardHeader>
        <CardTitle>Sign in</CardTitle>
        <CardDescription>
          ARA Dashboard access is restricted to authorized operators.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {configured === false ? (
          <p className="text-sm text-muted-foreground">
            Authentication is not configured. Set{" "}
            <code>ARA_SESSION_SECRET</code> and{" "}
            <code>ARA_DASHBOARD_PASSWORD</code>, then restart the server.
          </p>
        ) : (
          <form className="flex flex-col gap-3" onSubmit={onSubmit}>
            <label className="flex flex-col gap-1 text-sm">
              Username
              <Input
                name="username"
                autoComplete="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              Password
              <Input
                name="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </label>
            {error ? (
              <p className="text-sm text-destructive">{error}</p>
            ) : null}
            <Button type="submit" disabled={pending || configured === null}>
              {pending ? "Signing in…" : "Sign in"}
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
