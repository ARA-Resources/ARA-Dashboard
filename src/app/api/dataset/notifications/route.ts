import { NextResponse } from "next/server";
import {
  countUnreadNotifications,
  listAppNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from "@/services/dataset/notifications-store";

export const runtime = "nodejs";

export async function GET() {
  const [notifications, unreadCount] = await Promise.all([
    listAppNotifications(30),
    countUnreadNotifications(),
  ]);
  return NextResponse.json(
    { notifications, unreadCount },
    { headers: { "Cache-Control": "no-store" } }
  );
}

export async function POST(request: Request) {
  let body: { action?: string; id?: string } = {};
  try {
    body = (await request.json()) as { action?: string; id?: string };
  } catch {
    body = {};
  }

  if (body.action === "mark_all_read") {
    await markAllNotificationsRead();
  } else if (body.action === "mark_read" && body.id) {
    await markNotificationRead(body.id);
  } else {
    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  }

  const [notifications, unreadCount] = await Promise.all([
    listAppNotifications(30),
    countUnreadNotifications(),
  ]);
  return NextResponse.json({ notifications, unreadCount });
}
