"use client";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { resolveAvatar } from "@/lib/auth/avatar";
import { cn } from "@/lib/utils";

interface UserAvatarProps {
  email: string;
  displayName: string | null;
  avatarColor: string | null;
  size?: "default" | "sm" | "lg";
  className?: string;
}

/** Initials-on-colour avatar (Phase 4 — no image upload). */
export function UserAvatar({
  email,
  displayName,
  avatarColor,
  size = "default",
  className,
}: UserAvatarProps) {
  const { initials, background, foreground } = resolveAvatar({
    displayName,
    email,
    avatarColor,
  });
  return (
    <Avatar size={size} className={cn("ring-1 ring-border", className)}>
      <AvatarFallback
        className="font-medium"
        style={{ backgroundColor: background, color: foreground }}
      >
        {initials}
      </AvatarFallback>
    </Avatar>
  );
}
