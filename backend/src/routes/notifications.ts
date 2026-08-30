import { Router } from "express";
import { requireAccess } from "../middleware/auth.js";
import {
  getNotificationsPayload,
  markAllNotificationsRead,
  markNotificationRead,
} from "../services/notifications.js";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * GET/POST /api/dataset/notifications
 * Matches Next.js src/app/api/dataset/notifications/route.ts (postgres mode).
 * POST is authenticated (viewer + operator) — not operator-only.
 */
export function createNotificationsRouter(): Router {
  const router = Router();

  router.get(
    "/api/dataset/notifications",
    requireAccess("authenticated"),
    async (_req, res) => {
      try {
        const payload = await getNotificationsPayload();
        res.status(200).set(NO_STORE).json(payload);
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Failed to load notifications";
        res.status(500).json({ error: message });
      }
    }
  );

  router.post(
    "/api/dataset/notifications",
    requireAccess("authenticated"),
    async (req, res) => {
      try {
        const body = (req.body ?? {}) as {
          action?: string;
          id?: string;
        };

        if (body.action === "mark_all_read") {
          await markAllNotificationsRead();
        } else if (body.action === "mark_read" && body.id) {
          await markNotificationRead(body.id);
        } else {
          res.status(400).json({ error: "Unknown action." });
          return;
        }

        const payload = await getNotificationsPayload();
        res.status(200).json(payload);
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Failed to update notifications";
        res.status(500).json({ error: message });
      }
    }
  );

  return router;
}
