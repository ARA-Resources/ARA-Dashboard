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

type AuthMode = "signin" | "signup";

export function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const nextPath = searchParams.get("next") || "/home";
  const [mode, setMode] = useState<AuthMode>("signin");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
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

  function switchMode(next: AuthMode) {
    setMode(next);
    setError(null);
    setPassword("");
    setConfirmPassword("");
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);

    if (mode === "signup" && password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }

    setPending(true);
    try {
      const res = await fetch(
        mode === "signup" ? "/api/auth/signup" : "/api/auth/login",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username, password }),
        }
      );
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        setError(
          data.error ||
            (mode === "signup" ? "Sign-up failed." : "Sign-in failed.")
        );
        return;
      }
      const safeNext =
        nextPath.startsWith("/") && !nextPath.startsWith("//")
          ? nextPath
          : "/home";
      router.replace(safeNext);
      router.refresh();
    } catch {
      setError(mode === "signup" ? "Sign-up failed." : "Sign-in failed.");
    } finally {
      setPending(false);
    }
  }

  const isSignup = mode === "signup";

  return (
    <Card className="w-full max-w-md shadow-sm">
      <CardHeader>
        <CardTitle>{isSignup ? "Create account" : "Sign in"}</CardTitle>
        <CardDescription>
          {isSignup
            ? "Create an ARA Dashboard account to continue."
            : "ARA Dashboard access is restricted to authorized operators."}
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
              Email or username
              <Input
                name="username"
                autoComplete="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              Password
              <Input
                name="password"
                type="password"
                autoComplete={isSignup ? "new-password" : "current-password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </label>
            {isSignup ? (
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
            ) : null}
            {error ? (
              <p className="text-sm text-destructive">{error}</p>
            ) : null}
            <Button type="submit" disabled={pending || configured === null}>
              {pending
                ? isSignup
                  ? "Creating account…"
                  : "Signing in…"
                : isSignup
                  ? "Sign up"
                  : "Sign in"}
            </Button>
            <p className="text-center text-sm text-muted-foreground">
              {isSignup ? "Already have an account?" : "Need an account?"}{" "}
              <button
                type="button"
                className="text-foreground underline-offset-4 hover:underline"
                onClick={() => switchMode(isSignup ? "signin" : "signup")}
              >
                {isSignup ? "Sign in" : "Sign up"}
              </button>
            </p>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
