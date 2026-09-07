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
import { useCurrentUser, CURRENT_USER_QUERY_KEY } from "@/hooks/use-current-user";
import { UserAvatar } from "@/components/navbar/user-avatar";
import {
  AVATAR_COLORS,
  AVATAR_COLOR_STYLES,
  type AvatarColor,
} from "@/lib/auth/avatar";
import { cn } from "@/lib/utils";

export function ProfileCard() {
  const queryClient = useQueryClient();
  const { user, isLoading } = useCurrentUser();

  const [displayName, setDisplayName] = React.useState("");
  const [color, setColor] = React.useState<AvatarColor | null>(null);
  const [seeded, setSeeded] = React.useState(false);
  const [status, setStatus] = React.useState<
    { kind: "error" | "success"; text: string } | null
  >(null);
  const [pending, setPending] = React.useState(false);

  React.useEffect(() => {
    if (user && !seeded) {
      setDisplayName(user.displayName ?? "");
      setColor((user.avatarColor as AvatarColor | null) ?? null);
      setSeeded(true);
    }
  }, [user, seeded]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus(null);
    setPending(true);
    try {
      const res = await apiFetch("/api/auth/profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          displayName: displayName.trim() === "" ? null : displayName.trim(),
          avatarColor: color,
        }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        setStatus({ kind: "error", text: data.error || "Could not save profile." });
        return;
      }
      setStatus({ kind: "success", text: "Profile saved." });
      void queryClient.invalidateQueries({ queryKey: CURRENT_USER_QUERY_KEY });
    } catch {
      setStatus({ kind: "error", text: "Could not save profile." });
    } finally {
      setPending(false);
    }
  }

  const email = user?.email ?? "";

  return (
    <Card className="shadow-sm">
      <CardHeader>
        <CardTitle>Profile</CardTitle>
        <CardDescription>
          Your display name and avatar. The avatar is your initials on a colour
          you pick.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <form className="flex max-w-sm flex-col gap-4" onSubmit={onSubmit}>
            <div className="flex items-center gap-3">
              <UserAvatar
                email={email}
                displayName={displayName || null}
                avatarColor={color}
                size="lg"
                className="size-12"
              />
              <div className="text-sm text-muted-foreground">{email}</div>
            </div>

            <label className="flex flex-col gap-1 text-sm">
              Display name
              <Input
                value={displayName}
                maxLength={80}
                placeholder="e.g. Anurag Shah"
                onChange={(e) => setDisplayName(e.target.value)}
              />
            </label>

            <div className="flex flex-col gap-1.5 text-sm">
              Avatar colour
              <div className="flex flex-wrap gap-2">
                {AVATAR_COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    aria-label={c}
                    aria-pressed={color === c}
                    onClick={() => setColor(c)}
                    className={cn(
                      "size-7 rounded-full ring-offset-2 ring-offset-background transition",
                      color === c ? "ring-2 ring-foreground" : "ring-0"
                    )}
                    style={{ backgroundColor: AVATAR_COLOR_STYLES[c].background }}
                  />
                ))}
                <button
                  type="button"
                  onClick={() => setColor(null)}
                  className={cn(
                    "h-7 rounded-full border border-border px-2 text-xs",
                    color === null ? "ring-2 ring-foreground" : ""
                  )}
                >
                  Auto
                </button>
              </div>
            </div>

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
              {pending ? "Saving…" : "Save profile"}
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
