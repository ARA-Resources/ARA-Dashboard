"use client";

import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
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
import { CURRENT_USER_QUERY_KEY } from "@/hooks/use-current-user";

export function ChangePasswordCard() {
  const queryClient = useQueryClient();
  const [current, setCurrent] = React.useState("");
  const [next, setNext] = React.useState("");
  const [confirm, setConfirm] = React.useState("");
  const [status, setStatus] = React.useState<
    { kind: "error" | "success"; text: string } | null
  >(null);
  const [pending, setPending] = React.useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus(null);
    if (next !== confirm) {
      setStatus({ kind: "error", text: "New passwords do not match." });
      return;
    }
    setPending(true);
    try {
      const res = await apiFetch("/api/auth/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          currentPassword: current,
          newPassword: next,
          confirmPassword: confirm,
        }),
      });
      const data = (await res.json()) as { error?: string; message?: string };
      if (!res.ok) {
        setStatus({ kind: "error", text: data.error || "Could not change password." });
        return;
      }
      setStatus({
        kind: "success",
        text: data.message || "Password changed. Other devices have been signed out.",
      });
      setCurrent("");
      setNext("");
      setConfirm("");
      void queryClient.invalidateQueries({ queryKey: CURRENT_USER_QUERY_KEY });
    } catch {
      setStatus({ kind: "error", text: "Could not change password." });
    } finally {
      setPending(false);
    }
  }

  return (
    <Card className="shadow-sm">
      <CardHeader>
        <CardTitle>Change password</CardTitle>
        <CardDescription>
          Changing your password signs you out of every other device. This one
          stays signed in.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="flex max-w-sm flex-col gap-3" onSubmit={onSubmit}>
          <label className="flex flex-col gap-1 text-sm">
            Current password
            <Input
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              required
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            New password
            <Input
              type="password"
              autoComplete="new-password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              required
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Confirm new password
            <Input
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
            />
          </label>
          {status ? (
            <p
              className={
                status.kind === "error"
                  ? "text-sm text-destructive"
                  : "text-sm text-green-600 dark:text-green-500"
              }
            >
              {status.text}
            </p>
          ) : null}
          <Button type="submit" disabled={pending}>
            {pending ? "Changing…" : "Change password"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
