"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { Bell } from "lucide-react";
import { motion } from "framer-motion";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { HOME_WIDGETS_QUERY_KEY } from "@/services/home/fetch-home-widgets";
import { apiFetch } from "@/lib/api/client";
import type { AppNotification } from "@/types/notifications";

export function NotificationsButton() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [notifications, setNotifications] = React.useState<AppNotification[]>(
    []
  );
  const [unreadCount, setUnreadCount] = React.useState(0);
  const seenSyncIds = React.useRef<Set<string>>(new Set());

  const load = React.useCallback(async () => {
    try {
      // Same-origin /api/dataset/notifications → Node via Stage 11 rewrite when configured.
      const response = await apiFetch("/api/dataset/notifications", {
        cache: "no-store",
      });
      if (!response.ok) return;
      const payload = (await response.json()) as {
        notifications?: AppNotification[];
        unreadCount?: number;
      };
      const next = payload.notifications ?? [];

      const freshSync = next.filter(
        (item) =>
          (item.kind === "dataset_sync_success" ||
            item.kind === "dataset_sync_partial" ||
            item.kind === "dataset_sync_failed") &&
          !seenSyncIds.current.has(item.id)
      );
      for (const item of freshSync) {
        seenSyncIds.current.add(item.id);
      }
      if (freshSync.length > 0) {
        void queryClient.invalidateQueries({ queryKey: HOME_WIDGETS_QUERY_KEY });
        void queryClient.invalidateQueries({ queryKey: ["excel-openings"] });
        void queryClient.invalidateQueries({ queryKey: ["excel-filters"] });
        void queryClient.invalidateQueries({ queryKey: ["skill-clusters"] });
        void queryClient.invalidateQueries({
          queryKey: ["lateral-master-sheet-schema"],
        });
        void queryClient.invalidateQueries({
          queryKey: ["lateral-master-sheet"],
        });
      }

      setNotifications(next);
      setUnreadCount(payload.unreadCount ?? 0);
    } catch {
      // keep prior state
    }
  }, [queryClient]);

  React.useEffect(() => {
    void load();
    const id = window.setInterval(() => {
      void load();
    }, 30_000);
    return () => window.clearInterval(id);
  }, [load]);

  async function markAllRead() {
    await apiFetch("/api/dataset/notifications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "mark_all_read" }),
    });
    await load();
  }

  async function openNotification(item: AppNotification) {
    await apiFetch("/api/dataset/notifications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "mark_read", id: item.id }),
    });
    await load();
    if (item.href) router.push(item.href);
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            aria-label="Notifications"
            className="relative"
          />
        }
      >
        <Bell className="size-4" />
        {unreadCount > 0 ? (
          <motion.span
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            className="absolute top-1.5 right-1.5 flex size-4 items-center justify-center rounded-full bg-ara-highlight text-[10px] font-semibold text-white"
          >
            {unreadCount > 9 ? "9+" : unreadCount}
          </motion.span>
        ) : null}
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-80">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="flex items-center justify-between gap-2">
            <span>Notifications</span>
            {unreadCount > 0 ? (
              <button
                type="button"
                className="text-[11px] font-medium text-primary hover:underline"
                onClick={(event) => {
                  event.preventDefault();
                  void markAllRead();
                }}
              >
                Mark all read
              </button>
            ) : null}
          </DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        {notifications.length === 0 ? (
          <DropdownMenuItem disabled className="justify-center text-xs">
            No notifications yet
          </DropdownMenuItem>
        ) : (
          notifications.slice(0, 8).map((item) => (
            <DropdownMenuItem
              key={item.id}
              className="flex cursor-pointer flex-col items-start gap-0.5 py-2.5"
              onClick={() => {
                void openNotification(item);
              }}
            >
              <span className="flex w-full items-center justify-between gap-2">
                <span className="text-sm font-medium text-foreground">
                  {item.title}
                </span>
                {!item.read ? (
                  <span className="size-1.5 shrink-0 rounded-full bg-ara-highlight" />
                ) : null}
              </span>
              <span className="text-xs text-muted-foreground">{item.body}</span>
              <span className="text-[10px] text-muted-foreground/80">
                {new Date(item.createdAt).toLocaleString("en-IN")}
              </span>
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
