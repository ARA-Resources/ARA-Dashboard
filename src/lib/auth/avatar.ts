/**
 * Initials-based avatar helpers (Phase 4). No file upload — a user picks a
 * colour from a fixed palette and we render their initials on it.
 * Pure / isomorphic: safe to import from client components and Route Handlers.
 */

export const AVATAR_COLORS = [
  "slate",
  "red",
  "amber",
  "green",
  "teal",
  "blue",
  "indigo",
  "violet",
  "pink",
] as const;

export type AvatarColor = (typeof AVATAR_COLORS)[number];

export function isAvatarColor(value: unknown): value is AvatarColor {
  return (
    typeof value === "string" &&
    (AVATAR_COLORS as readonly string[]).includes(value)
  );
}

/** Solid background + readable foreground for each palette entry. */
export const AVATAR_COLOR_STYLES: Record<
  AvatarColor,
  { background: string; foreground: string }
> = {
  slate: { background: "#475569", foreground: "#ffffff" },
  red: { background: "#dc2626", foreground: "#ffffff" },
  amber: { background: "#d97706", foreground: "#ffffff" },
  green: { background: "#16a34a", foreground: "#ffffff" },
  teal: { background: "#0d9488", foreground: "#ffffff" },
  blue: { background: "#2563eb", foreground: "#ffffff" },
  indigo: { background: "#4f46e5", foreground: "#ffffff" },
  violet: { background: "#7c3aed", foreground: "#ffffff" },
  pink: { background: "#db2777", foreground: "#ffffff" },
};

/** Stable fallback colour derived from a string (email) when none is chosen. */
export function colorFromString(seed: string): AvatarColor {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash << 5) - hash + seed.charCodeAt(i);
    hash |= 0;
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length]!;
}

/** 1–2 uppercase letters from a display name, falling back to the email local part. */
export function initialsFrom(displayName: string | null, email: string): string {
  const name = (displayName ?? "").trim();
  if (name) {
    const parts = name.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
    }
    return name.slice(0, 2).toUpperCase();
  }
  const local = email.split("@")[0] ?? email;
  const segs = local.split(/[.\-_]+/).filter(Boolean);
  if (segs.length >= 2) return (segs[0]![0]! + segs[1]![0]!).toUpperCase();
  return local.slice(0, 2).toUpperCase() || "?";
}

export function resolveAvatar(input: {
  displayName: string | null;
  email: string;
  avatarColor: string | null;
}): { initials: string; background: string; foreground: string } {
  const color: AvatarColor = isAvatarColor(input.avatarColor)
    ? input.avatarColor
    : colorFromString(input.email);
  const style = AVATAR_COLOR_STYLES[color];
  return {
    initials: initialsFrom(input.displayName, input.email),
    background: style.background,
    foreground: style.foreground,
  };
}
